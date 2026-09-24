"""
Unitrends REST API client.
Authenticates via POST /api/login and uses the returned token
for subsequent requests.
"""
import logging
import httpx

logger = logging.getLogger(__name__)


class UnitrendsClient:
    def __init__(self, host: str, username: str = "root", password: str = "",
                 verify_ssl: bool = False):
        self.base = f"https://{host}"
        self.username = username
        self.password = password
        self.verify_ssl = verify_ssl
        self.token = None
        self._session = httpx.Client(verify=verify_ssl, timeout=30,
                                     follow_redirects=True)

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.token:
            h["AuthToken"] = self.token
        return h

    def login(self):
        """Authenticate and store session token.
        Note: Unitrends returns HTTP 500 for auth errors (non-standard), so we
        never call raise_for_status() and instead parse the JSON body.
        """
        url = f"{self.base}/api/login"
        resp = self._session.post(url, json={
            "username": self.username,
            "password": self.password,
        }, headers={"Content-Type": "application/json"})
        # Unitrends returns HTTP 500 for errors, parse JSON body ourselves
        try:
            data = resp.json()
        except Exception:
            # If we can't parse JSON, raise the HTTP error
            resp.raise_for_status()
            raise RuntimeError("No JSON response from Unitrends")

        # Check for error in result array (Unitrends convention: code "0" = error)
        results = data.get("result", [])
        if results:
            r = results[0]
            code = str(r.get("code", ""))
            msg = r.get("message", "")
            if code == "0" or (resp.status_code >= 400 and not self.token):
                raise RuntimeError(f"Unitrends auth error: {msg}")

        # Token may be in body or cookie or header
        self.token = (
            data.get("data", {}).get("token")
            or data.get("token")
            or resp.cookies.get("CGISESSID")
            or resp.cookies.get("auth_token")
            or resp.headers.get("AuthToken")
        )
        if not self.token:
            # Some versions return it as a top-level key
            for k, v in data.items():
                if "token" in k.lower() and isinstance(v, str):
                    self.token = v
                    break
        # If we have no token but got HTTP 200 range, try cookies
        if not self.token:
            for k, v in resp.cookies.items():
                self.token = v
                break
        return data

    def test_connection(self):
        """Login and return system info."""
        self.login()
        # Try fetching system/appliance info to confirm connection
        for endpoint in ["/api/system", "/api/appliance", "/api/status"]:
            try:
                resp = self._session.get(f"{self.base}{endpoint}",
                                         headers=self._headers())
                if resp.status_code < 400:
                    try:
                        body = resp.json()
                        return body.get("data", body)
                    except Exception:
                        pass
            except Exception:
                continue
        # Login succeeded even if system info is unavailable
        return {"connected": True, "host": self.base}

    def get_backups(self, days: int = 30):
        """Return raw backup response dict (caller parses BackupStatus key)."""
        try:
            resp = self._session.get(
                f"{self.base}/api/backups",
                params={"days": days},
                headers=self._headers(),
            )
            return resp.json() if resp.status_code < 400 else {}
        except Exception as e:
            logger.warning(f"Unitrends get_backups error: {e}")
            return {}

    def get_clients(self):
        """Return raw clients response dict (caller parses 'data' key)."""
        try:
            resp = self._session.get(
                f"{self.base}/api/clients",
                headers=self._headers(),
            )
            return resp.json() if resp.status_code < 400 else {}
        except Exception as e:
            logger.warning(f"Unitrends get_clients error: {e}")
            return {}

    def get_alerts(self):
        """Return raw alerts response dict (caller parses 'data' key)."""
        try:
            resp = self._session.get(
                f"{self.base}/api/alerts",
                headers=self._headers(),
            )
            return resp.json() if resp.status_code < 400 else {}
        except Exception as e:
            logger.warning(f"Unitrends get_alerts error: {e}")
            return {}

    def get_storage(self):
        """Return raw storage response dict (caller parses 'storage' key)."""
        try:
            resp = self._session.get(
                f"{self.base}/api/storage",
                headers=self._headers(),
            )
            return resp.json() if resp.status_code < 400 else {}
        except Exception as e:
            logger.warning(f"Unitrends get_storage error: {e}")
            return {}

    def get_jobs(self, days: int = 7):
        """Return recent jobs (alternative endpoint)."""
        try:
            resp = self._session.get(
                f"{self.base}/api/jobs",
                params={"days": days},
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", data) if isinstance(data, dict) else data
        except Exception as e:
            logger.warning(f"Unitrends get_jobs error: {e}")
            return []

    def close(self):
        self._session.close()
