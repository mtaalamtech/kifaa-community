"""
Nutanix Prism Element/Central REST API client (v2 + v3 APIs).
Auth: HTTP Basic (admin / password) — no token exchange needed.
Prism Element: https://host:9440/api/nutanix/v2.0/
Prism Central: https://host:9440/api/nutanix/v3/
"""
import json
import logging
import httpx

logger = logging.getLogger(__name__)


class NutanixClient:
    def __init__(self, host: str, username: str = "admin",
                 password: str = "", verify_ssl: bool = False, port: int = 9440):
        self.host = host.rstrip("/")
        self.port = port
        self.username = username
        self.password = password
        self.base_v2 = f"https://{self.host}:{port}/api/nutanix/v2.0"
        self.base_v3 = f"https://{self.host}:{port}/api/nutanix/v3"
        self._session = httpx.Client(
            verify=verify_ssl,
            timeout=30,
            auth=(username, password),
            follow_redirects=True,
        )

    def test_connection(self):
        # Try Prism Central v3 first, fall back to Element v2
        for url in [f"{self.base_v3}/clusters/list", f"{self.base_v2}/clusters"]:
            try:
                resp = self._session.post(url, json={"kind": "cluster", "length": 1}) \
                    if "v3" in url else self._session.get(url)
                if resp.status_code < 400:
                    return {"connected": True, "api": "v3" if "v3" in url else "v2",
                            "host": self.host}
            except Exception:
                continue
        raise RuntimeError("Could not connect to Nutanix Prism — check host and credentials")

    # ── v3 (Prism Central) helpers ─────────────────────────────────────────────

    def _post_v3(self, path: str, payload: dict = None):
        try:
            resp = self._session.post(
                f"{self.base_v3}{path}",
                json=payload or {"kind": path.lstrip("/").split("/")[0][:-1], "length": 500},
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code < 400:
                return resp.json()
        except Exception as e:
            logger.warning(f"Nutanix v3 {path} error: {e}")
        return None

    def _get_v2(self, path: str, params: dict = None):
        try:
            resp = self._session.get(f"{self.base_v2}{path}", params=params)
            if resp.status_code < 400:
                return resp.json()
        except Exception as e:
            logger.warning(f"Nutanix v2 {path} error: {e}")
        return None

    # ── Data methods ───────────────────────────────────────────────────────────

    def get_clusters(self):
        data = self._post_v3("/clusters/list", {"kind": "cluster", "length": 100})
        if data:
            return data.get("entities", [])
        # Fall back to v2
        v2 = self._get_v2("/clusters")
        return v2.get("entities", []) if v2 else []

    def get_vms(self):
        data = self._post_v3("/vms/list", {"kind": "vm", "length": 500})
        if data:
            return data.get("entities", [])
        v2 = self._get_v2("/vms")
        return v2.get("entities", []) if v2 else []

    def get_hosts(self):
        data = self._post_v3("/hosts/list", {"kind": "host", "length": 200})
        if data:
            return data.get("entities", [])
        v2 = self._get_v2("/hosts")
        return v2.get("entities", []) if v2 else []

    def get_storage_containers(self):
        return self._get_v2("/storage_containers") or {}

    def get_alerts(self):
        v2 = self._get_v2("/alerts", {"resolved": "false"})
        return v2.get("entities", []) if v2 else []

    def close(self):
        self._session.close()
