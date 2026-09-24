"""
CVE matching service using OSV.dev API.

Workflow:
  1. After each software inventory upload, call match_agent_cves(agent_id, db)
  2. This queries OSV.dev for each software package and stores findings in agent_vulnerabilities
  3. CVE metadata is cached in cve_database (upserted, never deleted)
  4. Existing vulns that no longer match are marked 'remediated'

OSV.dev batch query API:
  POST https://api.osv.dev/v1/querybatch
  Body: {"queries": [{"package": {"name": "...", "ecosystem": "..."}, "version": "..."}]}

Ecosystem mapping strategy (pragmatic, not perfect):
  - Linux dpkg packages → "Debian"
  - Linux rpm packages  → "Red Hat"
  - Python packages     → "PyPI"
  - npm packages        → "npm"
  - Windows software    → skip (OSV doesn't cover most Windows EXE software)

  Special cases: openssl, curl, git → query multiple ecosystems.
"""

import asyncio
import logging
import random
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

OSV_API = "https://api.osv.dev/v1"
OSV_BATCH_SIZE = 100   # OSV.dev allows up to 1000; keep lower to avoid timeouts
OSV_TIMEOUT = 30        # seconds per batch request

_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS cve_database (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cve_id TEXT UNIQUE NOT NULL,
    osv_id TEXT,
    description TEXT,
    severity TEXT,
    cvss_score NUMERIC(4,1),
    affected_products JSONB DEFAULT '[]',
    published_date TIMESTAMPTZ,
    modified_date TIMESTAMPTZ,
    references JSONB DEFAULT '[]',
    is_zero_day BOOLEAN DEFAULT FALSE,
    remediation TEXT,
    fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_vulnerabilities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    cve_id TEXT NOT NULL,
    software_name TEXT NOT NULL,
    software_version TEXT,
    severity TEXT,
    cvss_score NUMERIC(4,1),
    status TEXT DEFAULT 'open',
    detected_at TIMESTAMPTZ DEFAULT NOW(),
    remediated_at TIMESTAMPTZ,
    remediation_notes TEXT,
    UNIQUE(agent_id, cve_id, software_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_vulns_agent ON agent_vulnerabilities(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_vulns_status ON agent_vulnerabilities(status);
CREATE INDEX IF NOT EXISTS idx_agent_vulns_cve ON agent_vulnerabilities(cve_id);
"""


async def ensure_cve_tables(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS cve_database (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            cve_id TEXT UNIQUE NOT NULL, osv_id TEXT, description TEXT,
            severity TEXT, cvss_score NUMERIC(4,1),
            affected_products JSONB DEFAULT '[]',
            published_date TIMESTAMPTZ, modified_date TIMESTAMPTZ,
            "references" JSONB DEFAULT '[]', is_zero_day BOOLEAN DEFAULT FALSE,
            remediation TEXT, fetched_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_vulnerabilities (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            cve_id TEXT NOT NULL, software_name TEXT NOT NULL,
            software_version TEXT, severity TEXT, cvss_score NUMERIC(4,1),
            status TEXT DEFAULT 'open', detected_at TIMESTAMPTZ DEFAULT NOW(),
            remediated_at TIMESTAMPTZ, remediation_notes TEXT,
            UNIQUE(agent_id, cve_id, software_name)
        )
    """))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_vulns_agent ON agent_vulnerabilities(agent_id)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_vulns_status ON agent_vulnerabilities(status)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_vulns_cve ON agent_vulnerabilities(cve_id)"))
    await db.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS agent_vulns_unique ON agent_vulnerabilities(agent_id, cve_id, software_name)"))
    # Patch stub tables missing columns
    for tbl, col, defn in [
        ("agent_vulnerabilities", "software_version", "TEXT"),
        ("agent_vulnerabilities", "cvss_score", "NUMERIC(4,1)"),
        ("agent_vulnerabilities", "detected_at", "TIMESTAMPTZ DEFAULT NOW()"),
        ("agent_vulnerabilities", "remediated_at", "TIMESTAMPTZ"),
        ("agent_vulnerabilities", "remediation_notes", "TEXT"),
    ]:
        try:
            await db.execute(text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS {col} {defn}"))
        except Exception:
            await db.rollback()
    await db.commit()


# ── Ecosystem detection ────────────────────────────────────────────────────────

# Packages that appear in multiple ecosystems — query all relevant ones
_CROSS_ECOSYSTEM = {
    "openssl": ["Debian", "Alpine", "Red Hat"],
    "openssh": ["Debian", "Alpine", "Red Hat"],
    "curl": ["Debian", "Alpine", "Red Hat"],
    "git": ["Debian", "Alpine", "Red Hat"],
    "bash": ["Debian", "Alpine", "Red Hat"],
    "glibc": ["Debian", "Alpine", "Red Hat"],
    "vim": ["Debian", "Alpine", "Red Hat"],
    "sudo": ["Debian", "Alpine", "Red Hat"],
}

# Common Python package name patterns
_PYTHON_NAME_RE = re.compile(
    r"(?i)^(python[-_]|django|flask|requests|sqlalchemy|numpy|pandas|"
    r"cryptography|paramiko|pyyaml|jinja2|pillow|boto|celery|gunicorn|uvicorn|"
    r"fastapi|pydantic|aiohttp|httpx|werkzeug|lxml|pygments|setuptools|pip|"
    r"wheel|packaging|six|urllib3|certifi|charset.normalizer)"
)

# Common npm package name patterns
_NPM_NAME_RE = re.compile(
    r"(?i)^(node[-_]|npm[-_]|react|vue|angular|express|lodash|webpack|babel|"
    r"axios|jquery|moment|chalk|eslint|typescript|next|nuxt|gatsby|"
    r"electron|socket\.io|mocha|jest|prettier)"
)


def _detect_ecosystems(name: str, os_type: str) -> list[tuple[str, str]]:
    """
    Returns list of (ecosystem, package_name) to query for a given software name + OS type.
    """
    name_lower = name.lower().strip()

    # Python packages (cross-platform)
    if _PYTHON_NAME_RE.match(name_lower):
        # Normalize: remove leading "python-" prefix used in Debian
        pkg = re.sub(r"^python[-_]", "", name_lower)
        return [("PyPI", pkg)]

    # npm packages
    if _NPM_NAME_RE.match(name_lower):
        return [("npm", name_lower)]

    # Cross-ecosystem packages
    for key, ecosystems in _CROSS_ECOSYSTEM.items():
        if key in name_lower:
            return [(eco, key) for eco in ecosystems]

    # OS-specific
    if os_type == "linux":
        return [("Debian", name_lower), ("Alpine", name_lower)]
    if os_type == "windows":
        # OSV doesn't cover most Windows EXE software well — skip unless it's a known package type
        return []

    return []


# ── OSV.dev batch query ────────────────────────────────────────────────────────

async def _query_osv_batch(queries: list[dict]) -> list[dict]:
    """Query OSV.dev /querybatch endpoint. Returns list of results (one per query)."""
    if not queries:
        return []

    try:
        async with httpx.AsyncClient(timeout=OSV_TIMEOUT) as client:
            resp = await client.post(
                f"{OSV_API}/querybatch",
                json={"queries": queries},
            )
            if resp.status_code != 200:
                logger.warning("OSV.dev batch returned HTTP %d", resp.status_code)
                return []
            data = resp.json()
            return data.get("results", [])
    except Exception as e:
        logger.warning("OSV.dev query failed: %s", e)
        return []


def _extract_severity(osv_vuln: dict) -> tuple[str, Optional[float]]:
    """Extract severity label and CVSS score from an OSV vulnerability object."""
    severity = "medium"
    cvss_score = None

    # CVSS v3 scores
    for sev in osv_vuln.get("severity", []):
        score_str = sev.get("score", "")
        if sev.get("type") in ("CVSS_V3", "CVSS_V2"):
            try:
                # CVSS vector strings like "CVSS:3.1/AV:N/AC:L/..." — extract base score
                # OSV may provide just the score as a string like "7.5" or the full vector
                if "/" in score_str:
                    # Try to parse base score from vector — look for /BM: pattern
                    pass
                else:
                    cvss_score = float(score_str)
            except (ValueError, TypeError):
                pass

    # database_specific sometimes has CVSS scores
    db_specific = osv_vuln.get("database_specific", {})
    if cvss_score is None:
        for key in ("cvss", "cvss_score", "base_score", "nvd_published_at"):
            val = db_specific.get(key)
            if val and isinstance(val, (int, float)):
                cvss_score = float(val)
                break

    # Determine severity from CVSS score
    if cvss_score is not None:
        if cvss_score >= 9.0:
            severity = "critical"
        elif cvss_score >= 7.0:
            severity = "high"
        elif cvss_score >= 4.0:
            severity = "medium"
        else:
            severity = "low"
    elif db_specific.get("severity"):
        severity = db_specific["severity"].lower()

    return severity, cvss_score


def _is_zero_day(osv_vuln: dict, severity: str) -> bool:
    """Mark as zero-day if published within 30 days, is critical/high, and lacks a fix."""
    pub_str = osv_vuln.get("published", "")
    if not pub_str:
        return False
    try:
        pub_date = datetime.fromisoformat(pub_str.replace("Z", "+00:00"))
        days_old = (datetime.now(timezone.utc) - pub_date).days
        if days_old > 30:
            return False
    except (ValueError, TypeError):
        return False

    if severity not in ("critical", "high"):
        return False

    # Check if any fix exists (affected[].ranges[].events has 'fixed' key)
    for affected in osv_vuln.get("affected", []):
        for rng in affected.get("ranges", []):
            for event in rng.get("events", []):
                if "fixed" in event:
                    return False  # fix available → not zero-day

    return True


def _get_cve_id(osv_vuln: dict) -> str:
    """Extract the primary CVE ID (or OSV ID) from a vulnerability."""
    for alias in osv_vuln.get("aliases", []):
        if alias.startswith("CVE-"):
            return alias
    return osv_vuln.get("id", "")


async def _upsert_cve(db: AsyncSession, osv_vuln: dict, severity: str, cvss_score: Optional[float], is_zd: bool):
    """Insert or update a CVE in cve_database."""
    cve_id = _get_cve_id(osv_vuln)
    if not cve_id:
        return

    description = osv_vuln.get("details") or osv_vuln.get("summary") or ""

    def _parse_dt(s):
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None

    published = _parse_dt(osv_vuln.get("published"))
    modified = _parse_dt(osv_vuln.get("modified"))

    refs = [{"url": r.get("url", ""), "source": r.get("type", "")}
            for r in osv_vuln.get("references", [])]

    import json
    # Only update cve_database if the entry is missing or older than 24h —
    # this avoids row-lock contention when multiple agents match the same CVE concurrently.
    await db.execute(text("""
        INSERT INTO cve_database (cve_id, osv_id, description, severity, cvss_score,
            affected_products, published_date, modified_date, "references", is_zero_day, fetched_at)
        VALUES (:cve_id, :osv_id, :desc, :sev, :cvss,
            CAST(:affected AS jsonb), :pub, :mod, CAST(:refs AS jsonb), :zd, NOW())
        ON CONFLICT (cve_id) DO UPDATE SET
            description = EXCLUDED.description,
            severity = EXCLUDED.severity,
            cvss_score = EXCLUDED.cvss_score,
            affected_products = EXCLUDED.affected_products,
            modified_date = EXCLUDED.modified_date,
            "references" = EXCLUDED."references",
            is_zero_day = EXCLUDED.is_zero_day,
            fetched_at = NOW()
        WHERE cve_database.fetched_at < NOW() - INTERVAL '24 hours'
    """), {
        "cve_id": cve_id,
        "osv_id": osv_vuln.get("id", ""),
        "desc": description[:5000],
        "sev": severity,
        "cvss": cvss_score,
        "affected": json.dumps(osv_vuln.get("affected", [])),
        "pub": published,
        "mod": modified,
        "refs": json.dumps(refs[:20]),
        "zd": is_zd,
    })


# ── Main matching function ─────────────────────────────────────────────────────

async def match_agent_cves(agent_id: str, db: AsyncSession, _retry: int = 0):
    """
    Match an agent's software inventory against CVEs via OSV.dev.
    Called after each inventory upload (fire-and-forget via asyncio.create_task).
    Retries up to 3 times on deadlock with random backoff.
    """
    try:
        await ensure_cve_tables(db)

        # Get agent OS type
        agent_result = await db.execute(text(
            "SELECT os_type FROM agents WHERE id = CAST(:id AS uuid)"
        ), {"id": agent_id})
        agent_row = agent_result.fetchone()
        if not agent_row:
            return
        os_type = (agent_row[0] or "").lower()

        # Get software inventory
        sw_result = await db.execute(text(
            "SELECT name, version FROM software_inventory WHERE agent_id = CAST(:id AS uuid)"
        ), {"id": agent_id})
        software = sw_result.fetchall()

        if not software:
            return

        logger.info("CVE matching: %d packages for agent %s (%s)", len(software), agent_id, os_type)

        # Build OSV batch queries
        # Map: (ecosystem, pkg_name, version) → (sw_name, sw_version)
        query_map: list[tuple[dict, str, str]] = []  # (osv_query, original_name, version)

        for sw_name, sw_version in software:
            if not sw_name:
                continue
            ecosystems = _detect_ecosystems(sw_name, os_type)
            for ecosystem, pkg_name in ecosystems:
                q = {"package": {"name": pkg_name, "ecosystem": ecosystem}}
                if sw_version:
                    q["version"] = sw_version
                query_map.append((q, sw_name, sw_version or ""))

        if not query_map:
            logger.info("CVE matching: no queryable packages for agent %s", agent_id)
            return

        # Batch into chunks
        new_cve_ids: set[str] = set()

        for chunk_start in range(0, len(query_map), OSV_BATCH_SIZE):
            chunk = query_map[chunk_start:chunk_start + OSV_BATCH_SIZE]
            queries = [item[0] for item in chunk]

            results = await _query_osv_batch(queries)

            for i, result in enumerate(results):
                vulns = result.get("vulns", [])
                if not vulns:
                    continue

                _, orig_sw_name, orig_version = chunk[i]

                for vuln in vulns:
                    cve_id = _get_cve_id(vuln)
                    if not cve_id:
                        continue

                    severity, cvss_score = _extract_severity(vuln)
                    is_zd = _is_zero_day(vuln, severity)

                    await _upsert_cve(db, vuln, severity, cvss_score, is_zd)

                    # Upsert agent vulnerability
                    await db.execute(text("""
                        INSERT INTO agent_vulnerabilities
                            (agent_id, cve_id, software_name, software_version, severity, cvss_score, status)
                        VALUES (CAST(:agent_id AS uuid), :cve_id, :name, :version, :sev, :cvss, 'open')
                        ON CONFLICT (agent_id, cve_id, software_name) DO UPDATE SET
                            software_version = EXCLUDED.software_version,
                            severity = EXCLUDED.severity,
                            cvss_score = EXCLUDED.cvss_score,
                            status = CASE WHEN agent_vulnerabilities.status = 'remediated'
                                         THEN 'open'
                                         ELSE agent_vulnerabilities.status END
                    """), {
                        "agent_id": agent_id,
                        "cve_id": cve_id,
                        "name": orig_sw_name,
                        "version": orig_version,
                        "sev": severity,
                        "cvss": cvss_score,
                    })
                    new_cve_ids.add(f"{agent_id}:{cve_id}:{orig_sw_name}")

        await db.commit()
        logger.info("CVE matching complete for agent %s — %d vuln entries", agent_id, len(new_cve_ids))

    except Exception as e:
        try:
            await db.rollback()
        except Exception:
            pass
        # Retry on deadlock with random jitter (up to 3 attempts)
        if "deadlock" in str(e).lower() and _retry < 3:
            wait = 0.5 + random.random() * 1.5 * (_retry + 1)
            logger.warning("CVE match deadlock for agent %s (attempt %d) — retrying in %.1fs", agent_id, _retry + 1, wait)
            await asyncio.sleep(wait)
            await match_agent_cves(agent_id, db, _retry + 1)
        else:
            logger.error("CVE match error for agent %s: %s", agent_id, e, exc_info=True)
