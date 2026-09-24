"""
Compliance router — unified compliance scoring across all modules.

Scoring formula (weighted average):
  Patch Compliance       35%  = agents with 0 critical pending / total agents × 100
  Vulnerability Mgmt     25%  = max(0, 100 - critical_open×20 - high_open×10)
  Configuration          20%  = passed_checks / total_applicable_checks × 100
  Endpoint Protection    10%  = agents with AV running AND firewall on / total × 100
  License Compliance     10%  = activated / total detected licenses × 100

Overall compliant threshold: >= 80
"""
from datetime import date, timedelta
import calendar
from typing import Optional
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/compliance", tags=["Compliance"])

async def _ensure_tables(db: AsyncSession):
    # compliance_snapshots
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS compliance_snapshots (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
            category TEXT NOT NULL,
            score NUMERIC(5,1),
            details JSONB DEFAULT '{}',
            UNIQUE(snapshot_date, category)
        )
    """))
    await db.execute(text("""
        CREATE INDEX IF NOT EXISTS idx_compliance_snap_date ON compliance_snapshots(snapshot_date)
    """))
    await db.commit()


# ── Score calculators ──────────────────────────────────────────────────────────

async def _patch_score(db: AsyncSession) -> tuple[float, dict]:
    """Patch compliance: % agents with zero pending patches (any category)."""
    try:
        result = await db.execute(text("""
            SELECT
                COUNT(DISTINCT a.id) AS total_agents,
                COUNT(DISTINCT CASE WHEN p.pending_count = 0 OR p.pending_count IS NULL THEN a.id END) AS compliant_agents
            FROM agents a
            LEFT JOIN (
                SELECT agent_id, COUNT(*) AS pending_count
                FROM agent_patches
                WHERE available_version IS NOT NULL AND available_version != ''
                GROUP BY agent_id
            ) p ON p.agent_id = a.id
            WHERE a.is_active = TRUE AND a.status = 'online' AND a.exclude_from_reports = FALSE
        """))
        row = result.fetchone()
        total = row[0] or 0
        compliant = row[1] or 0
        score = round((compliant / total * 100), 1) if total > 0 else 100.0
        return score, {"total_agents": total, "compliant_agents": compliant, "target": 95.0}
    except Exception:
        return 100.0, {"total_agents": 0, "compliant_agents": 0, "target": 95.0}


async def _vuln_score(db: AsyncSession) -> tuple[float, dict]:
    """Vulnerability compliance: penalise for open critical/high CVEs."""
    try:
        result = await db.execute(text("""
            SELECT
                COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
                COUNT(*) FILTER (WHERE severity = 'high') AS high
            FROM agent_vulnerabilities
            WHERE status = 'open'
        """))
        row = result.fetchone()
        critical = row[0] or 0
        high = row[1] or 0
    except Exception:
        critical, high = 0, 0

    score = max(0.0, 100.0 - (critical * 20) - (high * 10))
    score = min(100.0, round(score, 1))
    return score, {"critical_open": critical, "high_open": high, "target": 100.0}


async def _config_score(db: AsyncSession) -> tuple[float, dict]:
    """Configuration compliance: pass rate across all misconfig checks."""
    try:
        result = await db.execute(text("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'pass') AS passed,
                COUNT(*) AS total
            FROM agent_misconfigs
        """))
        row = result.fetchone()
        passed = row[0] or 0
        total = row[1] or 0
    except Exception:
        passed, total = 0, 0

    score = round((passed / total * 100), 1) if total > 0 else 100.0
    return score, {"passed": passed, "total": total, "target": 90.0}


def _av_ok_expr(alias: str = "a") -> str:
    """SQL CASE expression that returns TRUE when an agent has effective AV coverage.

    Detection order (Windows):
      1. Security Center 2 reports AV running (av_installed=true, av_running=true)
      2. Defender displaced: SC2 reports only Defender as disabled, but SW inventory
         has a 3rd-party AV (e.g. AVG disables Defender when it takes over)
      3. SW inventory fallback: SC2 missed the product (common with Sophos Central,
         CrowdStrike Falcon — managed EDR products that don't register in SC2)
    Linux: AV is not required — always treated as OK for compliance scoring.
    """
    a = alias
    sw_av_keywords = " OR ".join(
        f"LOWER(si.name) LIKE '%{kw}%'" for kw in [
            "sophos", "crowdstrike", "sentinelone", "carbon black", "cylance",
            "avg", "avast", "eset", "kaspersky", "bitdefender", "malwarebytes",
            "mcafee", "trellix", "trend micro", "symantec", "norton", "webroot",
            "f-secure", "clamav",
        ]
    )
    return f"""
        CASE
            WHEN {a}.os_type = 'linux' THEN TRUE
            WHEN s.av_installed = TRUE AND s.av_running = TRUE THEN TRUE
            WHEN s.av_installed = TRUE AND s.av_running = FALSE
                 AND s.av_product ILIKE '%defender%'
                 AND EXISTS (
                     SELECT 1 FROM software_inventory si
                     WHERE si.agent_id = {a}.id
                       AND ({sw_av_keywords})
                       AND LOWER(si.name) NOT LIKE '%defender%'
                 ) THEN TRUE
            WHEN EXISTS (
                SELECT 1 FROM software_inventory si
                WHERE si.agent_id = {a}.id
                  AND ({sw_av_keywords})
                  AND LOWER(si.name) NOT LIKE '%defender%'
            ) THEN TRUE
            ELSE FALSE
        END
    """


async def _protection_score(db: AsyncSession) -> tuple[float, dict]:
    """Endpoint protection: % Windows agents with effective AV coverage.

    Firewall is intentionally excluded here — it is already captured in
    Configuration compliance (agent_misconfigs pass rate).  Including it
    here would double-penalise agents and make the metric misleading.

    Linux agents are treated as N/A (AV is not required) and excluded from
    both numerator and denominator so they don't inflate or deflate the score.
    """
    try:
        av_ok = _av_ok_expr("a")
        result = await db.execute(text(f"""
            SELECT
                COUNT(DISTINCT a.id) AS total,
                COUNT(DISTINCT CASE WHEN ({av_ok}) THEN a.id END) AS protected
            FROM agents a
            LEFT JOIN agent_security_state s ON s.agent_id = a.id
            WHERE a.is_active = TRUE
              AND a.status = 'online'
              AND a.os_type = 'windows'
              AND a.exclude_from_reports = FALSE
        """))
        row = result.fetchone()
        total = row[0] or 0
        protected = row[1] or 0
    except Exception:
        total, protected = 0, 0

    score = round((protected / total * 100), 1) if total > 0 else 100.0
    return score, {"total_agents": total, "protected_agents": protected, "target": 100.0}


async def _license_score(db: AsyncSession) -> tuple[float, dict]:
    """License compliance: % activated licenses."""
    try:
        result = await db.execute(text("""
            SELECT
                COUNT(*) FILTER (WHERE activation_status = 'activated') AS activated,
                COUNT(*) AS total
            FROM agent_licenses
        """))
        row = result.fetchone()
        activated = row[0] or 0
        total = row[1] or 0
    except Exception:
        activated, total = 0, 0

    score = round((activated / total * 100), 1) if total > 0 else 100.0
    return score, {"activated": activated, "total": total, "target": 100.0}


def _overall(patch: float, vuln: float, config: float, protection: float, license_: float) -> float:
    return round(patch * 0.35 + vuln * 0.25 + config * 0.20 + protection * 0.10 + license_ * 0.10, 1)


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def compliance_dashboard(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Current compliance scores for all categories."""
    await _ensure_tables(db)

    patch_s, patch_d = await _patch_score(db)
    vuln_s, vuln_d = await _vuln_score(db)
    config_s, config_d = await _config_score(db)
    prot_s, prot_d = await _protection_score(db)
    lic_s, lic_d = await _license_score(db)
    overall = _overall(patch_s, vuln_s, config_s, prot_s, lic_s)

    return {
        "overall": overall,
        "compliant": overall >= 80,
        "categories": {
            "patch": {"score": patch_s, "weight": 35, "target": patch_d.get("target", 95), **patch_d},
            "vulnerability": {"score": vuln_s, "weight": 25, "target": vuln_d.get("target", 100), **vuln_d},
            "configuration": {"score": config_s, "weight": 20, "target": config_d.get("target", 90), **config_d},
            "protection": {"score": prot_s, "weight": 10, "target": prot_d.get("target", 100), **prot_d},
            "license": {"score": lic_s, "weight": 10, "target": lic_d.get("target", 100), **lic_d},
        },
    }


@router.get("/trend")
async def compliance_trend(
    days: int = 30,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Daily scores for the last N days (from snapshots)."""
    await _ensure_tables(db)

    result = await db.execute(text("""
        SELECT snapshot_date, category, score
        FROM compliance_snapshots
        WHERE snapshot_date >= CURRENT_DATE - (:days * INTERVAL '1 day')
        ORDER BY snapshot_date, category
    """), {"days": days})

    rows = result.fetchall()
    # Pivot: date → {category: score}
    pivot = {}
    for snap_date, category, score in rows:
        d = str(snap_date)
        if d not in pivot:
            pivot[d] = {"date": d}
        pivot[d][category] = float(score) if score is not None else None

    return sorted(pivot.values(), key=lambda x: x["date"])


@router.post("/snapshot")
async def save_snapshot(
    snapshot_date: Optional[str] = Query(None, description="Override date for backfilling, YYYY-MM-DD. Defaults to today."),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Manually trigger a compliance snapshot (normally runs on schedule).
    Pass ?snapshot_date=YYYY-MM-DD to backfill historical dates."""
    await _ensure_tables(db)

    patch_s, patch_d = await _patch_score(db)
    vuln_s, vuln_d = await _vuln_score(db)
    config_s, config_d = await _config_score(db)
    prot_s, prot_d = await _protection_score(db)
    lic_s, lic_d = await _license_score(db)
    overall = _overall(patch_s, vuln_s, config_s, prot_s, lic_s)

    if snapshot_date:
        try:
            snap_date = date.fromisoformat(snapshot_date)
        except ValueError:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="snapshot_date must be YYYY-MM-DD")
    else:
        snap_date = date.today()

    import json
    for category, score, details in [
        ("overall", overall, {}),
        ("patch", patch_s, patch_d),
        ("vulnerability", vuln_s, vuln_d),
        ("configuration", config_s, config_d),
        ("protection", prot_s, prot_d),
        ("license", lic_s, lic_d),
    ]:
        await db.execute(text("""
            INSERT INTO compliance_snapshots (snapshot_date, category, score, details)
            VALUES (:snap_date, :cat, :score, CAST(:details AS jsonb))
            ON CONFLICT (snapshot_date, category) DO UPDATE SET score = EXCLUDED.score, details = EXCLUDED.details
        """), {"snap_date": snap_date, "cat": category, "score": score, "details": json.dumps(details)})

    await db.commit()
    return {"status": "ok", "overall": overall, "date": str(snap_date)}


@router.get("/quarterly")
async def compliance_quarterly(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Quarterly compliance scores from Q1 2025 to current, with trend analysis."""
    await _ensure_tables(db)

    # Fetch all snapshots from 2025 onwards, grouped by quarter
    result = await db.execute(text("""
        SELECT
            EXTRACT(YEAR FROM snapshot_date)::int AS yr,
            EXTRACT(QUARTER FROM snapshot_date)::int AS qtr,
            category,
            AVG(score) AS avg_score
        FROM compliance_snapshots
        WHERE snapshot_date >= '2025-01-01'
        GROUP BY yr, qtr, category
        ORDER BY yr, qtr, category
    """))
    rows = result.fetchall()

    # Build quarter map: {(yr, qtr): {category: score}}
    qmap: dict[tuple, dict] = {}
    for yr, qtr, category, avg_score in rows:
        key = (int(yr), int(qtr))
        if key not in qmap:
            qmap[key] = {}
        qmap[key][category] = round(float(avg_score), 1) if avg_score is not None else None

    # Compute the current quarter live (always fresh)
    patch_s, patch_d   = await _patch_score(db)
    vuln_s, vuln_d     = await _vuln_score(db)
    config_s, config_d = await _config_score(db)
    prot_s, prot_d     = await _protection_score(db)
    lic_s, lic_d       = await _license_score(db)
    overall_now = _overall(patch_s, vuln_s, config_s, prot_s, lic_s)

    from datetime import date
    today = date.today()
    cur_yr  = today.year
    cur_qtr = (today.month - 1) // 3 + 1
    cur_key = (cur_yr, cur_qtr)

    # Overwrite/add current quarter with live data
    qmap[cur_key] = {
        "overall":       overall_now,
        "patch":         patch_s,
        "vulnerability": vuln_s,
        "configuration": config_s,
        "protection":    prot_s,
        "license":       lic_s,
    }

    # Build all quarters from Q1 2025 to current
    all_quarters = []
    yr, qtr = 2025, 1
    while (yr, qtr) <= cur_key:
        all_quarters.append((yr, qtr))
        if qtr == 4:
            yr += 1; qtr = 1
        else:
            qtr += 1

    CATEGORIES = ["overall", "patch", "vulnerability", "configuration", "protection", "license"]

    def _trend(prev: float | None, curr: float | None) -> str:
        if prev is None or curr is None:
            return "new"
        diff = curr - prev
        if diff >= 2:
            return "increasing"
        if diff <= -2:
            return "decreasing"
        return "stagnant"

    quarters_out = []
    for i, key in enumerate(all_quarters):
        prev_key = all_quarters[i - 1] if i > 0 else None
        scores = qmap.get(key, {})
        prev_scores = qmap.get(prev_key, {}) if prev_key else {}

        q_label = f"Q{key[1]} {key[0]}"
        entry = {"quarter": q_label, "year": key[0], "q": key[1], "is_current": key == cur_key}
        for cat in CATEGORIES:
            s = scores.get(cat)
            p = prev_scores.get(cat)
            entry[cat] = s
            entry[f"{cat}_trend"] = _trend(p, s)
            entry[f"{cat}_prev"] = p
        quarters_out.append(entry)

    return quarters_out


@router.get("/monthly")
async def compliance_monthly(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Monthly compliance scores from first snapshot to current, with trend analysis."""
    await _ensure_tables(db)

    result = await db.execute(text("""
        SELECT
            DATE_TRUNC('month', snapshot_date)::date AS month_start,
            category,
            AVG(score) AS avg_score
        FROM compliance_snapshots
        WHERE snapshot_date >= '2025-01-01'
        GROUP BY 1, 2
        ORDER BY 1, 2
    """))
    rows = result.fetchall()

    mmap: dict[str, dict] = {}
    for month_start, category, avg_score in rows:
        key = str(month_start)[:7]  # "YYYY-MM"
        if key not in mmap:
            mmap[key] = {}
        mmap[key][category] = round(float(avg_score), 1) if avg_score is not None else None

    # Always inject live scores for the current month
    patch_s, _  = await _patch_score(db)
    vuln_s, _   = await _vuln_score(db)
    config_s, _ = await _config_score(db)
    prot_s, _   = await _protection_score(db)
    lic_s, _    = await _license_score(db)
    overall_now = _overall(patch_s, vuln_s, config_s, prot_s, lic_s)

    from datetime import date
    today = date.today()
    cur_key = today.strftime("%Y-%m")
    mmap[cur_key] = {
        "overall": overall_now, "patch": patch_s, "vulnerability": vuln_s,
        "configuration": config_s, "protection": prot_s, "license": lic_s,
    }

    CATEGORIES = ["overall", "patch", "vulnerability", "configuration", "protection", "license"]

    def _trend(prev, curr):
        if prev is None or curr is None:
            return "new"
        diff = curr - prev
        if diff >= 2:   return "increasing"
        if diff <= -2:  return "decreasing"
        return "stagnant"

    all_months = sorted(mmap.keys())
    months_out = []
    for i, key in enumerate(all_months):
        prev_key = all_months[i - 1] if i > 0 else None
        scores = mmap.get(key, {})
        prev_scores = mmap.get(prev_key, {}) if prev_key else {}
        yr, mo = int(key[:4]), int(key[5:7])
        from datetime import date as _date
        label = _date(yr, mo, 1).strftime("%B %Y")
        entry = {"month": key, "label": label, "is_current": key == cur_key}
        for cat in CATEGORIES:
            s = scores.get(cat)
            p = prev_scores.get(cat)
            entry[cat] = s
            entry[f"{cat}_prev"] = p
            entry[f"{cat}_trend"] = _trend(p, s)
        months_out.append(entry)

    return months_out


@router.get("/risk-evidence")
async def risk_evidence(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Per-agent compliance evidence for risk review export."""
    await _ensure_tables(db)

    # Reuse per_agent_compliance logic but return a summary subset
    try:
        av_ok = _av_ok_expr("a")
        result = await db.execute(text(f"""
            SELECT
                a.id AS agent_id,
                a.hostname, a.display_name, a.ip_address, a.os_type, a.os_name,
                (SELECT COUNT(*) FROM agent_patches pp WHERE pp.agent_id = a.id AND pp.available_version IS NOT NULL AND pp.available_version != '') AS critical_patches,
                (SELECT COUNT(*) FILTER (WHERE m.status = 'pass') FROM agent_misconfigs m WHERE m.agent_id = a.id) AS config_pass,
                (SELECT COUNT(*) FROM agent_misconfigs m WHERE m.agent_id = a.id) AS config_total,
                CASE WHEN ({av_ok}) THEN 'pass' ELSE 'fail' END AS av_status,
                (SELECT COUNT(*) FROM agent_vulnerabilities v WHERE v.agent_id = a.id AND v.status = 'open' AND v.severity = 'critical') AS crit_vulns,
                (SELECT COUNT(*) FROM agent_vulnerabilities v WHERE v.agent_id = a.id AND v.status = 'open' AND v.severity = 'high') AS high_vulns,
                (SELECT COUNT(*) FROM agent_licenses l WHERE l.agent_id = a.id AND l.activation_status = 'activated') AS lic_activated,
                (SELECT COUNT(*) FROM agent_licenses l WHERE l.agent_id = a.id) AS lic_total,
                a.status AS agent_status,
                a.last_seen
            FROM agents a
            LEFT JOIN agent_security_state s ON s.agent_id = a.id
            WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
            ORDER BY a.hostname
        """))
    except Exception:
        return []

    cols = ["agent_id", "hostname", "display_name", "ip_address", "os_type", "os_name",
            "critical_patches", "config_pass", "config_total", "av_status",
            "crit_vulns", "high_vulns", "lic_activated", "lic_total", "agent_status", "last_seen"]

    agents = []
    for row in result.fetchall():
        d = dict(zip(cols, row))
        patch_score  = 0.0 if (d["critical_patches"] or 0) > 0 else 100.0
        config_t     = d["config_total"] or 0
        config_score = round((d["config_pass"] or 0) / config_t * 100, 1) if config_t > 0 else 100.0
        prot_score   = 100.0 if (d["os_type"] or "").lower() == "linux" or d["av_status"] == "pass" else 0.0
        vuln_score   = max(0.0, 100.0 - (d["crit_vulns"] or 0) * 20 - (d["high_vulns"] or 0) * 10)
        lic_t        = d["lic_total"] or 0
        lic_score    = round((d["lic_activated"] or 0) / lic_t * 100, 1) if lic_t > 0 else 100.0
        overall      = round(patch_score * 0.35 + vuln_score * 0.25 + config_score * 0.20 + prot_score * 0.10 + lic_score * 0.10, 1)

        agents.append({
            "agent_id":        str(d["agent_id"]) if d["agent_id"] else None,
            "hostname":        d["hostname"],
            "display_name":    d["display_name"] or d["hostname"],
            "ip_address":      d["ip_address"],
            "os_type":         d["os_type"],
            "os_name":         d["os_name"],
            "agent_status":    d["agent_status"],
            "last_seen":       d["last_seen"].isoformat() if d["last_seen"] else None,
            "patch_score":     patch_score,
            "config_score":    config_score,
            "protection_score": prot_score,
            "vuln_score":      vuln_score,
            "license_score":   lic_score,
            "overall_score":   overall,
            "compliant":       overall >= 80,
            "critical_patches": d["critical_patches"] or 0,
            "config_pass":     d["config_pass"] or 0,
            "config_fail":     config_t - (d["config_pass"] or 0),
            "crit_vulns":      d["crit_vulns"] or 0,
            "high_vulns":      d["high_vulns"] or 0,
            "av_status":       d["av_status"],
            "lic_activated":   d["lic_activated"] or 0,
            "lic_total":       lic_t,
        })
    return agents


@router.get("/per-agent")
async def per_agent_compliance(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Per-agent compliance breakdown."""
    await _ensure_tables(db)

    try:
        av_ok = _av_ok_expr("a")
        result = await db.execute(text(f"""
            SELECT
                a.id::text, a.hostname, a.display_name, a.description, a.ip_address, a.os_type, a.os_name,
                -- Patch: 0 pending (any category with available update) = compliant
                (SELECT COUNT(*) FROM agent_patches pp WHERE pp.agent_id = a.id AND pp.available_version IS NOT NULL AND pp.available_version != '') AS critical_patches,
                -- Config: pass rate
                (SELECT COUNT(*) FILTER (WHERE m.status = 'pass') FROM agent_misconfigs m WHERE m.agent_id = a.id) AS config_pass,
                (SELECT COUNT(*) FROM agent_misconfigs m WHERE m.agent_id = a.id) AS config_total,
                -- Firewall flag
                (SELECT m.status FROM agent_misconfigs m WHERE m.agent_id = a.id AND m.rule_id = 'FIREWALL_DISABLED' LIMIT 1) AS fw_status,
                -- AV: use combined detection (SC2 + SW inventory fallback + Defender displacement)
                CASE WHEN ({av_ok}) THEN 'pass' ELSE 'fail' END AS av_status,
                -- CVE open
                (SELECT COUNT(*) FROM agent_vulnerabilities v WHERE v.agent_id = a.id AND v.status = 'open' AND v.severity = 'critical') AS crit_vulns,
                (SELECT COUNT(*) FROM agent_vulnerabilities v WHERE v.agent_id = a.id AND v.status = 'open' AND v.severity = 'high') AS high_vulns,
                -- License
                (SELECT COUNT(*) FROM agent_licenses l WHERE l.agent_id = a.id AND l.activation_status = 'activated') AS lic_activated,
                (SELECT COUNT(*) FROM agent_licenses l WHERE l.agent_id = a.id) AS lic_total
            FROM agents a
            LEFT JOIN agent_security_state s ON s.agent_id = a.id
            WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
            ORDER BY a.hostname
        """))
    except Exception:
        return []

    cols = ["id", "hostname", "display_name", "description", "ip_address", "os_type", "os_name",
            "critical_patches", "config_pass", "config_total", "fw_status", "av_status",
            "crit_vulns", "high_vulns", "lic_activated", "lic_total"]

    agents = []
    for row in result.fetchall():
        d = dict(zip(cols, row))

        # Per-agent scores
        patch_score = 0.0 if (d["critical_patches"] or 0) > 0 else 100.0
        config_t = d["config_total"] or 0
        config_score = round((d["config_pass"] or 0) / config_t * 100, 1) if config_t > 0 else None
        os_type = (d["os_type"] or "").lower()
        if os_type == "linux":
            prot_score = 100.0  # AV not required on Linux
        else:
            prot_score = 100.0 if d["av_status"] == "pass" else 0.0
        vuln_score = max(0.0, 100.0 - (d["crit_vulns"] or 0) * 20 - (d["high_vulns"] or 0) * 10)
        lic_t = d["lic_total"] or 0
        lic_score = round((d["lic_activated"] or 0) / lic_t * 100, 1) if lic_t > 0 else None

        # Overall for agent (use None scores as 100 if no data)
        scores = [
            patch_score * 0.35,
            vuln_score * 0.25,
            (config_score or 100) * 0.20,
            prot_score * 0.10,
            (lic_score or 100) * 0.10,
        ]
        overall = round(sum(scores), 1)

        agents.append({
            "id": d["id"],
            "hostname": d["hostname"],
            "display_name": d["display_name"] or d["hostname"],
            "description": d["description"],
            "ip_address": d["ip_address"],
            "os_type": d["os_type"],
            "os_name": d["os_name"],
            "patch_score": patch_score,
            "vuln_score": vuln_score,
            "config_score": config_score,
            "protection_score": prot_score,
            "license_score": lic_score,
            "overall_score": overall,
            "compliant": overall >= 80,
            "critical_patches": d["critical_patches"] or 0,
            "crit_vulns": d["crit_vulns"] or 0,
            "high_vulns": d["high_vulns"] or 0,
            "config_pass": d["config_pass"] or 0,
            "config_total": config_t,
            "config_fail": (config_t - (d["config_pass"] or 0)) if config_t > 0 else None,
            "fw_status": d["fw_status"],
            "av_status": d["av_status"],
        })

    return agents


# ── XLSX Export ────────────────────────────────────────────────────────────────

def _xlsx_color(score) -> str:
    """Return openpyxl hex fill colour for a score."""
    if score is None:
        return "64748B"
    if score >= 80:
        return "166534"   # dark green
    if score >= 60:
        return "854D0E"   # dark yellow
    return "991B1B"       # dark red


def _trend_label(trend: str) -> str:
    return {"increasing": "↑ Increasing", "decreasing": "↓ Decreasing",
            "stagnant": "→ Stagnant", "new": "Baseline"}.get(trend or "", "—")


@router.get("/risk-review/xlsx")
async def risk_review_xlsx(
    month: Optional[str] = Query(None, description="Month to export, format YYYY-MM (e.g. 2026-06). Omit for quarterly report."),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Generate a multi-sheet XLSX Risk Review report."""
    import io
    import openpyxl
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    await _ensure_tables(db)

    # ── Fetch data ──────────────────────────────────────────────────────────────
    # Quarterly data (reuse quarterly endpoint logic)
    result = await db.execute(text("""
        SELECT EXTRACT(YEAR FROM snapshot_date)::int AS yr,
               EXTRACT(QUARTER FROM snapshot_date)::int AS qtr,
               category, AVG(score) AS avg_score
        FROM compliance_snapshots
        WHERE snapshot_date >= '2025-01-01'
        GROUP BY yr, qtr, category ORDER BY yr, qtr, category
    """))
    qmap: dict = {}
    for yr, qtr, category, avg_score in result.fetchall():
        key = (int(yr), int(qtr))
        if key not in qmap:
            qmap[key] = {}
        qmap[key][category] = round(float(avg_score), 1) if avg_score is not None else None

    patch_s, _   = await _patch_score(db)
    vuln_s, _    = await _vuln_score(db)
    config_s, _  = await _config_score(db)
    prot_s, _    = await _protection_score(db)
    lic_s, _     = await _license_score(db)
    overall_now  = _overall(patch_s, vuln_s, config_s, prot_s, lic_s)

    today = date.today()
    cur_yr  = today.year
    cur_qtr = (today.month - 1) // 3 + 1
    cur_key = (cur_yr, cur_qtr)
    qmap[cur_key] = {
        "overall": overall_now, "patch": patch_s, "vulnerability": vuln_s,
        "configuration": config_s, "protection": prot_s, "license": lic_s,
    }

    all_quarters = []
    yr, qtr = 2025, 1
    while (yr, qtr) <= cur_key:
        all_quarters.append((yr, qtr))
        if qtr == 4:
            yr += 1; qtr = 1
        else:
            qtr += 1

    CATS = ["overall", "patch", "vulnerability", "configuration", "protection", "license"]
    CAT_LABELS = {
        "overall": "Overall", "patch": "Patch Compliance (35%)",
        "vulnerability": "Vulnerability Mgmt (25%)", "configuration": "Configuration (20%)",
        "protection": "Endpoint Protection (10%)", "license": "License Compliance (10%)",
    }

    quarters_out = []
    for i, key in enumerate(all_quarters):
        prev_key = all_quarters[i - 1] if i > 0 else None
        scores = qmap.get(key, {})
        prev_scores = qmap.get(prev_key, {}) if prev_key else {}
        entry = {"quarter": f"Q{key[1]} {key[0]}", "is_current": key == cur_key}
        for cat in CATS:
            s = scores.get(cat)
            p = prev_scores.get(cat)
            entry[cat] = s
            entry[f"{cat}_prev"] = p
            if p is None or s is None:
                entry[f"{cat}_trend"] = "new"
            elif s - p >= 2:
                entry[f"{cat}_trend"] = "increasing"
            elif s - p <= -2:
                entry[f"{cat}_trend"] = "decreasing"
            else:
                entry[f"{cat}_trend"] = "stagnant"
        quarters_out.append(entry)

    # Evidence (per-agent)
    evidence_rows = await risk_evidence(db, _)

    # ── Shared styling constants (needed by both monthly and quarterly paths) ───
    DARK_BG   = "0F172A"
    HDR_BG    = "1E293B"
    HDR_FG    = "94A3B8"
    WHITE     = "FFFFFF"
    BLUE      = "3B82F6"
    SLATE     = "334155"
    SUBHDR_BG = "1E3A5F"

    # ── Monthly export path ─────────────────────────────────────────────────────
    if month:
        try:
            yr_m, mo_m = int(month.split("-")[0]), int(month.split("-")[1])
        except (ValueError, IndexError):
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        month_start = date(yr_m, mo_m, 1)
        month_end   = date(yr_m, mo_m, calendar.monthrange(yr_m, mo_m)[1])
        month_label = month_start.strftime("%B %Y")  # "June 2026"

        # Daily scores for this month from snapshots
        daily_res = await db.execute(text("""
            SELECT snapshot_date, category, score
            FROM compliance_snapshots
            WHERE snapshot_date >= :start AND snapshot_date <= :end
            ORDER BY snapshot_date, category
        """), {"start": month_start, "end": month_end})
        daily_rows = daily_res.fetchall()

        # Build {date: {category: score}} map
        daily_map: dict = {}
        for snap_date, cat, score in daily_rows:
            key = str(snap_date)
            if key not in daily_map:
                daily_map[key] = {}
            daily_map[key][cat] = round(float(score), 1) if score is not None else None

        # Average scores for the month (fall back to current live scores if no snapshots)
        avg_res = await db.execute(text("""
            SELECT category, AVG(score) AS avg_score
            FROM compliance_snapshots
            WHERE snapshot_date >= :start AND snapshot_date <= :end
            GROUP BY category
        """), {"start": month_start, "end": month_end})
        avg_map = {row[0]: round(float(row[1]), 1) for row in avg_res.fetchall() if row[1] is not None}

        # Check if this month is the current month — if so, blend in live scores
        is_current_month = (month_start.year == today.year and month_start.month == today.month)
        no_snapshot_data = not avg_map

        if no_snapshot_data and is_current_month:
            # Current month has no snapshots yet — use live scores as best estimate
            avg_map = {
                "patch": patch_s, "vulnerability": vuln_s, "configuration": config_s,
                "protection": prot_s, "license": lic_s, "overall": overall_now,
            }
        elif no_snapshot_data:
            # Past month with no snapshots — do NOT substitute live scores (that's misleading)
            avg_map = {
                "patch": None, "vulnerability": None, "configuration": None,
                "protection": None, "license": None, "overall": None,
            }
        elif "overall" not in avg_map:
            avg_map["overall"] = round(_overall(
                avg_map.get("patch", 0), avg_map.get("vulnerability", 0),
                avg_map.get("configuration", 0), avg_map.get("protection", 0),
                avg_map.get("license", 0),
            ), 1)

        # ── Monthly workbook ────────────────────────────────────────────────────
        wb_m = openpyxl.Workbook()
        wb_m.remove(wb_m.active)

        def mfont(bold=True, color=WHITE, size=10):
            return Font(bold=bold, color=color, size=size, name="Calibri")
        def mfill(hex_color):
            return PatternFill("solid", fgColor=hex_color)
        def mborder():
            s = Side(style="thin", color=SLATE)
            return Border(left=s, right=s, top=s, bottom=s)
        def mhdr(ws, row_num, headers, bg=HDR_BG):
            for col, h in enumerate(headers, 1):
                c = ws.cell(row=row_num, column=col, value=h)
                c.font = mfont(color=HDR_FG)
                c.fill = mfill(bg)
                c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                c.border = mborder()
        def mscore(ws, row, col, score):
            c = ws.cell(row=row, column=col, value=score)
            c.font = Font(bold=True, color=WHITE, size=10, name="Calibri")
            c.fill = mfill(_xlsx_color(score))
            c.alignment = Alignment(horizontal="center", vertical="center")
            c.border = mborder()
        def mtext(ws, row, col, value, bold=False, color="CBD5E1", align="left", bg=HDR_BG):
            c = ws.cell(row=row, column=col, value=value)
            c.font = Font(bold=bold, color=color, size=10, name="Calibri")
            c.fill = mfill(bg)
            c.alignment = Alignment(horizontal=align, vertical="center")
            c.border = mborder()

        CATS_M = ["overall", "patch", "vulnerability", "configuration", "protection", "license"]
        CAT_LABELS_M = {
            "overall": "Overall Score", "patch": "Patch Compliance (35%)",
            "vulnerability": "Vulnerability Mgmt (25%)", "configuration": "Configuration (20%)",
            "protection": "Endpoint Protection (10%)", "license": "License Compliance (10%)",
        }

        # ── Derived metrics for executive summary ───────────────────────────────
        total_agents_m     = len(evidence_rows)
        compliant_agents_m = sum(1 for a in evidence_rows if a["compliant"])
        non_compliant_m    = total_agents_m - compliant_agents_m
        rate_pct_m         = round(compliant_agents_m / total_agents_m * 100, 1) if total_agents_m > 0 else 0
        total_crit_patches = sum(a["critical_patches"] for a in evidence_rows)
        total_crit_cves    = sum(a["crit_vulns"] for a in evidence_rows)
        total_high_cves    = sum(a["high_vulns"] for a in evidence_rows)
        unprotected        = sum(1 for a in evidence_rows if a["av_status"] != "pass")
        overall_score      = avg_map.get("overall") or 0

        # Posture label
        if no_snapshot_data and not is_current_month:
            posture_label, posture_color = "NO HISTORICAL DATA", "475569"
        elif overall_score >= 85:
            posture_label, posture_color = "STRONG", "166534"
        elif overall_score >= 70:
            posture_label, posture_color = "MODERATE", "854D0E"
        else:
            posture_label, posture_color = "AT RISK", "991B1B"

        # Top 5 worst non-compliant agents
        worst_agents = sorted(
            [a for a in evidence_rows if not a["compliant"]],
            key=lambda a: a["overall_score"]
        )[:5]

        # ── Sheet 1: Monthly Executive Summary ──────────────────────────────────
        ms1 = wb_m.create_sheet("Executive Summary")
        ms1.sheet_view.showGridLines = False
        ms1.tab_color = BLUE

        # Freeze pane below header rows so data stays visible
        ms1.freeze_panes = "A4"

        # Helper: section banner
        def section_banner(ws, row, text, col_span="A:H"):
            start_col = col_span.split(":")[0]
            end_col   = col_span.split(":")[1]
            ws.merge_cells(f"{start_col}{row}:{end_col}{row}")
            ws.row_dimensions[row].height = 20
            c = ws[f"{start_col}{row}"]
            c.value = text
            c.font  = Font(bold=True, color=BLUE, size=10, name="Calibri")
            c.fill  = mfill(SUBHDR_BG)
            c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
            c.border = mborder()

        # ── Row 1: Report title ─────────────────────────────────────────────────
        ms1.row_dimensions[1].height = 36
        ms1.merge_cells("A1:H1")
        r1 = ms1["A1"]
        r1.value = f"SECURITY COMPLIANCE REPORT  —  {month_label.upper()}"
        r1.font  = Font(bold=True, color=WHITE, size=18, name="Calibri")
        r1.fill  = mfill(DARK_BG)
        r1.alignment = Alignment(horizontal="center", vertical="center")

        # ── Row 2: Sub-header ───────────────────────────────────────────────────
        ms1.row_dimensions[2].height = 16
        ms1.merge_cells("A2:H2")
        r2 = ms1["A2"]
        r2.value = (f"Kifaa Endpoint Management Platform  |  "
                    f"Period: {month_start.strftime('%d %b %Y')} – {month_end.strftime('%d %b %Y')}  |  "
                    f"Generated: {today.strftime('%d %B %Y')}  |  "
                    f"Based on {len(daily_map)} daily snapshot{'s' if len(daily_map) != 1 else ''}")
        r2.font  = Font(color=HDR_FG, size=9, italic=True, name="Calibri")
        r2.fill  = mfill(DARK_BG)
        r2.alignment = Alignment(horizontal="center", vertical="center")

        ms1.row_dimensions[3].height = 8
        for col in range(1, 9):
            c = ms1.cell(row=3, column=col)
            c.fill = mfill(DARK_BG)

        # ── SECTION A: Posture at a Glance (KPI tiles, row 4–10) ───────────────
        ms1.row_dimensions[4].height = 14
        section_banner(ms1, 4, "  A.  SECURITY POSTURE AT A GLANCE")

        # KPI tiles: 4 metrics across columns A-B, C-D, E-F, G-H (rows 5-8)
        kpi_data = [
            ("OVERALL SCORE",      f"{overall_score:.1f} / 100",   posture_color,   "Weighted average across all categories"),
            ("COMPLIANCE RATE",    f"{rate_pct_m}%",               "166534" if rate_pct_m >= 80 else "854D0E" if rate_pct_m >= 60 else "991B1B",
                                                                    f"{compliant_agents_m} of {total_agents_m} endpoints meeting ≥80% threshold"),
            ("SECURITY POSTURE",   posture_label,                  posture_color,   "Based on overall score: Strong ≥85  Moderate ≥70  At Risk <70"),
            ("CRITICAL EXPOSURE",  f"{total_crit_patches + total_crit_cves} items",
                                                                    "991B1B" if (total_crit_patches + total_crit_cves) > 0 else "166534",
                                                                    f"{total_crit_patches} critical patches  +  {total_crit_cves} critical CVEs open"),
        ]
        kpi_cols = [(1, 2), (3, 4), (5, 6), (7, 8)]  # (label_col, value_col) pairs → each tile spans 2 cols
        for tile_i, ((kpi_label, kpi_val, kpi_color, kpi_note), (ca, cb)) in enumerate(zip(kpi_data, kpi_cols)):
            col_letter_a = get_column_letter(ca)
            col_letter_b = get_column_letter(cb)
            # Tile background rows 5-8
            for r in range(5, 9):
                ms1.row_dimensions[r].height = 16
                for col in [ca, cb]:
                    ms1.cell(row=r, column=col).fill = mfill("0B1120")
                    ms1.cell(row=r, column=col).border = mborder()
            ms1.merge_cells(f"{col_letter_a}5:{col_letter_b}5")
            ms1.merge_cells(f"{col_letter_a}6:{col_letter_b}6")
            ms1.merge_cells(f"{col_letter_a}7:{col_letter_b}7")
            ms1.merge_cells(f"{col_letter_a}8:{col_letter_b}8")
            # Label
            lc = ms1[f"{col_letter_a}5"]
            lc.value = kpi_label
            lc.font  = Font(bold=False, color="64748B", size=9, name="Calibri")
            lc.fill  = mfill("0B1120")
            lc.alignment = Alignment(horizontal="center", vertical="center")
            lc.border = mborder()
            # Value (big)
            vc = ms1[f"{col_letter_a}6"]
            vc.value = kpi_val
            vc.font  = Font(bold=True, color=kpi_color, size=16, name="Calibri")
            vc.fill  = mfill("0B1120")
            vc.alignment = Alignment(horizontal="center", vertical="center")
            vc.border = mborder()
            ms1.row_dimensions[6].height = 28
            # Note
            nc = ms1[f"{col_letter_a}7"]
            nc.value = kpi_note
            nc.font  = Font(color="64748B", size=8, name="Calibri")
            nc.fill  = mfill("0B1120")
            nc.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            nc.border = mborder()
            ms1.row_dimensions[7].height = 22
            # Bottom border spacer
            sp = ms1[f"{col_letter_a}8"]
            sp.fill = mfill("0B1120")
            sp.border = mborder()

        ms1.row_dimensions[9].height = 8
        for col in range(1, 9):
            ms1.cell(row=9, column=col).fill = mfill(DARK_BG)

        # ── SECTION B: Compliance Scorecard (row 10–18) ─────────────────────────
        section_banner(ms1, 10, "  B.  COMPLIANCE SCORECARD — MONTHLY AVERAGES")
        ms1.row_dimensions[11].height = 26

        score_headers = ["Category", "Weight", f"Avg Score ({month_label})", "Status", "Threshold", "Interpretation"]
        mhdr(ms1, 11, score_headers)

        scorecard_rows = [
            ("overall",       "Combined",  "Weighted average of all five categories"),
            ("patch",         "35%",       "Agents with zero critical pending patches / total"),
            ("vulnerability", "25%",       "max(0, 100 − critical×20 − high×10) across fleet"),
            ("configuration", "20%",       "Security policy checks passed / total applicable"),
            ("protection",    "10%",       "Agents with AV running and firewall enabled"),
            ("license",       "10%",       "Activated licences / total detected licences"),
        ]
        for ri, (cat, weight, interp) in enumerate(scorecard_rows, 12):
            score = avg_map.get(cat)
            status = "✓  Compliant" if (score or 0) >= 80 else "✗  Non-Compliant" if score is not None else "—"
            s_color = "166534" if (score or 0) >= 80 else "991B1B"
            ms1.row_dimensions[ri].height = 18
            is_overall = cat == "overall"
            row_bg = SUBHDR_BG if is_overall else HDR_BG

            def sc1(col, val, bold=False, color="CBD5E1", align="left"):
                c = ms1.cell(row=ri, column=col, value=val)
                c.font  = Font(bold=bold, color=color, size=10, name="Calibri")
                c.fill  = mfill(row_bg)
                c.alignment = Alignment(horizontal=align, vertical="center")
                c.border = mborder()

            sc1(1, CAT_LABELS_M[cat], bold=is_overall, color=WHITE if is_overall else "CBD5E1")
            sc1(2, weight, align="center", color="94A3B8")
            # Score cell coloured
            sv = round(score, 1) if score is not None else None
            cell_s = ms1.cell(row=ri, column=3, value=sv)
            cell_s.font  = Font(bold=True, color=WHITE, size=10, name="Calibri")
            cell_s.fill  = mfill(_xlsx_color(sv) if sv is not None else "475569")
            cell_s.alignment = Alignment(horizontal="center", vertical="center")
            cell_s.border = mborder()
            sc1(4, status, bold=is_overall, color=s_color, align="center")
            sc1(5, "≥ 80%", align="center", color="94A3B8")
            sc1(6, interp, color="64748B")

        ms1.row_dimensions[18].height = 8
        for col in range(1, 9):
            ms1.cell(row=18, column=col).fill = mfill(DARK_BG)

        # ── SECTION C: Endpoint Summary (row 19–27) ─────────────────────────────
        section_banner(ms1, 19, "  C.  ENDPOINT COMPLIANCE SUMMARY")
        ms1.row_dimensions[20].height = 26
        mhdr(ms1, 20, ["Metric", "Count / Value", "Detail", "", "", "", "", ""])

        summary_rows = [
            ("Total Managed Endpoints",       str(total_agents_m),        "All active enrolled agents"),
            ("Compliant Endpoints (≥80%)",    str(compliant_agents_m),    f"{rate_pct_m}% of fleet — meeting security threshold",),
            ("Non-Compliant Endpoints (<80%)",str(non_compliant_m),       "Require immediate attention — see Non-Compliant Agents tab"),
            ("Unprotected Endpoints",         str(unprotected),           "AV not running or firewall disabled (Windows agents)"),
            ("Critical Patches Outstanding",  str(total_crit_patches),    "Security patches rated Critical pending installation"),
            ("Critical CVEs Open",            str(total_crit_cves),       "Critical severity CVEs not yet remediated"),
            ("High CVEs Open",                str(total_high_cves),       "High severity CVEs not yet remediated"),
        ]
        for ri, (lbl, val, detail) in enumerate(summary_rows, 21):
            ms1.row_dimensions[ri].height = 18
            is_bad = (
                (lbl.startswith("Non-Compliant") and int(val) > 0) or
                (lbl.startswith("Critical") and int(val) > 0) or
                (lbl.startswith("High") and int(val) > 0) or
                (lbl.startswith("Unprotected") and int(val) > 0)
            )
            is_good = lbl.startswith("Compliant") and int(val) == total_agents_m
            val_color = "991B1B" if is_bad else "166534" if is_good else "CBD5E1"

            def sc2(col, v, bold=False, color="CBD5E1", align="left", span_end=None):
                c = ms1.cell(row=ri, column=col, value=v)
                c.font  = Font(bold=bold, color=color, size=10, name="Calibri")
                c.fill  = mfill(HDR_BG)
                c.alignment = Alignment(horizontal=align, vertical="center")
                c.border = mborder()

            sc2(1, lbl, bold=True)
            sc2(2, val, bold=True, color=val_color, align="center")
            ms1.merge_cells(f"C{ri}:H{ri}")
            sc2(3, detail, color="64748B")

        ms1.row_dimensions[28].height = 8
        for col in range(1, 9):
            ms1.cell(row=28, column=col).fill = mfill(DARK_BG)

        # ── SECTION D: Top Risk Endpoints (row 29–35) ───────────────────────────
        section_banner(ms1, 29, "  D.  TOP RISK ENDPOINTS (LOWEST COMPLIANCE SCORES)")
        ms1.row_dimensions[30].height = 26
        mhdr(ms1, 30, ["Hostname", "Overall", "Patch", "Vuln", "Config", "Protection", "Crit Patches", "Priority Action"])

        if worst_agents:
            for ri, a in enumerate(worst_agents, 31):
                ms1.row_dimensions[ri].height = 18
                actions = []
                if a["critical_patches"] > 0: actions.append(f"{a['critical_patches']} patch(es)")
                if a["crit_vulns"] > 0:        actions.append(f"{a['crit_vulns']} CVE(s)")
                if a["av_status"] != "pass":   actions.append("Fix AV")
                if (a.get("config_score") or 100) < 80: actions.append("Misconfigs")

                def sc3(col, val, bold=False, color="CBD5E1", align="left"):
                    c = ms1.cell(row=ri, column=col, value=val)
                    c.font  = Font(bold=bold, color=color, size=9, name="Calibri")
                    c.fill  = mfill("2D1F1F")
                    c.alignment = Alignment(horizontal=align, vertical="center")
                    c.border = mborder()

                sc3(1, a["hostname"], bold=True, color="FCA5A5")
                for ci2, sk in enumerate(["overall_score","patch_score","vuln_score","config_score","protection_score"], 2):
                    sv2 = a.get(sk)
                    cell_k = ms1.cell(row=ri, column=ci2, value=round(sv2, 1) if sv2 is not None else "—")
                    cell_k.font  = Font(bold=True, color=WHITE, size=9, name="Calibri")
                    cell_k.fill  = mfill(_xlsx_color(sv2))
                    cell_k.alignment = Alignment(horizontal="center", vertical="center")
                    cell_k.border = mborder()
                sc3(7, a["critical_patches"], color="EF4444" if a["critical_patches"] > 0 else "10B981", align="center")
                sc3(8, "; ".join(actions) if actions else "Review details", color="FCD34D")
        else:
            ms1.merge_cells(f"A31:H31")
            gc = ms1["A31"]
            gc.value = "✓  All endpoints are compliant — no high-risk systems identified."
            gc.font  = Font(bold=True, color="10B981", size=10, name="Calibri")
            gc.fill  = mfill(HDR_BG)
            gc.alignment = Alignment(horizontal="center", vertical="center")

        ms1.row_dimensions[36].height = 8
        for col in range(1, 9):
            ms1.cell(row=36, column=col).fill = mfill(DARK_BG)

        # ── SECTION E: Recommended Actions (row 37–) ────────────────────────────
        section_banner(ms1, 37, "  E.  RECOMMENDED ACTIONS")
        ms1.row_dimensions[38].height = 26
        mhdr(ms1, 38, ["Priority", "Area", "Finding", "Recommended Action", "Affected", "", "", ""])

        actions_list = []
        if total_crit_patches > 0:
            actions_list.append(("CRITICAL", "Patch Management",
                f"{total_crit_patches} critical patches outstanding across fleet",
                "Deploy critical patches immediately via Patches > Deploy",
                f"{sum(1 for a in evidence_rows if a['critical_patches']>0)} endpoints"))
        if total_crit_cves > 0:
            actions_list.append(("CRITICAL", "Vulnerability",
                f"{total_crit_cves} critical CVEs open and unmitigated",
                "Remediate or accept risk via Threats > Vulnerabilities",
                f"{sum(1 for a in evidence_rows if a['crit_vulns']>0)} endpoints"))
        if unprotected > 0:
            actions_list.append(("HIGH", "Endpoint Protection",
                f"{unprotected} endpoints without active AV or firewall",
                "Install and activate endpoint protection agent",
                f"{unprotected} endpoints"))
        if total_high_cves > 0:
            actions_list.append(("HIGH", "Vulnerability",
                f"{total_high_cves} high-severity CVEs open",
                "Schedule remediation in next maintenance window",
                f"{sum(1 for a in evidence_rows if a['high_vulns']>0)} endpoints"))
        if non_compliant_m > 0 and not any(a[0] == "CRITICAL" for a in actions_list):
            actions_list.append(("MEDIUM", "General Compliance",
                f"{non_compliant_m} endpoints below compliance threshold",
                "Review Non-Compliant Agents tab and address lowest scores first",
                f"{non_compliant_m} endpoints"))
        if not actions_list:
            actions_list.append(("NONE", "All Categories",
                "No critical or high findings identified",
                "Maintain current security posture and monitor for changes",
                "—"))

        priority_colors = {"CRITICAL": "991B1B", "HIGH": "854D0E", "MEDIUM": "1E3A5F", "NONE": "166534"}
        for ri, (pri, area, finding, action, affected) in enumerate(actions_list, 39):
            ms1.row_dimensions[ri].height = 20
            p_color = priority_colors.get(pri, "475569")

            def sc4(col, val, bold=False, color="CBD5E1", align="left", bg=HDR_BG, span_end=None):
                c = ms1.cell(row=ri, column=col, value=val)
                c.font  = Font(bold=bold, color=color, size=9, name="Calibri")
                c.fill  = mfill(bg)
                c.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)
                c.border = mborder()

            sc4(1, pri, bold=True, color=p_color, align="center", bg="0B1120")
            sc4(2, area, bold=True)
            sc4(3, finding, color="94A3B8")
            ms1.merge_cells(f"D{ri}:G{ri}")
            sc4(4, action, color="FCD34D")
            sc4(8, affected, align="center", color="94A3B8")

        # ── Column widths ────────────────────────────────────────────────────────
        for ci, w in enumerate([22, 10, 16, 14, 14, 14, 14, 38], 1):
            ms1.column_dimensions[get_column_letter(ci)].width = w

        # ── Sheet 2: Daily Trend ────────────────────────────────────────────────
        ms2 = wb_m.create_sheet("Daily Trend")
        ms2.sheet_view.showGridLines = False
        ms2.tab_color = "10B981"

        ms2.row_dimensions[1].height = 26
        ms2.merge_cells("A1:G1")
        t2 = ms2["A1"]
        t2.value = f"DAILY COMPLIANCE SCORES — {month_label.upper()}"
        t2.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
        t2.fill = mfill(DARK_BG)
        t2.alignment = Alignment(horizontal="center", vertical="center")

        mhdr(ms2, 2, ["Date", "Overall", "Patch (35%)", "Vuln (25%)", "Config (20%)", "Protection (10%)", "License (10%)"])
        ms2.row_dimensions[2].height = 30

        if daily_map:
            for row_i, snap_date in enumerate(sorted(daily_map.keys()), 3):
                scores = daily_map[snap_date]
                dc = ms2.cell(row=row_i, column=1, value=snap_date)
                dc.font = Font(color="CBD5E1", size=10, name="Calibri")
                dc.fill = mfill(HDR_BG)
                dc.alignment = Alignment(horizontal="center", vertical="center")
                dc.border = mborder()
                for col_i, cat in enumerate(CATS_M, 2):
                    mscore(ms2, row_i, col_i, scores.get(cat))
        else:
            ms2.merge_cells("A3:G3")
            nc = ms2["A3"]
            nc.value = f"No daily snapshots recorded for {month_label}. Run a manual snapshot to start collecting data."
            nc.font = Font(color="64748B", size=10, name="Calibri")
            nc.fill = mfill(HDR_BG)
            nc.alignment = Alignment(horizontal="center", vertical="center")

        for ci, w in enumerate([14, 10, 14, 14, 14, 16, 16], 1):
            ms2.column_dimensions[get_column_letter(ci)].width = w

        # ── Sheet 3: Endpoint Evidence (reuse shared generation) ───────────────
        ms3 = wb_m.create_sheet("Endpoint Evidence")
        ms3.sheet_view.showGridLines = False
        ms3.tab_color = "3B82F6"

        ms3.merge_cells("A1:N1")
        t3 = ms3["A1"]
        t3.value = f"ENDPOINT COMPLIANCE EVIDENCE  —  Current State as of {today}"
        t3.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
        t3.fill = mfill(DARK_BG)
        t3.alignment = Alignment(horizontal="center", vertical="center")
        ms3.row_dimensions[1].height = 26

        headers3m = [
            "Hostname", "Display Name", "IP Address", "OS", "Agent Status",
            "Overall Score", "Compliant?",
            "Patch Score", "Crit Patches",
            "Vuln Score", "Crit CVEs", "High CVEs",
            "Config Score", "Config Fail",
            "Protection Score", "AV Status",
            "License Score", "Licenses Active", "Licenses Total",
            "Last Seen",
        ]
        mhdr(ms3, 2, headers3m)
        ms3.row_dimensions[2].height = 30

        for row_i, a in enumerate(evidence_rows, 3):
            def mtc(col, val, bold=False, color="CBD5E1", align="left"):
                c = ms3.cell(row=row_i, column=col, value=val)
                c.font = Font(bold=bold, color=color, size=9, name="Calibri")
                c.fill = mfill("1F2D1F" if a["compliant"] else "2D1F1F")
                c.alignment = Alignment(horizontal=align, vertical="center")
                c.border = mborder()
            for cell in ms3[row_i]:
                cell.fill = mfill("1F2D1F" if a["compliant"] else "2D1F1F")
            mtc(1, a["hostname"], bold=True, color="93C5FD")
            mtc(2, a["display_name"] or a["hostname"])
            mtc(3, a["ip_address"] or "—", align="center")
            mtc(4, a["os_type"] or "—", align="center")
            sc_color = "10B981" if a["agent_status"] == "online" else "64748B"
            mtc(5, a["agent_status"] or "—", color=sc_color, align="center")
            ov = a["overall_score"]
            oc = ms3.cell(row=row_i, column=6, value=round(ov, 1))
            oc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
            oc.fill = mfill(_xlsx_color(ov))
            oc.alignment = Alignment(horizontal="center", vertical="center")
            oc.border = mborder()
            comp_color = "10B981" if a["compliant"] else "EF4444"
            mtc(7, "✓ Yes" if a["compliant"] else "✗ No", bold=True, color=comp_color, align="center")
            for col_idx, score_key in [(8, "patch_score"), (10, "vuln_score"), (13, "config_score"), (15, "protection_score"), (17, "license_score")]:
                sv = a.get(score_key)
                sc = ms3.cell(row=row_i, column=col_idx, value=round(sv, 1) if sv is not None else "—")
                sc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
                sc.fill = mfill(_xlsx_color(sv))
                sc.alignment = Alignment(horizontal="center", vertical="center")
                sc.border = mborder()
            mtc(9,  a["critical_patches"], color="EF4444" if a["critical_patches"] > 0 else "10B981", align="center")
            mtc(11, a["crit_vulns"],       color="EF4444" if a["crit_vulns"] > 0 else "10B981", align="center")
            mtc(12, a["high_vulns"],       color="F59E0B" if a["high_vulns"] > 0 else "10B981", align="center")
            mtc(14, a.get("config_fail") or 0, color="EF4444" if (a.get("config_fail") or 0) > 0 else "10B981", align="center")
            av_c = "10B981" if a["av_status"] == "pass" else "EF4444"
            mtc(16, "Protected" if a["av_status"] == "pass" else "Unprotected", color=av_c, align="center")
            mtc(18, a["lic_activated"], align="center")
            mtc(19, a["lic_total"],     align="center")
            mtc(20, str(a["last_seen"])[:16] if a["last_seen"] else "—", align="center")

        for ci, w in enumerate([18, 18, 14, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12, 12, 12, 12, 12, 18], 1):
            ms3.column_dimensions[get_column_letter(ci)].width = w

        # ── Sheet 4: Non-Compliant Agents ──────────────────────────────────────
        non_comp_m = [a for a in evidence_rows if not a["compliant"]]
        ms4 = wb_m.create_sheet("Non-Compliant Agents")
        ms4.sheet_view.showGridLines = False
        ms4.tab_color = "EF4444"

        ms4.merge_cells("A1:L1")
        t4 = ms4["A1"]
        t4.value = f"NON-COMPLIANT ENDPOINTS  —  {len(non_comp_m)} agents below 80%  |  {month_label}"
        t4.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
        t4.fill = mfill("450A0A")
        t4.alignment = Alignment(horizontal="center", vertical="center")
        ms4.row_dimensions[1].height = 26

        if non_comp_m:
            mhdr(ms4, 2, ["Hostname", "IP Address", "OS", "Overall Score",
                           "Patch Score", "Vuln Score", "Config Score", "Protection Score",
                           "Crit Patches", "Crit CVEs", "AV Status", "Recommended Action"], bg="450A0A")
            ms4.row_dimensions[2].height = 30
            for row_i, a in enumerate(non_comp_m, 3):
                def mr4(col, val, bold=False, color="CBD5E1", align="left"):
                    c = ms4.cell(row=row_i, column=col, value=val)
                    c.font = Font(bold=bold, color=color, size=9, name="Calibri")
                    c.fill = mfill("2D1F1F")
                    c.alignment = Alignment(horizontal=align, vertical="center")
                    c.border = mborder()
                mr4(1, a["hostname"], bold=True, color="FCA5A5")
                mr4(2, a["ip_address"] or "—", align="center")
                mr4(3, a["os_type"] or "—", align="center")
                oc4 = ms4.cell(row=row_i, column=4, value=round(a["overall_score"], 1))
                oc4.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
                oc4.fill = mfill(_xlsx_color(a["overall_score"]))
                oc4.alignment = Alignment(horizontal="center", vertical="center")
                oc4.border = mborder()
                for col_i, sk in [(5, "patch_score"), (6, "vuln_score"), (7, "config_score"), (8, "protection_score")]:
                    sv = a.get(sk)
                    sc = ms4.cell(row=row_i, column=col_i, value=round(sv, 1) if sv is not None else "—")
                    sc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
                    sc.fill = mfill(_xlsx_color(sv))
                    sc.alignment = Alignment(horizontal="center", vertical="center")
                    sc.border = mborder()
                mr4(9,  a["critical_patches"], color="EF4444" if a["critical_patches"] > 0 else "10B981", align="center")
                mr4(10, a["crit_vulns"],       color="EF4444" if a["crit_vulns"] > 0 else "10B981", align="center")
                av_c4 = "10B981" if a["av_status"] == "pass" else "EF4444"
                mr4(11, "Protected" if a["av_status"] == "pass" else "Unprotected", color=av_c4, align="center")
                actions = []
                if a["critical_patches"] > 0:
                    actions.append(f"Apply {a['critical_patches']} security patch(es)")
                if a["crit_vulns"] > 0:
                    actions.append(f"Remediate {a['crit_vulns']} critical CVE(s)")
                if a["av_status"] != "pass":
                    actions.append("Install/activate antivirus")
                if (a.get("config_score") or 100) < 80:
                    actions.append(f"Fix {a.get('config_fail', 0)} misconfig(s)")
                mr4(12, "; ".join(actions) if actions else "Review compliance details", color="FCD34D")
            for ci, w in enumerate([18, 14, 10, 12, 12, 12, 12, 14, 12, 10, 12, 42], 1):
                ms4.column_dimensions[get_column_letter(ci)].width = w
        else:
            ms4.merge_cells("A3:L3")
            nc4 = ms4["A3"]
            nc4.value = "✓ All endpoints are compliant — no action required."
            nc4.font = Font(bold=True, color="10B981", size=11, name="Calibri")
            nc4.fill = mfill(HDR_BG)
            nc4.alignment = Alignment(horizontal="center", vertical="center")

        # ── Sheet 5: Patch Compliance (per-endpoint) ───────────────────────────
        pcount_res = await db.execute(text("""
            SELECT agent_id,
                   COUNT(*)                                                   AS total,
                   COUNT(*) FILTER (WHERE LOWER(category) = 'security')       AS security_cnt,
                   COUNT(*) FILTER (WHERE LOWER(category) != 'security')      AS other_cnt,
                   MAX(scanned_at)                                             AS last_scan
            FROM agent_patches
            GROUP BY agent_id
        """))
        pcount_map = {str(r[0]): {"total": r[1], "security": r[2], "other": r[3], "last_scan": r[4]}
                      for r in pcount_res.fetchall()}

        ms5 = wb_m.create_sheet("Patch Compliance")
        ms5.sheet_view.showGridLines = False
        ms5.tab_color = "10B981"
        ms5.freeze_panes = "A3"

        ms5.row_dimensions[1].height = 28
        ms5.merge_cells("A1:L1")
        t5h = ms5["A1"]
        t5h.value = f"PATCH COMPLIANCE — PER ENDPOINT  |  {month_label}  |  As of {today.strftime('%d %b %Y')}"
        t5h.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
        t5h.fill = mfill("0D3321")
        t5h.alignment = Alignment(horizontal="center", vertical="center")

        mhdr(ms5, 2, [
            "Hostname", "Display Name", "IP Address", "OS", "Agent Status",
            "Patch Score", "Compliance", "Critical Pending",
            "Security Patches", "Other Patches", "Total Pending", "Last Scan",
        ], bg="0D3321")
        ms5.row_dimensions[2].height = 26

        sorted_evidence = sorted(evidence_rows, key=lambda a: (a.get("patch_score") or 0))
        for row_i, a in enumerate(sorted_evidence, 3):
            ms5.row_dimensions[row_i].height = 16
            p_info   = pcount_map.get(str(a.get("agent_id", "")), {})
            p_total  = p_info.get("total", 0)
            p_sec    = p_info.get("security", 0)
            p_other  = p_info.get("other", 0)
            p_scan   = p_info.get("last_scan")
            crit     = a["critical_patches"]
            pscore   = a.get("patch_score")
            compliant_patch = (pscore or 0) >= 80
            row_bg = "1F2D1F" if compliant_patch else "2D1F1F"

            def pc(col, val, bold=False, color="CBD5E1", align="left"):
                c = ms5.cell(row=row_i, column=col, value=val)
                c.font = Font(bold=bold, color=color, size=9, name="Calibri")
                c.fill = mfill(row_bg)
                c.alignment = Alignment(horizontal=align, vertical="center")
                c.border = mborder()

            pc(1, a["hostname"], bold=True, color="93C5FD")
            pc(2, a.get("display_name") or a["hostname"])
            pc(3, a["ip_address"] or "—", align="center")
            pc(4, a["os_type"] or "—", align="center")
            st_color = "10B981" if a["agent_status"] == "online" else "64748B"
            pc(5, a["agent_status"] or "—", color=st_color, align="center")
            sc_cell = ms5.cell(row=row_i, column=6, value=round(pscore, 1) if pscore is not None else "—")
            sc_cell.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
            sc_cell.fill = mfill(_xlsx_color(pscore))
            sc_cell.alignment = Alignment(horizontal="center", vertical="center")
            sc_cell.border = mborder()
            pc(7, "✓  Compliant" if compliant_patch else "✗  Non-Compliant",
               bold=True, color="10B981" if compliant_patch else "EF4444", align="center")
            pc(8,  crit,    color="EF4444" if crit > 0 else "10B981",    align="center", bold=crit > 0)
            pc(9,  p_sec,   color="F59E0B" if p_sec > 0 else "10B981",   align="center")
            pc(10, p_other, color="94A3B8",                               align="center")
            pc(11, p_total, color="CBD5E1",                               align="center")
            pc(12, str(p_scan)[:10] if p_scan else "No scan",             align="center", color="64748B")

        for ci, w in enumerate([20, 20, 14, 10, 12, 12, 16, 14, 14, 14, 14, 14], 1):
            ms5.column_dimensions[get_column_letter(ci)].width = w

        # ── Sheet 6: Patch History (per-host summary for the month) ───────────
        # Aggregate by host: patches done, patches failed, last scan, last patch done
        pjobs_res = await db.execute(text("""
            SELECT
                a.id AS agent_id,
                a.hostname, a.display_name, a.ip_address, a.os_type,
                -- Count individual packages installed (not sessions)
                COALESCE(SUM(ARRAY_LENGTH(pj.packages, 1))
                    FILTER (WHERE pj.status = 'success'), 0)            AS patches_done,
                -- Count failed sessions (can't know package-level failures)
                COUNT(*) FILTER (WHERE pj.status != 'success')          AS patches_failed,
                MAX(ap.scanned_at)                                       AS last_scan,
                MAX(pj.finished_at) FILTER (WHERE pj.status='success')  AS last_patch_done,
                BOOL_OR(pj.output LIKE '%RebootRequired: True%')         AS any_reboot,
                BOOL_OR(pj.output LIKE '%error%')                        AS any_error,
                COUNT(*) FILTER (WHERE pj.status != 'success') > 0      AS has_failures
            FROM agents a
            LEFT JOIN patch_jobs pj
                   ON pj.agent_id = a.id
                  AND pj.job_type = 'apply'
                  AND pj.started_at >= :start
                  AND pj.started_at < :end_excl
            LEFT JOIN (
                SELECT agent_id, MAX(scanned_at) AS scanned_at
                FROM agent_patches GROUP BY agent_id
            ) ap ON ap.agent_id = a.id
            WHERE a.is_active = TRUE
              AND a.exclude_from_reports = FALSE
              AND (pj.id IS NOT NULL OR ap.agent_id IS NOT NULL)
            GROUP BY a.id, a.hostname, a.display_name, a.ip_address, a.os_type
            ORDER BY patches_failed DESC, patches_done DESC, a.hostname
        """), {"start": month_start, "end_excl": month_end + timedelta(days=1)})
        pjob_rows = pjobs_res.fetchall()

        total_done   = sum(int(r[5] or 0) for r in pjob_rows)
        total_failed = sum(int(r[6] or 0) for r in pjob_rows)

        ms6 = wb_m.create_sheet("Patch History")
        ms6.sheet_view.showGridLines = False
        ms6.tab_color = "8B5CF6"
        ms6.freeze_panes = "A3"

        ms6.row_dimensions[1].height = 28
        ms6.merge_cells("A1:I1")
        t6h = ms6["A1"]
        t6h.value = (f"PATCH HISTORY — {month_label.upper()}  "
                     f"|  {total_done} packages applied  ·  {total_failed} failed session(s)  "
                     f"|  {len(pjob_rows)} hosts with activity")
        t6h.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
        t6h.fill = mfill("2E1065")
        t6h.alignment = Alignment(horizontal="center", vertical="center")

        mhdr(ms6, 2, [
            "Hostname", "Display Name", "IP Address", "OS",
            "Patches Done", "Patches Failed",
            "Last Patch Scan", "Last Patch Done", "Notes",
        ], bg="2E1065")
        ms6.row_dimensions[2].height = 26

        if pjob_rows:
            for row_i, pr in enumerate(pjob_rows, 3):
                _, hostname, display_name, ip, os_type, done, failed, last_scan, last_done, any_reboot, any_error, has_fail = pr
                ms6.row_dimensions[row_i].height = 16

                done   = int(done or 0)
                failed = int(failed or 0)
                has_any_fail = bool(has_fail) or failed > 0
                row_bg = "2D1A1F" if has_any_fail else "1A2D1F"

                # Build notes
                notes = []
                if any_reboot:  notes.append("Reboot required on some patches")
                if any_error:   notes.append("Errors in output — review logs")
                note_str = "; ".join(notes) if notes else ("All clean" if done > 0 else "—")

                def ph(col, val, bold=False, color="CBD5E1", align="left"):
                    c = ms6.cell(row=row_i, column=col, value=val)
                    c.font = Font(bold=bold, color=color, size=9, name="Calibri")
                    c.fill = mfill(row_bg)
                    c.alignment = Alignment(horizontal=align, vertical="center")
                    c.border = mborder()

                ph(1, hostname or "—",              bold=True, color="93C5FD")
                ph(2, display_name or hostname or "—")
                ph(3, ip or "—",                    align="center")
                ph(4, os_type or "—",               align="center")
                ph(5, done,   bold=done > 0,        color="10B981" if done > 0 else "64748B", align="center")
                ph(6, failed, bold=failed > 0,      color="EF4444" if failed > 0 else "10B981", align="center")
                ph(7, str(last_scan)[:10] if last_scan else "—",  align="center", color="64748B")
                ph(8, str(last_done)[:10] if last_done else "—",  align="center",
                   color="10B981" if last_done else "64748B")
                ph(9, note_str, color="64748B")

            for ci, w in enumerate([20, 20, 14, 10, 14, 14, 16, 16, 38], 1):
                ms6.column_dimensions[get_column_letter(ci)].width = w
        else:
            ms6.merge_cells("A3:I3")
            nopj = ms6["A3"]
            nopj.value = f"No patch activity recorded for {month_label}."
            nopj.font = Font(color="64748B", size=10, name="Calibri")
            nopj.fill = mfill(HDR_BG)
            nopj.alignment = Alignment(horizontal="center", vertical="center")

        # ── Sheet 7: Scoring Methodology ──────────────────────────────────────
        ms_ref = wb_m.create_sheet("Scoring Guide")
        ms_ref.sheet_view.showGridLines = False
        ms_ref.tab_color = "64748B"
        ms_ref.freeze_panes = "A4"

        def ref_fill(hex_color):
            return PatternFill("solid", fgColor=hex_color)
        def ref_border():
            s = Side(style="thin", color="334155")
            return Border(left=s, right=s, top=s, bottom=s)
        def rw(ws, row, col, val, bold=False, color="CBD5E1", bg=HDR_BG, align="left", size=10, wrap=False):
            c = ws.cell(row=row, column=col, value=val)
            c.font  = Font(bold=bold, color=color, size=size, name="Calibri")
            c.fill  = ref_fill(bg)
            c.alignment = Alignment(horizontal=align, vertical="center", wrap_text=wrap)
            c.border = ref_border()

        # Title
        ms_ref.row_dimensions[1].height = 34
        ms_ref.merge_cells("A1:H1")
        r = ms_ref["A1"]
        r.value = "COMPLIANCE SCORING METHODOLOGY  —  HOW YOUR SCORES ARE CALCULATED"
        r.font  = Font(bold=True, color=WHITE, size=16, name="Calibri")
        r.fill  = ref_fill(DARK_BG)
        r.alignment = Alignment(horizontal="center", vertical="center")

        ms_ref.row_dimensions[2].height = 14
        ms_ref.merge_cells("A2:H2")
        s2 = ms_ref["A2"]
        s2.value = ("This sheet explains how each compliance score is derived, "
                    "what data sources are queried, and what the thresholds mean.")
        s2.font  = Font(color=HDR_FG, size=9, italic=True, name="Calibri")
        s2.fill  = ref_fill(DARK_BG)
        s2.alignment = Alignment(horizontal="center", vertical="center")

        ms_ref.row_dimensions[3].height = 8
        for col in range(1, 9):
            ms_ref.cell(row=3, column=col).fill = ref_fill(DARK_BG)

        # ── Overall formula ────────────────────────────────────────────────────
        ms_ref.row_dimensions[4].height = 18
        ms_ref.merge_cells("A4:H4")
        b4 = ms_ref["A4"]
        b4.value = "  OVERALL SCORE FORMULA"
        b4.font  = Font(bold=True, color=BLUE, size=11, name="Calibri")
        b4.fill  = ref_fill(SUBHDR_BG)
        b4.alignment = Alignment(horizontal="left", vertical="center", indent=1)
        b4.border = ref_border()

        ms_ref.row_dimensions[5].height = 18
        ms_ref.merge_cells("A5:H5")
        f5 = ms_ref["A5"]
        f5.value = ("Overall  =  Patch × 35%  +  Vulnerability × 25%  +  "
                    "Configuration × 20%  +  Endpoint Protection × 10%  +  License × 10%")
        f5.font  = Font(bold=True, color="FCD34D", size=11, name="Calibri")
        f5.fill  = ref_fill("0B1120")
        f5.alignment = Alignment(horizontal="center", vertical="center")
        f5.border = ref_border()

        ms_ref.row_dimensions[6].height = 18
        ms_ref.merge_cells("A6:H6")
        t6 = ms_ref["A6"]
        t6.value = "Compliant threshold:  ≥ 80 points out of 100"
        t6.font  = Font(color="10B981", size=10, name="Calibri")
        t6.fill  = ref_fill("0B1120")
        t6.alignment = Alignment(horizontal="center", vertical="center")
        t6.border = ref_border()

        ms_ref.row_dimensions[7].height = 8
        for col in range(1, 9):
            ms_ref.cell(row=7, column=col).fill = ref_fill(DARK_BG)

        # ── Per-category detail ────────────────────────────────────────────────
        ms_ref.row_dimensions[8].height = 18
        ms_ref.merge_cells("A8:H8")
        b8 = ms_ref["A8"]
        b8.value = "  CATEGORY BREAKDOWN"
        b8.font  = Font(bold=True, color=BLUE, size=11, name="Calibri")
        b8.fill  = ref_fill(SUBHDR_BG)
        b8.alignment = Alignment(horizontal="left", vertical="center", indent=1)
        b8.border = ref_border()

        mhdr(ms_ref, 9, ["Category", "Weight", "Formula", "Data Source (table)",
                          "Numerator", "Denominator", "Score Range", "Compliant If"], bg=SUBHDR_BG)
        ms_ref.row_dimensions[9].height = 26

        methodology = [
            (
                "Patch Compliance", "35%",
                "100 if critical_pending = 0, else 0",
                "agent_patches",
                "Agents with 0 security-category patches pending",
                "All active enrolled agents",
                "0 or 100  (binary per agent, averaged)",
                "Score ≥ 80%  (i.e. ≥80% of agents fully patched)",
            ),
            (
                "Vulnerability Mgmt", "25%",
                "max(0,  100 − (critical × 20) − (high × 10))",
                "agent_vulnerabilities",
                "100 minus deductions for open CVEs",
                "N/A  (score per agent, then fleet-averaged)",
                "0 – 100  (capped at 0, can't go negative)",
                "Score ≥ 80%  (≤1 critical or ≤2 high CVEs open)",
            ),
            (
                "Configuration", "20%",
                "passed_checks / total_checks × 100",
                "agent_misconfigs",
                "Checks with status = 'pass'",
                "All applicable security policy rules per agent",
                "0 – 100",
                "Score ≥ 80%  (≥80% of policy rules passing)",
            ),
            (
                "Endpoint Protection", "10%",
                "agents_protected / total_windows_agents × 100",
                "agent_security_state",
                "Windows agents with AV running AND firewall enabled",
                "All Windows agents  (Linux agents = always counted as protected)",
                "0 – 100",
                "Score ≥ 80%  (≥80% of Windows endpoints protected)",
            ),
            (
                "License Compliance", "10%",
                "activated_licences / total_licences × 100",
                "agent_licenses",
                "Licences with activation_status = 'activated'",
                "All licence records detected across fleet",
                "0 – 100",
                "Score ≥ 80%  (≥80% of tracked licences activated)",
            ),
        ]
        cat_colors = {
            "Patch Compliance":      "10B981",
            "Vulnerability Mgmt":    "F59E0B",
            "Configuration":         "8B5CF6",
            "Endpoint Protection":   "EF4444",
            "License Compliance":    "06B6D4",
        }
        for ri, row_data in enumerate(methodology, 10):
            cat, weight, formula, source, num, den, rng, threshold = row_data
            ms_ref.row_dimensions[ri].height = 36
            c_color = cat_colors.get(cat, "CBD5E1")
            rw(ms_ref, ri, 1, cat,       bold=True,  color=c_color,   bg="0B1120")
            rw(ms_ref, ri, 2, weight,    bold=True,  color="94A3B8",  bg="0B1120", align="center")
            rw(ms_ref, ri, 3, formula,   bold=False, color="FCD34D",  bg="0B1120", wrap=True)
            rw(ms_ref, ri, 4, source,    bold=True,  color="94A3B8",  bg="0B1120", align="center")
            rw(ms_ref, ri, 5, num,       color="CBD5E1", bg="0B1120", wrap=True)
            rw(ms_ref, ri, 6, den,       color="64748B", bg="0B1120", wrap=True)
            rw(ms_ref, ri, 7, rng,       color="94A3B8", bg="0B1120", align="center")
            rw(ms_ref, ri, 8, threshold, color="10B981", bg="0B1120", wrap=True)

        ms_ref.row_dimensions[15].height = 8
        for col in range(1, 9):
            ms_ref.cell(row=15, column=col).fill = ref_fill(DARK_BG)

        # ── Score colour bands ─────────────────────────────────────────────────
        ms_ref.row_dimensions[16].height = 18
        ms_ref.merge_cells("A16:H16")
        b16 = ms_ref["A16"]
        b16.value = "  SCORE COLOUR BANDS  (used in all score cells across the report)"
        b16.font  = Font(bold=True, color=BLUE, size=11, name="Calibri")
        b16.fill  = ref_fill(SUBHDR_BG)
        b16.alignment = Alignment(horizontal="left", vertical="center", indent=1)
        b16.border = ref_border()

        mhdr(ms_ref, 17, ["Colour", "Score Range", "Meaning", "Action Required",
                           "", "", "", ""], bg=SUBHDR_BG)
        ms_ref.row_dimensions[17].height = 22
        bands = [
            ("Green",  "80 – 100",  "Compliant — meets security threshold",        "None — maintain posture"),
            ("Amber",  "60 – 79",   "Approaching threshold — monitor closely",      "Review and improve within 30 days"),
            ("Red",    "0 – 59",    "Non-Compliant — below minimum threshold",      "Immediate remediation required"),
        ]
        band_colors = {"Green": "166534", "Amber": "854D0E", "Red": "991B1B"}
        band_bgs    = {"Green": "1F2D1F", "Amber": "2D1A00", "Red": "2D1F1F"}
        for ri, (band, score_rng, meaning, action) in enumerate(bands, 18):
            ms_ref.row_dimensions[ri].height = 18
            bg = band_bgs[band]
            rw(ms_ref, ri, 1, band,      bold=True, color=band_colors[band], bg=bg, align="center")
            rw(ms_ref, ri, 2, score_rng, bold=True, color=band_colors[band], bg=bg, align="center")
            ms_ref.merge_cells(f"C{ri}:E{ri}")
            rw(ms_ref, ri, 3, meaning,   color="CBD5E1", bg=bg)
            ms_ref.merge_cells(f"F{ri}:H{ri}")
            rw(ms_ref, ri, 6, action,    color="64748B", bg=bg)

        ms_ref.row_dimensions[21].height = 8
        for col in range(1, 9):
            ms_ref.cell(row=21, column=col).fill = ref_fill(DARK_BG)

        # ── Security policy checks (misconfig rules) ───────────────────────────
        ms_ref.row_dimensions[22].height = 18
        ms_ref.merge_cells("A22:H22")
        b22 = ms_ref["A22"]
        b22.value = "  CONFIGURATION CHECKS — WHAT IS TESTED"
        b22.font  = Font(bold=True, color=BLUE, size=11, name="Calibri")
        b22.fill  = ref_fill(SUBHDR_BG)
        b22.alignment = Alignment(horizontal="left", vertical="center", indent=1)
        b22.border = ref_border()

        mhdr(ms_ref, 23, ["Check", "Platform", "What Is Tested", "Why It Matters",
                           "", "", "", ""], bg=SUBHDR_BG)
        ms_ref.row_dimensions[23].height = 22

        checks = [
            ("Firewall Status",    "All",     "OS firewall is enabled and active",               "Prevents unauthorized network access"),
            ("RDP Access Control", "Windows", "Remote Desktop is disabled or access is restricted","Open RDP is the #1 ransomware entry point"),
            ("Guest Account",      "Windows", "Built-in Guest account is disabled",               "Guest accounts bypass authentication controls"),
            ("SMBv1 Protocol",     "Windows", "SMBv1 (legacy file sharing) is disabled",          "SMBv1 is exploited by WannaCry and similar worms"),
            ("Audit Logging",      "Windows", "Security event auditing is enabled",               "Required for incident detection and forensics"),
            ("Automatic Updates",  "All",     "OS automatic updates are enabled",                 "Ensures security patches are applied promptly"),
            ("Disk Encryption",    "All",     "Full disk encryption is active (BitLocker/LUKS)",  "Protects data if device is stolen or lost"),
            ("Antivirus Active",   "Windows", "AV product is installed and real-time protection on","First line of defence against malware"),
            ("SSH Root Login",     "Linux",   "SSH root login is disabled (PermitRootLogin=no)",   "Prevents brute-force root compromise via SSH"),
            ("SELinux/AppArmor",   "Linux",   "Mandatory Access Control is enforced",             "Limits blast radius of application exploits"),
            ("Password Policy",    "Windows", "Minimum password length ≥ 8, complexity enabled",  "Weak passwords enable credential attacks"),
        ]
        for ri, (check, platform, tested, why) in enumerate(checks, 24):
            ms_ref.row_dimensions[ri].height = 18
            rw(ms_ref, ri, 1, check,    bold=True, color="93C5FD", bg=HDR_BG)
            rw(ms_ref, ri, 2, platform, color="94A3B8", bg=HDR_BG, align="center")
            ms_ref.merge_cells(f"C{ri}:E{ri}")
            rw(ms_ref, ri, 3, tested, color="CBD5E1", bg=HDR_BG)
            ms_ref.merge_cells(f"F{ri}:H{ri}")
            rw(ms_ref, ri, 6, why, color="64748B", bg=HDR_BG, wrap=True)

        # Column widths
        for ci, w in enumerate([22, 10, 28, 22, 20, 20, 14, 30], 1):
            ms_ref.column_dimensions[get_column_letter(ci)].width = w

        # ── Sheet 8: Patch Backlog ─────────────────────────────────────────────
        # Shows ALL pending patches (not filtered by date — agent_patches is a
        # live pending list; the most recent scan supersedes earlier entries).
        patch_res = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.ip_address, a.os_type,
                   p.package_name, p.current_version, p.available_version,
                   p.category, p.description, p.scanned_at
            FROM agent_patches p
            JOIN agents a ON a.id = p.agent_id
            WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
            ORDER BY p.category DESC, a.hostname, p.package_name
        """))
        patch_rows = patch_res.fetchall()

        security_count = sum(1 for r in patch_rows if (r[7] or "").lower() == "security")
        upgrade_count  = len(patch_rows) - security_count

        ms7 = wb_m.create_sheet("Patch Backlog")
        ms7.sheet_view.showGridLines = False
        ms7.tab_color = "F59E0B"
        ms7.freeze_panes = "A3"

        ms7.row_dimensions[1].height = 30
        ms7.merge_cells("A1:J1")
        t7 = ms7["A1"]
        t7.value = (f"PENDING PATCH BACKLOG  —  {len(patch_rows)} total patches  "
                    f"({security_count} security  ·  {upgrade_count} upgrades)  "
                    f"·  As of {today.strftime('%d %b %Y')}")
        t7.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
        t7.fill = mfill("451A03")
        t7.alignment = Alignment(horizontal="center", vertical="center")

        mhdr(ms7, 2, [
            "Hostname", "Display Name", "IP Address", "OS",
            "Package / Update", "Current Version", "Available Version",
            "Category", "Description", "Last Scanned",
        ], bg="451A03")
        ms7.row_dimensions[2].height = 26

        if patch_rows:
            for row_i, pr in enumerate(patch_rows, 3):
                hostname, display_name, ip, os_type, pkg, cur_ver, avail_ver, cat, desc, scanned = pr
                is_security = (cat or "").lower() == "security"
                row_bg = "2D1A00" if is_security else HDR_BG

                def mp(col, val, bold=False, color="CBD5E1", align="left"):
                    c = ms7.cell(row=row_i, column=col, value=val)
                    c.font = Font(bold=bold, color=color, size=9, name="Calibri")
                    c.fill = mfill(row_bg)
                    c.alignment = Alignment(horizontal=align, vertical="center")
                    c.border = mborder()

                mp(1,  hostname or "—",      bold=True, color="93C5FD")
                mp(2,  display_name or hostname or "—")
                mp(3,  ip or "—",            align="center")
                mp(4,  os_type or "—",       align="center")
                mp(5,  pkg or "—",           bold=True, color="FCD34D" if is_security else "CBD5E1")
                mp(6,  cur_ver or "—",       align="center")
                mp(7,  avail_ver or "—",     align="center", color="FCD34D")
                cat_color = "EF4444" if is_security else "94A3B8"
                mp(8,  (cat or "—").title(), align="center", color=cat_color, bold=is_security)
                mp(9,  desc or "—",          color="64748B")
                mp(10, str(scanned)[:10] if scanned else "—", align="center")

            for ci, w in enumerate([20, 20, 14, 10, 32, 16, 16, 12, 40, 14], 1):
                ms7.column_dimensions[get_column_letter(ci)].width = w
        else:
            ms7.merge_cells("A3:J3")
            ncp = ms7["A3"]
            ncp.value = "✓  No pending patches found — all endpoints are up to date."
            ncp.font = Font(bold=True, color="10B981", size=10, name="Calibri")
            ncp.fill = mfill(HDR_BG)
            ncp.alignment = Alignment(horizontal="center", vertical="center")

        # ── Sheet 9: End of Life ────────────────────────────────────────────────
        # Identify agents running OS versions past vendor end-of-life date.
        eol_res = await db.execute(text("""
            SELECT hostname, display_name, ip_address, os_type, os_name, os_version, last_seen
            FROM agents
            WHERE is_active = TRUE AND exclude_from_reports = FALSE
            ORDER BY os_type, os_name, hostname
        """))
        eol_rows_raw = eol_res.fetchall()

        eol_detections = []
        for row in eol_rows_raw:
            hostname, display_name, ip_address, os_type, os_name, os_ver, last_seen = row
            os_lower = (os_name or "").lower()
            eol_reason = None
            risk_level = "Critical"

            if os_type == "windows":
                if any(x in os_lower for x in ("2003", "xp", "vista", "windows me", "windows 2000")):
                    eol_reason = "End-of-life since 2015 or earlier"
                    risk_level = "Critical"
                elif any(x in os_lower for x in ("2008", "windows 7")):
                    eol_reason = "End-of-life since January 2020"
                    risk_level = "Critical"
                elif any(x in os_lower for x in ("windows 8", "2012")):
                    eol_reason = "End-of-life since October 2023"
                    risk_level = "Critical"
            elif os_type == "linux":
                if "ubuntu 18.04" in os_lower or "bionic" in os_lower:
                    eol_reason = "Standard support ended April 2023 (Ubuntu 18.04)"
                    risk_level = "High"
                elif "ubuntu 16.04" in os_lower or "xenial" in os_lower:
                    eol_reason = "End-of-life since April 2021 (Ubuntu 16.04)"
                    risk_level = "Critical"
                elif "ubuntu 14.04" in os_lower or "trusty" in os_lower:
                    eol_reason = "End-of-life since April 2019 (Ubuntu 14.04)"
                    risk_level = "Critical"
                elif "centos linux 8" in os_lower or "centos 8" in os_lower:
                    eol_reason = "End-of-life since December 2021 (CentOS 8)"
                    risk_level = "Critical"
                elif "centos linux 7" in os_lower or "centos 7" in os_lower:
                    eol_reason = "End-of-life since June 2024 (CentOS 7)"
                    risk_level = "Critical"
                elif "centos linux 6" in os_lower or "centos 6" in os_lower:
                    eol_reason = "End-of-life since November 2020 (CentOS 6)"
                    risk_level = "Critical"
                elif "rhel 6" in os_lower or "red hat enterprise linux 6" in os_lower:
                    eol_reason = "End-of-life since November 2020 (RHEL 6)"
                    risk_level = "Critical"
                elif "debian 9" in os_lower or "stretch" in os_lower:
                    eol_reason = "End-of-life since June 2022 (Debian 9)"
                    risk_level = "High"
                elif "debian 10" in os_lower or "buster" in os_lower:
                    eol_reason = "End-of-life since June 2024 (Debian 10)"
                    risk_level = "Critical"
                elif "suse linux enterprise server 12" in os_lower or "sles 12" in os_lower:
                    eol_reason = "EOL SP4 Jun 2024; SP5 extended to Oct 2027 (SLES 12)"
                    risk_level = "High"

            if eol_reason:
                eol_detections.append({
                    "hostname": display_name or hostname,
                    "ip_address": str(ip_address) if ip_address else "—",
                    "os_type": (os_type or "").title(),
                    "os_name": os_name or "—",
                    "os_version": os_ver or "—",
                    "eol_reason": eol_reason,
                    "risk_level": risk_level,
                    "last_seen": str(last_seen)[:16] if last_seen else "—",
                    "action": "Upgrade OS immediately — no vendor security patches available",
                })

        ms8 = wb_m.create_sheet("End of Life")
        ms8.sheet_view.showGridLines = False
        ms8.tab_color = "DC2626"
        ms8.freeze_panes = "A3"

        ms8.row_dimensions[1].height = 30
        ms8.merge_cells("A1:H1")
        t8 = ms8["A1"]
        t8.value = (f"END-OF-LIFE ENDPOINTS  —  {len(eol_detections)} endpoint(s) running unsupported OS"
                    f"  |  {month_label}")
        t8.font = Font(bold=True, color=WHITE, size=12, name="Calibri")
        t8.fill = PatternFill("solid", fgColor="7F1D1D")
        t8.alignment = Alignment(horizontal="center", vertical="center")

        mhdr(ms8, 2, [
            "Hostname / Display Name", "IP Address", "OS Type", "OS Name",
            "OS Version", "EOL Reason", "Risk Level", "Last Seen", "Required Action",
        ], bg="7F1D1D")
        ms8.row_dimensions[2].height = 26

        def m8c(col, val, bold=False, color="CBD5E1", align="left"):
            c = ms8.cell(row=row_i, column=col, value=val)
            c.font = Font(bold=bold, color=color, size=9, name="Calibri")
            c.fill = mfill(row_bg)
            c.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)
            c.border = mborder()
            return c

        if eol_detections:
            for row_i, eol in enumerate(eol_detections, 3):
                row_bg = "0F172A" if row_i % 2 == 0 else HDR_BG
                risk_color = "EF4444" if eol["risk_level"] == "Critical" else "F59E0B"
                m8c(1, eol["hostname"],    bold=True, color="F1F5F9")
                m8c(2, eol["ip_address"],  color="94A3B8", align="center")
                m8c(3, eol["os_type"],     color="94A3B8", align="center")
                m8c(4, eol["os_name"],     color="CBD5E1")
                m8c(5, eol["os_version"],  color="94A3B8")
                m8c(6, eol["eol_reason"],  color="FCD34D")
                rc = ms8.cell(row=row_i, column=7, value=eol["risk_level"])
                rc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
                rc.fill = PatternFill("solid", fgColor=risk_color)
                rc.alignment = Alignment(horizontal="center", vertical="center")
                rc.border = mborder()
                m8c(8, eol["last_seen"],   color="94A3B8", align="center")
                m8c(9, eol["action"],      color="FCA5A5")
            for ci, w in enumerate([28, 14, 10, 28, 16, 44, 10, 14, 42], 1):
                ms8.column_dimensions[get_column_letter(ci)].width = w
        else:
            ms8.merge_cells("A3:I3")
            nc8 = ms8["A3"]
            nc8.value = "✓  No end-of-life endpoints detected — all managed systems run supported OS versions."
            nc8.font = Font(bold=True, color="10B981", size=10, name="Calibri")
            nc8.fill = mfill(HDR_BG)
            nc8.alignment = Alignment(horizontal="center", vertical="center")

        # ── Sheet 10: Unactivated Endpoints ────────────────────────────────────
        # Machines that have software with unactivated or missing licenses.
        unact_res = await db.execute(text("""
            SELECT
                a.hostname, a.display_name, a.ip_address, a.os_type, a.os_name,
                l.software_name, l.license_type, l.partial_key,
                l.activation_status, l.expiry_date, l.detected_at
            FROM agents a
            JOIN agent_licenses l ON l.agent_id = a.id
            WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
              AND (l.activation_status IS NULL OR l.activation_status != 'activated')
            ORDER BY a.hostname, l.software_name
        """))
        unact_rows = unact_res.fetchall()

        ms9 = wb_m.create_sheet("Unactivated Endpoints")
        ms9.sheet_view.showGridLines = False
        ms9.tab_color = "D97706"
        ms9.freeze_panes = "A3"

        # Count distinct hosts
        unact_hosts = len({r[0] for r in unact_rows})

        ms9.row_dimensions[1].height = 30
        ms9.merge_cells("A1:K1")
        t9 = ms9["A1"]
        t9.value = (f"UNACTIVATED ENDPOINTS  —  {len(unact_rows)} unactivated licence(s) across "
                    f"{unact_hosts} host(s)  |  {month_label}")
        t9.font = Font(bold=True, color=WHITE, size=12, name="Calibri")
        t9.fill = PatternFill("solid", fgColor="78350F")
        t9.alignment = Alignment(horizontal="center", vertical="center")

        mhdr(ms9, 2, [
            "Hostname", "Display Name", "IP Address", "OS Type", "OS Name",
            "Software / Product", "Licence Type", "Partial Key",
            "Activation Status", "Expiry Date", "Detected",
        ], bg="78350F")
        ms9.row_dimensions[2].height = 26

        def m9c(col, val, bold=False, color="CBD5E1", align="left"):
            c = ms9.cell(row=row_i, column=col, value=val)
            c.font = Font(bold=bold, color=color, size=9, name="Calibri")
            c.fill = mfill(row_bg)
            c.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)
            c.border = mborder()
            return c

        if unact_rows:
            for row_i, ur in enumerate(unact_rows, 3):
                row_bg = "0F172A" if row_i % 2 == 0 else HDR_BG
                status_val = ur[8] or "unknown"
                status_color = "EF4444" if status_val != "activated" else "10B981"
                m9c(1,  ur[0],  bold=True, color="F1F5F9")
                m9c(2,  ur[1] or ur[0], color="CBD5E1")
                m9c(3,  str(ur[2]) if ur[2] else "—", color="94A3B8", align="center")
                m9c(4,  (ur[3] or "").title(), color="94A3B8", align="center")
                m9c(5,  ur[4] or "—", color="CBD5E1")
                m9c(6,  ur[5] or "—", bold=True, color="FCD34D")
                m9c(7,  ur[6] or "—", color="94A3B8", align="center")
                m9c(8,  ur[7] or "—", color="94A3B8", align="center")
                sc = ms9.cell(row=row_i, column=9, value=status_val.title())
                sc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
                sc.fill = PatternFill("solid", fgColor=status_color)
                sc.alignment = Alignment(horizontal="center", vertical="center")
                sc.border = mborder()
                expiry = ur[9]
                expiry_str = str(expiry)[:10] if expiry else "—"
                m9c(10, expiry_str, color="FCA5A5" if expiry else "94A3B8", align="center")
                detected = ur[10]
                m9c(11, str(detected)[:10] if detected else "—", color="94A3B8", align="center")
            for ci, w in enumerate([20, 20, 14, 10, 20, 32, 16, 18, 16, 14, 12], 1):
                ms9.column_dimensions[get_column_letter(ci)].width = w
        else:
            ms9.merge_cells("A3:K3")
            nc9 = ms9["A3"]
            nc9.value = "✓  All detected software licences are activated."
            nc9.font = Font(bold=True, color="10B981", size=10, name="Calibri")
            nc9.fill = mfill(HDR_BG)
            nc9.alignment = Alignment(horizontal="center", vertical="center")

        buf_m = io.BytesIO()
        wb_m.save(buf_m)
        buf_m.seek(0)
        filename_m = f"risk_review_{month_start.strftime('%Y-%m')}.xlsx"
        return StreamingResponse(
            buf_m,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename_m}"'},
        )

    # ── Workbook styling helpers ────────────────────────────────────────────────
    wb = openpyxl.Workbook()
    wb.remove(wb.active)  # remove default sheet

    def hdr_font(bold=True, color=WHITE, size=10):
        return Font(bold=bold, color=color, size=size, name="Calibri")

    def cell_font(bold=False, color="CBD5E1", size=10):
        return Font(bold=bold, color=color, size=size, name="Calibri")

    def fill(hex_color):
        return PatternFill("solid", fgColor=hex_color)

    def thin_border():
        s = Side(style="thin", color=SLATE)
        return Border(left=s, right=s, top=s, bottom=s)

    def set_col_widths(ws, widths: list[float]):
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

    def write_header_row(ws, row_num, headers, bg=HDR_BG):
        for col, h in enumerate(headers, 1):
            c = ws.cell(row=row_num, column=col, value=h)
            c.font = hdr_font(color=HDR_FG)
            c.fill = fill(bg)
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            c.border = thin_border()

    def score_cell(ws, row, col, score):
        c = ws.cell(row=row, column=col, value=score)
        c.font = Font(bold=True, color=WHITE, size=10, name="Calibri")
        c.fill = fill(_xlsx_color(score))
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = thin_border()
        return c

    def text_cell(ws, row, col, value, bold=False, color="CBD5E1", align="left", bg=HDR_BG):
        c = ws.cell(row=row, column=col, value=value)
        c.font = Font(bold=bold, color=color, size=10, name="Calibri")
        c.fill = fill(bg)
        c.alignment = Alignment(horizontal=align, vertical="center")
        c.border = thin_border()
        return c

    # ── Sheet 1: Executive Summary ──────────────────────────────────────────────
    ws1 = wb.create_sheet("Executive Summary")
    ws1.sheet_view.showGridLines = False
    ws1.tab_color = BLUE

    # Title block
    ws1.row_dimensions[1].height = 30
    ws1.merge_cells("A1:F1")
    t = ws1["A1"]
    t.value = "QUARTERLY RISK REVIEW REPORT"
    t.font = Font(bold=True, color=WHITE, size=16, name="Calibri")
    t.fill = fill(DARK_BG)
    t.alignment = Alignment(horizontal="center", vertical="center")

    ws1.merge_cells("A2:F2")
    sub = ws1["A2"]
    sub.value = f"Generated: {today.strftime('%d %B %Y')}  |  Kifaa Endpoint Management Platform"
    sub.font = Font(color=HDR_FG, size=10, name="Calibri")
    sub.fill = fill(DARK_BG)
    sub.alignment = Alignment(horizontal="center", vertical="center")

    # Current quarter summary
    ws1.row_dimensions[4].height = 18
    ws1.merge_cells("A4:F4")
    sh = ws1["A4"]
    sh.value = f"CURRENT QUARTER SCORECARD  —  {quarters_out[-1]['quarter'] if quarters_out else ''}"
    sh.font = hdr_font(color=BLUE, size=11)
    sh.fill = fill(SUBHDR_BG)
    sh.alignment = Alignment(horizontal="left", vertical="center")

    current_q = quarters_out[-1] if quarters_out else {}
    summary_data = [
        ("Overall Score",           current_q.get("overall"),      "Weight: combined"),
        ("Patch Compliance",        current_q.get("patch"),         "Weight: 35%"),
        ("Vulnerability Mgmt",      current_q.get("vulnerability"), "Weight: 25%"),
        ("Configuration",           current_q.get("configuration"), "Weight: 20%"),
        ("Endpoint Protection",     current_q.get("protection"),    "Weight: 10%"),
        ("License Compliance",      current_q.get("license"),       "Weight: 10%"),
    ]
    write_header_row(ws1, 5, ["Category", "Score", "Status", "vs Previous", "Weight", "Notes"])
    for row_i, (label, score, note) in enumerate(summary_data, 6):
        prev_cat = list(CATS)[row_i - 6]
        prev_val = current_q.get(f"{prev_cat}_prev")
        trend    = current_q.get(f"{prev_cat}_trend", "new")
        diff_str = ""
        if prev_val is not None and score is not None:
            diff = score - prev_val
            diff_str = f"{'+' if diff >= 0 else ''}{diff:.1f}%"
        status_str = "Compliant" if (score or 0) >= 80 else "Non-Compliant" if score is not None else "—"

        text_cell(ws1, row_i, 1, label, bold=(row_i == 6))
        score_cell(ws1, row_i, 2, round(score, 1) if score is not None else None)
        text_cell(ws1, row_i, 3, status_str,
                  color="166534" if (score or 0) >= 80 else "991B1B")
        text_cell(ws1, row_i, 4, diff_str or "—",
                  color="166534" if (prev_val or 0) <= (score or 0) else "991B1B", align="center")
        text_cell(ws1, row_i, 5, note, align="center")
        text_cell(ws1, row_i, 6, _trend_label(trend))

    # Endpoint stats
    total_agents     = len(evidence_rows)
    compliant_agents = sum(1 for a in evidence_rows if a["compliant"])
    non_compliant    = total_agents - compliant_agents
    rate_pct         = round(compliant_agents / total_agents * 100, 1) if total_agents > 0 else 0

    ws1.row_dimensions[13].height = 18
    ws1.merge_cells("A13:F13")
    es = ws1["A13"]
    es.value = "ENDPOINT COMPLIANCE SUMMARY"
    es.font = hdr_font(color=BLUE, size=11)
    es.fill = fill(SUBHDR_BG)
    es.alignment = Alignment(horizontal="left", vertical="center")

    write_header_row(ws1, 14, ["Metric", "Value", "", "", "", ""])
    for row_i, (label, val) in enumerate([
        ("Total Endpoints",          total_agents),
        ("Compliant (≥80%)",         compliant_agents),
        ("Non-Compliant (<80%)",     non_compliant),
        ("Compliance Rate",          f"{rate_pct}%"),
        ("Report Date",              str(today)),
        ("Compliance Threshold",     "80%"),
    ], 15):
        text_cell(ws1, row_i, 1, label, bold=True)
        text_cell(ws1, row_i, 2, val,
                  color="166534" if label == "Compliant (≥80%)" and val > 0
                  else "991B1B" if label == "Non-Compliant (<80%)" and val > 0 else "CBD5E1",
                  align="center")
        for col in range(3, 7):
            text_cell(ws1, row_i, col, "")

    set_col_widths(ws1, [28, 14, 16, 14, 14, 28])

    # ── Sheet 2: Quarterly History ──────────────────────────────────────────────
    ws2 = wb.create_sheet("Quarterly History")
    ws2.sheet_view.showGridLines = False
    ws2.tab_color = "10B981"

    ws2.merge_cells("A1:I1")
    t2 = ws2["A1"]
    t2.value = "QUARTERLY COMPLIANCE SCORE HISTORY"
    t2.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
    t2.fill = fill(DARK_BG)
    t2.alignment = Alignment(horizontal="center", vertical="center")
    ws2.row_dimensions[1].height = 26

    headers2 = ["Quarter", "Overall", "Patch (35%)", "Vuln (25%)", "Config (20%)",
                "Protection (10%)", "License (10%)", "Overall Trend", "Notes"]
    write_header_row(ws2, 2, headers2)
    ws2.row_dimensions[2].height = 30

    for row_i, q in enumerate(quarters_out, 3):
        is_curr = q["is_current"]
        bg = SUBHDR_BG if is_curr else HDR_BG

        qname = q["quarter"] + (" ★ CURRENT" if is_curr else "")
        c = ws2.cell(row=row_i, column=1, value=qname)
        c.font = Font(bold=is_curr, color=BLUE if is_curr else "CBD5E1", size=10, name="Calibri")
        c.fill = fill(bg)
        c.alignment = Alignment(horizontal="left", vertical="center")
        c.border = thin_border()

        for col_i, cat in enumerate(CATS, 2):
            score_cell(ws2, row_i, col_i, q.get(cat))

        # Trend
        trend = q.get("overall_trend", "new")
        trend_colors = {"increasing": "166534", "decreasing": "991B1B", "stagnant": "854D0E", "new": "475569"}
        tc = ws2.cell(row=row_i, column=8, value=_trend_label(trend))
        tc.font = Font(bold=True, color=trend_colors.get(trend, "CBD5E1"), size=10, name="Calibri")
        tc.fill = fill(bg)
        tc.alignment = Alignment(horizontal="center", vertical="center")
        tc.border = thin_border()

        # Notes: diff vs previous
        overall_s = q.get("overall")
        overall_p = q.get("overall_prev")
        note = ""
        if overall_s is not None and overall_p is not None:
            diff = overall_s - overall_p
            note = f"{'Improved' if diff >= 0 else 'Declined'} by {abs(diff):.1f}% from {quarters_out[row_i - 4]['quarter'] if row_i >= 4 else 'prior'}"
        nc = ws2.cell(row=row_i, column=9, value=note)
        nc.font = cell_font(color="64748B")
        nc.fill = fill(bg)
        nc.alignment = Alignment(horizontal="left", vertical="center")
        nc.border = thin_border()

    set_col_widths(ws2, [20, 10, 14, 14, 14, 16, 16, 16, 40])

    # ── Sheet 3: Per-Agent Evidence ─────────────────────────────────────────────
    ws3 = wb.create_sheet("Endpoint Evidence")
    ws3.sheet_view.showGridLines = False
    ws3.tab_color = "3B82F6"

    ws3.merge_cells("A1:N1")
    t3 = ws3["A1"]
    t3.value = f"ENDPOINT COMPLIANCE EVIDENCE  —  {today}"
    t3.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
    t3.fill = fill(DARK_BG)
    t3.alignment = Alignment(horizontal="center", vertical="center")
    ws3.row_dimensions[1].height = 26

    headers3 = [
        "Hostname", "Display Name", "IP Address", "OS", "Agent Status",
        "Overall Score", "Compliant?",
        "Patch Score", "Crit Patches",
        "Vuln Score", "Crit CVEs", "High CVEs",
        "Config Score", "Config Fail",
        "Protection Score", "AV Status",
        "License Score", "Licenses Active", "Licenses Total",
        "Last Seen",
    ]
    write_header_row(ws3, 2, headers3)
    ws3.row_dimensions[2].height = 30

    for row_i, a in enumerate(evidence_rows, 3):
        def tc(col, val, bold=False, color="CBD5E1", align="left"):
            c = ws3.cell(row=row_i, column=col, value=val)
            c.font = Font(bold=bold, color=color, size=9, name="Calibri")
            c.fill = fill(HDR_BG)
            c.alignment = Alignment(horizontal=align, vertical="center")
            c.border = thin_border()

        row_bg = "1F2D1F" if a["compliant"] else "2D1F1F"
        for cell in ws3[row_i]:
            cell.fill = fill(row_bg)

        tc(1, a["hostname"], bold=True, color="93C5FD")
        tc(2, a["display_name"] or a["hostname"])
        tc(3, a["ip_address"] or "—", align="center")
        tc(4, a["os_type"] or "—", align="center")
        status_color = "10B981" if a["agent_status"] == "online" else "64748B"
        tc(5, a["agent_status"] or "—", color=status_color, align="center")

        # Scores with color
        overall = a["overall_score"]
        oc = ws3.cell(row=row_i, column=6, value=round(overall, 1))
        oc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
        oc.fill = fill(_xlsx_color(overall))
        oc.alignment = Alignment(horizontal="center", vertical="center")
        oc.border = thin_border()

        comp_color = "10B981" if a["compliant"] else "EF4444"
        tc(7, "✓ Yes" if a["compliant"] else "✗ No", bold=True, color=comp_color, align="center")

        # Score columns
        for col_idx, score_key in [(8, "patch_score"), (10, "vuln_score"), (13, "config_score"), (15, "protection_score"), (17, "license_score")]:
            sv = a.get(score_key)
            sc = ws3.cell(row=row_i, column=col_idx, value=round(sv, 1) if sv is not None else "—")
            sc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
            sc.fill = fill(_xlsx_color(sv))
            sc.alignment = Alignment(horizontal="center", vertical="center")
            sc.border = thin_border()

        tc(9,  a["critical_patches"], color="EF4444" if a["critical_patches"] > 0 else "10B981", align="center")
        tc(11, a["crit_vulns"],       color="EF4444" if a["crit_vulns"] > 0 else "10B981", align="center")
        tc(12, a["high_vulns"],       color="F59E0B" if a["high_vulns"] > 0 else "10B981", align="center")
        tc(14, a.get("config_fail") or 0, color="EF4444" if (a.get("config_fail") or 0) > 0 else "10B981", align="center")
        av_color = "10B981" if a["av_status"] == "pass" else "EF4444"
        tc(16, "Protected" if a["av_status"] == "pass" else "Unprotected", color=av_color, align="center")
        tc(18, a["lic_activated"], align="center")
        tc(19, a["lic_total"],     align="center")
        tc(20, str(a["last_seen"])[:16] if a["last_seen"] else "—", align="center")

    set_col_widths(ws3, [18, 18, 14, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12, 12, 12, 12, 12, 18])

    # ── Sheet 4: Non-Compliant Agents ───────────────────────────────────────────
    non_compliant_agents = [a for a in evidence_rows if not a["compliant"]]
    ws4 = wb.create_sheet("Non-Compliant Agents")
    ws4.sheet_view.showGridLines = False
    ws4.tab_color = "EF4444"

    ws4.merge_cells("A1:J1")
    t4 = ws4["A1"]
    t4.value = f"NON-COMPLIANT ENDPOINTS  —  {len(non_compliant_agents)} agents below 80%  |  {today}"
    t4.font = Font(bold=True, color=WHITE, size=13, name="Calibri")
    t4.fill = fill("450A0A")
    t4.alignment = Alignment(horizontal="center", vertical="center")
    ws4.row_dimensions[1].height = 26

    if non_compliant_agents:
        headers4 = ["Hostname", "IP Address", "OS", "Overall Score",
                    "Patch Score", "Vuln Score", "Config Score", "Protection Score",
                    "Crit Patches", "Crit CVEs", "AV Status", "Recommended Action"]
        write_header_row(ws4, 2, headers4, bg="450A0A")
        ws4.row_dimensions[2].height = 30

        for row_i, a in enumerate(non_compliant_agents, 3):
            def r4(col, val, bold=False, color="CBD5E1", align="left"):
                c = ws4.cell(row=row_i, column=col, value=val)
                c.font = Font(bold=bold, color=color, size=9, name="Calibri")
                c.fill = fill("2D1F1F")
                c.alignment = Alignment(horizontal=align, vertical="center")
                c.border = thin_border()

            r4(1, a["hostname"], bold=True, color="FCA5A5")
            r4(2, a["ip_address"] or "—", align="center")
            r4(3, a["os_type"] or "—", align="center")

            oc = ws4.cell(row=row_i, column=4, value=round(a["overall_score"], 1))
            oc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
            oc.fill = fill(_xlsx_color(a["overall_score"]))
            oc.alignment = Alignment(horizontal="center", vertical="center")
            oc.border = thin_border()

            for col_i, sk in [(5, "patch_score"), (6, "vuln_score"), (7, "config_score"), (8, "protection_score")]:
                sv = a.get(sk)
                sc = ws4.cell(row=row_i, column=col_i, value=round(sv, 1) if sv is not None else "—")
                sc.font = Font(bold=True, color=WHITE, size=9, name="Calibri")
                sc.fill = fill(_xlsx_color(sv))
                sc.alignment = Alignment(horizontal="center", vertical="center")
                sc.border = thin_border()

            r4(9,  a["critical_patches"], color="EF4444" if a["critical_patches"] > 0 else "10B981", align="center")
            r4(10, a["crit_vulns"],       color="EF4444" if a["crit_vulns"] > 0 else "10B981", align="center")
            av_color = "10B981" if a["av_status"] == "pass" else "EF4444"
            r4(11, "Protected" if a["av_status"] == "pass" else "Unprotected", color=av_color, align="center")

            # Recommended action
            actions = []
            if a["critical_patches"] > 0:
                actions.append(f"Apply {a['critical_patches']} security patch(es)")
            if a["crit_vulns"] > 0:
                actions.append(f"Remediate {a['crit_vulns']} critical CVE(s)")
            if a["av_status"] != "pass":
                actions.append("Install/activate antivirus")
            if (a.get("config_score") or 100) < 80:
                actions.append(f"Fix {a.get('config_fail', 0)} misconfig(s)")
            r4(12, "; ".join(actions) if actions else "Review compliance details", color="FCD34D")

        set_col_widths(ws4, [18, 14, 10, 12, 12, 12, 12, 14, 12, 10, 12, 42])
    else:
        ws4.merge_cells("A3:J3")
        c = ws4["A3"]
        c.value = "✓ All endpoints are compliant — no action required."
        c.font = Font(bold=True, color="10B981", size=11, name="Calibri")
        c.fill = fill(HDR_BG)
        c.alignment = Alignment(horizontal="center", vertical="center")

    # ── Stream response ─────────────────────────────────────────────────────────
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"risk_review_{today.strftime('%Y-%m-%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
