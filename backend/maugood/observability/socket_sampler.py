"""Per-camera RTSP byte counter via ``ss -tnpi`` parsing.

The Linux kernel exposes ``tcpi_bytes_received`` per TCP socket via
the ``SOCK_DIAG`` netlink protocol. The userland tool ``ss`` (from
iproute2) is the canonical reader; ``ss -tnpi`` prints one ESTAB
line per established TCP socket and, on the immediately-following
indented line, a space-separated metric stream that includes
``bytes_received:NNN`` and ``bytes_acked:NNN``.

We sample on a fixed cadence (driven by the CaptureManager's
reconcile scheduler), parse the output, and update each
``CaptureWorker``'s rolling ``bytes_received_60s`` deque. The
backend uvicorn process is the only owner of the RTSP TCP sockets,
so we filter to connections established by our own pid — that
matches the ss columns ``users:(("python",pid=N,fd=M))``.

Graceful-degrade contract: any exception (binary missing, parse
failure, permission denied) is swallowed at WARN and the workers
keep their current ``None`` byte counters. The Resources tab UI
hides the column when ``bytes_received_60s`` is None for every
camera, so the operator sees no broken cells.

Limitations:

* UDP RTSP transport bypasses TCP_INFO entirely; UDP-only streams
  won't surface bytes here. The default OpenCV/FFmpeg RTSP transport
  is TCP, so this covers the common case.
* ``ss`` requires root or CAP_NET_ADMIN to see other processes'
  sockets. The backend container runs as root by default; if a
  deployment locks the container down further, the counters silently
  go to None.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


# One regex to extract bytes_received from the metrics line. ss outputs
# either ``bytes_received:NNN`` or ``bytes_received NNN`` depending on
# version — we accept both.
_BYTES_RECEIVED_RE = re.compile(r"bytes_received[:\s](\d+)")

# Header-line capture: ESTAB lines have the form
#   ESTAB 0 0 src:port dst:port users:(("python",pid=NN,fd=MM))
# We only need dst:port and pid for matching.
_HEADER_RE = re.compile(
    r"^ESTAB\s+\d+\s+\d+\s+\S+\s+(?P<dst>\S+)\s+.*?pid=(?P<pid>\d+)",
)


def _ss_available() -> bool:
    """Return True if the ``ss`` binary is on PATH."""

    return shutil.which("ss") is not None


def _run_ss() -> Optional[str]:
    """Run ``ss -tnpi`` and return its stdout, or None on any failure.

    Bounded by a 2-second wall clock — if the system is so stressed
    that ``ss`` takes longer than that, the operator has bigger
    problems and we don't want to delay the reconcile tick.
    """

    if not _ss_available():
        return None
    try:
        result = subprocess.run(  # noqa: S603, S607
            ["ss", "-tnpi"],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.debug("observability.socket_sampler: ss failed: %s", exc)
        return None
    if result.returncode != 0:
        logger.debug(
            "observability.socket_sampler: ss rc=%s stderr=%s",
            result.returncode,
            result.stderr.strip()[:200],
        )
        return None
    return result.stdout


def parse_ss_output(text: str, *, pid_filter: Optional[int]) -> dict[str, int]:
    """Parse ``ss -tnpi`` text into a ``{dst_addr_port: bytes_received}``
    dict. ``dst_addr_port`` is the ``host:port`` string as ss prints it
    (IPv4 dotted quad or ``[ipv6]`` brackets, port is the RTSP one —
    554 for ``rtsp://``, 322 for ``rtsps://`` typically, but operators
    sometimes use non-default ports).

    ``pid_filter`` keeps only sockets owned by that PID (the backend
    process). When None, every line is kept — useful for tests.

    Public for unit-testing the parser in isolation.
    """

    out: dict[str, int] = {}
    current_dst: Optional[str] = None
    current_keep = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            current_dst = None
            current_keep = False
            continue

        header_match = _HEADER_RE.match(line)
        if header_match is not None:
            current_dst = header_match.group("dst")
            pid_str = header_match.group("pid")
            try:
                pid = int(pid_str)
            except ValueError:
                pid = -1
            current_keep = pid_filter is None or pid == pid_filter
            continue

        if not current_keep or current_dst is None:
            continue

        # Metric continuation line (always indented by ss).
        if not line.startswith((" ", "\t")):
            current_dst = None
            current_keep = False
            continue

        m = _BYTES_RECEIVED_RE.search(line)
        if m is None:
            continue
        try:
            bytes_v = int(m.group(1))
        except ValueError:
            continue
        # If the same dst appears multiple times (multiple sockets to
        # the same camera; uncommon) we sum.
        out[current_dst] = out.get(current_dst, 0) + bytes_v

    return out


def rtsp_endpoint(plain_url: str) -> Optional[tuple[str, int]]:
    """Pull ``(host, port)`` from a decrypted RTSP URL. Default port
    554 when omitted. Returns None if the URL doesn't parse.
    """

    try:
        u = urlparse(plain_url)
    except Exception:  # noqa: BLE001
        return None
    host = u.hostname
    if not host:
        return None
    port = u.port if u.port else (322 if u.scheme == "rtsps" else 554)
    return host, int(port)


def lookup_socket_bytes(
    endpoints: dict[tuple[int, int], tuple[str, int]],
) -> dict[tuple[int, int], Optional[int]]:
    """Run one ``ss -tnpi`` pass and map each ``(tenant_id, camera_id)``
    to its cumulative bytes_received (None when no matching socket).

    Returns ``None`` for every key on any sampler failure (degrade-to-
    None contract). Caller stores the value; the per-worker delta
    computation lives elsewhere.
    """

    if not endpoints:
        return {}

    text = _run_ss()
    if text is None:
        return {k: None for k in endpoints}

    pid = os.getpid()
    parsed = parse_ss_output(text, pid_filter=pid)
    if not parsed:
        # No matching sockets — every camera reports 0 (we found the
        # process but it has no RTSP sockets right now). Distinguishable
        # from "ss missing" by being 0 rather than None.
        return {k: 0 for k in endpoints}

    # Match (host, port) → dst string. ss prints IPv4 as ``host:port``
    # and IPv6 as ``[host]:port``. We do a substring-suffix match on
    # ``:port`` first, then verify the host portion to handle both.
    out: dict[tuple[int, int], Optional[int]] = {}
    for key, (host, port) in endpoints.items():
        match_total = 0
        suffix = f":{port}"
        for dst, bv in parsed.items():
            if not dst.endswith(suffix):
                continue
            # Strip the suffix and any IPv6 brackets to compare hosts.
            dst_host = dst[: -len(suffix)].strip("[]")
            if dst_host == host:
                match_total += bv
        out[key] = match_total if match_total > 0 else 0
    return out


# ---------------------------------------------------------------------------
# Tick driver — wired in maugood/capture/manager.py's reconcile loop
# ---------------------------------------------------------------------------


_last_sample_per_key: dict[tuple[int, int], tuple[float, int]] = {}


def sample_and_update(
    endpoints: dict[tuple[int, int], tuple[str, int]],
    *,
    update_fn,  # type: ignore[no-untyped-def]  # callable[(key, delta_bytes_per_60s), None]
) -> None:
    """One full sample → delta → push into each worker.

    The function is intentionally side-effecty (it calls back into the
    worker via ``update_fn``) because the worker owns the rolling
    60s window — we just feed it deltas.

    ``update_fn(key, value_or_none)`` is called once per key. ``value``
    is the *cumulative* bytes_received for the socket; the worker
    converts to a per-minute throughput via its own window.
    """

    if not endpoints:
        return
    sampled = lookup_socket_bytes(endpoints)
    now = time.time()
    for key, cumulative in sampled.items():
        if cumulative is None:
            update_fn(key, None, now)
            continue
        update_fn(key, int(cumulative), now)


def reset_cache() -> None:
    """Test hook — clears the prev-sample state so a fresh test run
    doesn't see deltas from a previous one."""

    _last_sample_per_key.clear()
