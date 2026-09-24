"""
Proxmox VE REST API client.
Supports both password auth (POST /api2/json/access/ticket) and
API token auth (Authorization: PVEAPIToken=user@realm!tokenid=secret).
"""
import logging
import httpx

logger = logging.getLogger(__name__)


class ProxmoxClient:
    def __init__(self, host: str, username: str = "root@pam",
                 password: str = "", token_id: str = "", token_secret: str = "",
                 verify_ssl: bool = False):
        self.host = host.rstrip("/")
        self.base = f"https://{self.host}:8006/api2/json"
        # Proxmox requires user@realm format — default realm is 'pam'
        self.username = username if "@" in username else f"{username}@pam"
        self.password = password
        self.token_id = token_id         # e.g. "mytoken"
        self.token_secret = token_secret # the UUID secret
        self._ticket = None
        self._csrf = None
        self._session = httpx.Client(verify=verify_ssl, timeout=30,
                                     follow_redirects=True)

    def _headers(self):
        if self.token_id and self.token_secret:
            return {
                "Authorization": f"PVEAPIToken={self.username}!{self.token_id}={self.token_secret}"
            }
        if self._ticket:
            return {
                "Cookie": f"PVEAuthCookie={self._ticket}",
                "CSRFPreventionToken": self._csrf or "",
            }
        return {}

    def login(self):
        """Authenticate via password if no token is set."""
        if self.token_id and self.token_secret:
            return  # Token auth — no login needed
        resp = self._session.post(
            f"{self.base}/access/ticket",
            data={"username": self.username, "password": self.password},
        )
        resp.raise_for_status()
        data = resp.json().get("data", {})
        self._ticket = data.get("ticket")
        self._csrf = data.get("CSRFPreventionToken")
        if not self._ticket:
            raise RuntimeError("Proxmox auth failed — check credentials")

    def test_connection(self):
        self.login()
        resp = self._session.get(f"{self.base}/version", headers=self._headers())
        resp.raise_for_status()
        data = resp.json().get("data", {})
        return {"version": data.get("version"), "release": data.get("release"),
                "host": self.host}

    def _get(self, path: str, params: dict = None):
        resp = self._session.get(
            f"{self.base}{path}",
            headers=self._headers(),
            params=params,
        )
        if resp.status_code == 200:
            return resp.json().get("data", [])
        return None

    def get_nodes(self):
        return self._get("/nodes") or []

    def get_vms(self, node: str):
        """KVM virtual machines on a node."""
        return self._get(f"/nodes/{node}/qemu") or []

    def get_containers(self, node: str):
        """LXC containers on a node."""
        return self._get(f"/nodes/{node}/lxc") or []

    def get_storage(self, node: str):
        return self._get(f"/nodes/{node}/storage") or []

    def get_node_status(self, node: str):
        return self._get(f"/nodes/{node}/status") or {}

    def get_cluster_status(self):
        return self._get("/cluster/status") or []

    def get_cluster_resources(self):
        """All resources (vms, nodes, storage) in one call."""
        return self._get("/cluster/resources") or []

    def close(self):
        self._session.close()
