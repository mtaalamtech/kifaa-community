"""
SAP Business One Service Layer client (B1S REST API).
Auth: POST /b1s/v1/Login → B1SESSION cookie
Data: EmployeesInfo (paginated), Users (direct PK lookup)
"""
import logging
import httpx

logger = logging.getLogger(__name__)

# License type inference from department name keywords
_FINANCIAL_KEYWORDS = ("account", "finance", "financial", "treasury", "payroll")
_LOGISTICS_KEYWORDS = ("logistics", "procurement", "purchasing", "warehouse", "inventory",
                       "supply", "store", "dispatch", "distribution", "delivery")

# Known department ID to license-type mapping (from SAP B1 department exploration)
# Dept 1=Accounts, 2=Procurement, 3=ICT, 4=Logistics, 5-11=branch offices,
# 33=Livestock, 34=unknown, -2=Head Office
_DEPT_FINANCIAL_IDS = {1}                        # Accounts only
_DEPT_LOGISTICS_IDS = {2, 4, 5, 6, 7, 8, 9, 10, 11}  # Procurement, Logistics, branches


def infer_license_type(dept_id: int, dept_name: str, is_superuser: bool) -> str:
    """Infer SAP license type from department info."""
    if is_superuser:
        return "professional"
    dept_name_lower = (dept_name or "").lower()
    if dept_id in _DEPT_FINANCIAL_IDS:
        return "financial"
    if dept_id in _DEPT_LOGISTICS_IDS:
        return "logistics"
    # Keyword fallback
    if any(kw in dept_name_lower for kw in _FINANCIAL_KEYWORDS):
        return "financial"
    if any(kw in dept_name_lower for kw in _LOGISTICS_KEYWORDS):
        return "logistics"
    return "professional"


class SAPClient:
    def __init__(self, host: str, username: str, password: str, company_db: str):
        self.host = (host or "").strip().rstrip("/")
        self.username = (username or "").strip()
        self.password = password or ""
        self.company_db = (company_db or "").strip()
        # Build base URL — default port 50000 for HTTP, 50001 HTTPS
        if not self.host.startswith("http"):
            self.host = f"http://{self.host}"
        self.base = f"{self.host}/b1s/v1"
        self._session = httpx.Client(timeout=30, verify=False)
        self._session_id = None

    def login(self):
        resp = self._session.post(f"{self.base}/Login", json={
            "UserName": self.username,
            "Password": self.password,
            "CompanyDB": self.company_db,
        })
        if not resp.is_success:
            raise RuntimeError(f"SAP B1 login failed {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        self._session_id = data.get("SessionId")
        # SAP sets multiple B1SESSION cookies at different paths — clear all and set once
        # SAP sets multiple B1SESSION cookies at different paths — clear all and set once
        self._session.cookies.clear()
        # Extract domain from host (strip protocol and port)
        import re as _re
        _domain = _re.sub(r'^https?://', '', self.host).split(':')[0]
        self._session.cookies.set("B1SESSION", self._session_id, domain=_domain)
        self._session.cookies.set("CompanyDB", self.company_db, domain=_domain)
        return data

    def test_connection(self):
        self.login()
        # Fetch company info
        try:
            resp = self._session.get(f"{self.base}/CompanyService_GetAdminInfo",
                                     headers={"Prefer": "return=representation"})
            info = resp.json() if resp.is_success else {}
        except Exception:
            info = {}
        return {
            "company_db": self.company_db,
            "session_id": self._session_id,
            "server_version": info.get("Version", ""),
            "company_name": info.get("CompanyName", self.company_db),
        }

    def get_departments(self) -> list:
        """Fetch all departments."""
        try:
            resp = self._session.get(f"{self.base}/Departments",
                                     params={"$select": "Code,Name"})
            if resp.is_success:
                return resp.json().get("value", [])
        except Exception as e:
            logger.warning(f"SAP get_departments failed: {e}")
        return []

    def get_employees(self, page_size: int = 20) -> list:
        """Fetch all EmployeesInfo records via $skip pagination."""
        results = []
        skip = 0
        while True:
            try:
                resp = self._session.get(f"{self.base}/EmployeesInfo", params={
                    "$select": ("EmployeeID,FirstName,LastName,eMail,Department,"
                                "JobTitle,Active,StartDate,TerminationDate,"
                                "MobilePhone,OfficePhone,ApplicationUserID"),
                    "$skip": skip,
                    "$top": page_size,
                })
                if not resp.is_success:
                    logger.warning(f"SAP employees page {skip}: {resp.status_code}")
                    break
                data = resp.json()
                items = data.get("value", [])
                if not items:
                    break
                results.extend(items)
                skip += page_size
                # No nextLink in B1S — stop when fewer items than page_size
                if len(items) < page_size:
                    break
            except Exception as e:
                logger.error(f"SAP employees fetch error at skip={skip}: {e}")
                break
        return results

    def get_user(self, internal_key: int) -> dict | None:
        """Fetch a single User by InternalKey (direct PK lookup — fast)."""
        try:
            resp = self._session.get(f"{self.base}/Users({internal_key})")
            if resp.is_success:
                return resp.json()
            if resp.status_code == 404:
                return None
            logger.warning(f"SAP user {internal_key}: {resp.status_code}")
        except Exception as e:
            logger.warning(f"SAP get_user({internal_key}) error: {e}")
        return None

    def logout(self):
        try:
            self._session.post(f"{self.base}/Logout")
        except Exception:
            pass

    def close(self):
        try:
            self.logout()
        except Exception:
            pass
        try:
            self._session.close()
        except Exception:
            pass
