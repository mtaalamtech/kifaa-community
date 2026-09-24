"""
Sophos Central API client (OAuth2 client credentials).
Auth: POST https://id.sophos.com/api/v2/oauth2/token
Tenant discovery: GET https://api.central.sophos.com/whoami
Data: per-tenant regional API URL
"""
import logging
import httpx

logger = logging.getLogger(__name__)

TOKEN_URL = "https://id.sophos.com/api/v2/oauth2/token"
WHOAMI_URL = "https://api.central.sophos.com/whoami/v1"


class SophosClient:
    def __init__(self, client_id: str, client_secret: str):
        self.client_id = (client_id or "").strip()
        self.client_secret = (client_secret or "").strip()
        self.access_token = None
        self.tenant_id = None
        self.api_host = None          # regional data host
        self.global_host = "https://api.central.sophos.com"  # global API host
        self._session = httpx.Client(timeout=30)

    def _auth_headers(self):
        return {
            "Authorization": f"Bearer {self.access_token}",
            "X-Tenant-ID": self.tenant_id or "",
        }

    def authenticate(self):
        resp = self._session.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "scope": "token",
            },
        )
        if not resp.is_success:
            raise RuntimeError(f"Sophos auth failed {resp.status_code}: {resp.text[:500]}")
        data = resp.json()
        self.access_token = data["access_token"]

    def discover_tenant(self):
        resp = self._session.get(WHOAMI_URL, headers={
            "Authorization": f"Bearer {self.access_token}",
        })
        resp.raise_for_status()
        data = resp.json()
        hosts = data.get("apiHosts", {})
        self.tenant_id = data.get("id")
        self.api_host = hosts.get("dataRegion", "https://api-us01.central.sophos.com")
        self.global_host = hosts.get("global", "https://api.central.sophos.com")
        return data

    def test_connection(self):
        self.authenticate()
        info = self.discover_tenant()
        return {"tenant_id": self.tenant_id, "api_host": self.api_host,
                "name": info.get("name", ""), "type": info.get("idType", "")}

    def get_endpoints(self, page_size: int = 500):
        results = []
        page_from_key = None
        while True:
            params = {"pageSize": page_size, "view": "full"}
            if page_from_key:
                params["pageFromKey"] = page_from_key
            resp = self._session.get(
                f"{self.api_host}/endpoint/v1/endpoints",
                headers=self._auth_headers(),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("items", []))
            pages = data.get("pages", {})
            page_from_key = pages.get("nextKey")
            if not page_from_key:
                break
        return results

    def get_alerts(self, page_size: int = 100):
        results = []
        page_from_key = None
        while True:
            params = {"pageSize": page_size}
            if page_from_key:
                params["pageFromKey"] = page_from_key
            resp = self._session.get(
                f"{self.api_host}/common/v1/alerts",
                headers=self._auth_headers(),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("items", []))
            pages = data.get("pages", {})
            page_from_key = pages.get("nextKey")
            if not page_from_key:
                break
        return results

    def get_licenses(self):
        """Fetch license/subscription details from Sophos Central licensing API.
        Tries global host first (licenses live at global, not regional data host)."""
        for base in (self.global_host, self.api_host):
            resp = self._session.get(
                f"{base}/licensing/v1/licenses",
                headers=self._auth_headers(),
            )
            if resp.is_success:
                data = resp.json()
                return data.get("licenses", data.get("items", []))
            logger.debug(f"Sophos licenses {base} → {resp.status_code}")
        # Fallback: try account-health-check for at least license validity
        resp = self._session.get(
            f"{self.global_host}/account-health-check/v1/checks/license",
            headers=self._auth_headers(),
        )
        if resp.is_success:
            data = resp.json()
            checks = data.get("checks", {})
            # Shape it into a license-like list
            return [{
                "id": "license-health",
                "productName": "Sophos Central License",
                "licenseType": "subscription",
                "startsAt": None,
                "expiresAt": None,
                "quantity": 0,
                "usedQuantity": 0,
                "_health": checks,
            }]
        logger.warning(f"Sophos license info unavailable: {resp.status_code}: {resp.text[:200]}")
        return []

    def close(self):
        self._session.close()
