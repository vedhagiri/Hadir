"""Apply inference thread caps early in the process lifetime.

Called from ``main.py`` lifespan before any model loads.  Four levers:

1. ``cv2.setNumThreads`` — caps OpenCV's internal thread pool.
2. ``torch.set_num_threads`` / ``set_num_interop_threads`` — caps
   PyTorch / Ultralytics YOLO.
3. onnxruntime ``InferenceSession`` shim — caps BOTH ``intra_op`` AND
   ``inter_op`` thread pools.  Without capping ``inter_op``, ORT defaults
   to ``num_cpu_cores`` threads per session.  With 24 cores and 2 models
   per camera × 4 cameras = 8 sessions × 24 threads = 192 idle futex
   sleepers.  The original patch only set ``intra_op``; this version also
   sets ``inter_op=1`` which eliminates the bulk of idle threads.
4. OpenBLAS / OMP / MKL env vars — set BEFORE any numpy/blas import so
   the BLAS library's own thread pool honours the cap.

Knob: ``MAUGOOD_INFERENCE_THREADS`` (default 2).  Set to 4 on boxes
with ≥16 cores and lighter camera loads.  2 is the safe default:
the serial ``_detect_lock`` means only one detection runs at a time
anyway; giving each detection 2 intra-op threads is usually faster
than 24 (cache thrash).

Why only env, no pydantic Settings? These caps must be applied
*before* onnxruntime is imported (the shim must wrap the constructor
before any session is created), which is before the Settings object
is fully wired.  Reading an env var directly is safe and correct here.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)

_applied = False
_lock = threading.Lock()


def inference_thread_count() -> int:
    try:
        return max(1, int(os.environ.get("MAUGOOD_INFERENCE_THREADS", "2")))
    except (ValueError, TypeError):
        return 2


def apply_inference_thread_caps() -> None:
    """Idempotent — safe to call from multiple init paths."""
    global _applied
    with _lock:
        if _applied:
            return
        _applied = True

    n = inference_thread_count()

    # 0 — BLAS / OpenMP env vars must be set BEFORE any numpy/blas import.
    # These control the thread pool size of OpenBLAS, MKL, and OpenMP libs
    # that underpin numpy matrix ops.  Each defaults to num_cpu_cores.
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(var, str(n))
    logger.info("thread caps: BLAS/OMP env vars set to %d", n)

    # 1 — OpenCV (all imencode / cap.read / resize calls process-wide)
    try:
        import cv2  # noqa: PLC0415
        cv2.setNumThreads(n)
        logger.info("thread caps: cv2.setNumThreads(%d)", n)
    except Exception as exc:  # noqa: BLE001
        logger.debug("thread caps: cv2 cap skipped: %s", exc)

    # 2 — PyTorch / YOLO (optional dep)
    try:
        import torch  # noqa: PLC0415
        torch.set_num_threads(n)
        torch.set_num_interop_threads(1)
        logger.info("thread caps: torch intra=%d interop=1", n)
    except Exception as exc:  # noqa: BLE001
        logger.debug("thread caps: torch cap skipped: %s", exc)

    # 3 — onnxruntime shim (must patch BEFORE any InferenceSession is created)
    _patch_ort(n)


def _patch_ort(n: int) -> None:
    """Monkey-patch ``onnxruntime.InferenceSession.__init__`` to inject
    BOTH ``intra_op_num_threads`` AND ``inter_op_num_threads`` into every
    session that doesn't supply its own ``sess_options``.

    Why inter_op matters: ORT defaults inter_op to num_cpu_cores (24 on
    this box).  Each InsightFace buffalo_l load creates ~2 ORT sessions
    (detection + recognition).  4 cameras × 2 sessions × 24 inter-op
    threads = 192 idle futex-blocked threads.  Setting inter_op=1
    eliminates this entire category of idle threads.

    InsightFace 0.7.3 ``model_zoo.get_model()`` only forwards
    ``providers`` / ``provider_options`` and silently drops any
    ``sess_options`` kwarg — so this shim is the only working lever.
    """
    try:
        import onnxruntime as ort  # noqa: PLC0415
        _orig = ort.InferenceSession.__init__

        def _patched(self: Any, model_path: Any, *args: Any, **kwargs: Any) -> None:
            if kwargs.get("sess_options") is None:
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = n
                opts.inter_op_num_threads = 1  # was missing — the main source of idle threads
                kwargs["sess_options"] = opts
            _orig(self, model_path, *args, **kwargs)

        ort.InferenceSession.__init__ = _patched  # type: ignore[method-assign]
        logger.info(
            "thread caps: ort.InferenceSession patched "
            "(intra_op=%d, inter_op=1)",
            n,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("thread caps: ort patch skipped: %s", exc)
