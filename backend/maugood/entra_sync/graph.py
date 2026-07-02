"""Microsoft Graph directory client (client-credentials).

Reuses the token pattern from ``maugood/emailing/providers.py`` — a
plain httpx REST client, no ``msal``. Requires the Entra app to have
the **application** Graph permissions ``User.Read.All`` +
``GroupMember.Read.All`` with admin consent.

A module-level test seam (``set_test_directory_client``) lets the test
suite inject a stub so the sync logic can be exercised without hitting
Graph. Production never sets it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_LOGIN = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
_GRAPH = "https://graph.microsoft.com/v1.0"
_USER_SELECT = "id,displayName,userPrincipalName,mail,jobTitle,department,accountEnabled"


class GraphError(RuntimeError):
    """A non-2xx from a Graph data call, carrying the HTTP status +
    Graph error code (e.g. ``Authorization_RequestDenied``) so callers
    can distinguish a 403 (missing app permission) from a real outage."""

    def __init__(self, status: int, code: str = "") -> None:
        self.status = status
        self.code = code
        super().__init__(f"graph error {status} ({code or 'unknown'})")


def _graph_error(resp: httpx.Response) -> GraphError:
    code = ""
    try:
        code = str(resp.json().get("error", {}).get("code", ""))
    except Exception:  # noqa: BLE001
        pass
    return GraphError(resp.status_code, code)


@dataclass(frozen=True, slots=True)
class GraphConfig:
    tenant_id: str
    client_id: str
    client_secret: str


@dataclass(frozen=True, slots=True)
class GraphUser:
    object_id: str
    display_name: str
    email: str
    upn: str
    job_title: str
    department: str
    account_enabled: bool
    group_ids: tuple[str, ...] = field(default=())


@dataclass(frozen=True, slots=True)
class GraphGroup:
    object_id: str
    display_name: str


class GraphDirectoryClient:
    """List directory users + their group memberships via Graph."""

    def __init__(self, config: GraphConfig) -> None:
        self._config = config

    def _token(self) -> str:
        cfg = self._config
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                _LOGIN.format(tenant=cfg.tenant_id),
                data={
                    "client_id": cfg.client_id,
                    "client_secret": cfg.client_secret,
                    "grant_type": "client_credentials",
                    "scope": "https://graph.microsoft.com/.default",
                },
            )
        if resp.status_code != 200:
            # Never dump the body — it can echo the client secret.
            oauth_error = ""
            try:
                oauth_error = str(resp.json().get("error", ""))
            except Exception:  # noqa: BLE001
                pass
            raise RuntimeError(
                f"graph token exchange failed: {resp.status_code} "
                f"({oauth_error or 'unknown'})"
            )
        return resp.json()["access_token"]

    def _get_all(self, url: str, headers: dict[str, str]) -> list[dict]:
        """Follow ``@odata.nextLink`` paging and return all `value` rows."""

        out: list[dict] = []
        next_url: Optional[str] = url
        with httpx.Client(timeout=30) as client:
            while next_url:
                resp = client.get(next_url, headers=headers)
                if resp.status_code != 200:
                    raise _graph_error(resp)
                body = resp.json()
                out.extend(body.get("value", []))
                next_url = body.get("@odata.nextLink")
        return out

    def list_users(self) -> list[GraphUser]:
        token = self._token()
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{_GRAPH}/users?$select={_USER_SELECT}&$top=999"
        rows = self._get_all(url, headers)
        return [_to_graph_user(r) for r in rows]

    def list_user_group_ids(self, object_id: str) -> tuple[str, ...]:
        token = self._token()
        headers = {"Authorization": f"Bearer {token}"}
        url = (
            f"{_GRAPH}/users/{object_id}/memberOf/microsoft.graph.group"
            f"?$select=id&$top=999"
        )
        rows = self._get_all(url, headers)
        return tuple(str(r["id"]) for r in rows if r.get("id"))

    def list_groups(self) -> list[GraphGroup]:
        token = self._token()
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{_GRAPH}/groups?$select=id,displayName&$top=999"
        rows = self._get_all(url, headers)
        return [
            GraphGroup(
                object_id=str(r["id"]),
                display_name=str(r.get("displayName") or ""),
            )
            for r in rows
            if r.get("id")
        ]


def _to_graph_user(r: dict) -> GraphUser:
    email = str(r.get("mail") or r.get("userPrincipalName") or "").strip()
    return GraphUser(
        object_id=str(r.get("id") or ""),
        display_name=str(r.get("displayName") or "").strip(),
        email=email,
        upn=str(r.get("userPrincipalName") or "").strip(),
        job_title=str(r.get("jobTitle") or "").strip(),
        department=str(r.get("department") or "").strip(),
        account_enabled=bool(r.get("accountEnabled", True)),
    )


# ---------------------------------------------------------------------------
# Test seam
# ---------------------------------------------------------------------------

_test_directory_client: Optional[Any] = None


def set_test_directory_client(client: Optional[Any]) -> None:
    """Install a stub with ``list_users`` / ``list_user_group_ids`` /
    ``list_groups`` (test-only). Production never calls this."""

    global _test_directory_client
    _test_directory_client = client


def build_directory_client(config: GraphConfig) -> Any:
    if _test_directory_client is not None:
        return _test_directory_client
    return GraphDirectoryClient(config)
