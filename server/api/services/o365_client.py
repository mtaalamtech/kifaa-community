"""
Microsoft Graph API client (Azure AD app registration, client credentials flow).
Fetches O365 users and license info.
"""
import logging
import httpx

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class O365Client:
    def __init__(self, tenant_id: str, client_id: str, client_secret: str):
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.access_token = None
        self._session = httpx.Client(timeout=30)

    def authenticate(self):
        url = f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token"
        resp = self._session.post(url, data={
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "scope": "https://graph.microsoft.com/.default",
        })
        resp.raise_for_status()
        self.access_token = resp.json()["access_token"]

    def _headers(self):
        return {"Authorization": f"Bearer {self.access_token}"}

    def test_connection(self):
        self.authenticate()
        resp = self._session.get(f"{GRAPH_BASE}/organization", headers=self._headers())
        resp.raise_for_status()
        orgs = resp.json().get("value", [])
        org = orgs[0] if orgs else {}
        return {"tenant_id": self.tenant_id, "org_name": org.get("displayName", ""),
                "verified_domains": [d["name"] for d in org.get("verifiedDomains", [])]}

    def get_users(self, page_size: int = 999):
        """Fetch all users with sign-in activity and license assignments."""
        users = []
        url = (
            f"{GRAPH_BASE}/users"
            f"?$select=id,displayName,mail,userPrincipalName,accountEnabled,"
            f"signInActivity,assignedLicenses"
            f"&$top={page_size}"
        )
        while url:
            resp = self._session.get(url, headers=self._headers())
            resp.raise_for_status()
            data = resp.json()
            users.extend(data.get("value", []))
            url = data.get("@odata.nextLink")
        return users

    def get_subscribed_skus(self):
        """Fetch license SKU consumption."""
        resp = self._session.get(f"{GRAPH_BASE}/subscribedSkus", headers=self._headers())
        resp.raise_for_status()
        return resp.json().get("value", [])

    def close(self):
        self._session.close()
