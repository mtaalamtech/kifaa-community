from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text, and_
from typing import Optional, List
from datetime import datetime, timezone
import uuid

from api.database import get_db
from api.models.models import Alert, AlertRule, Agent, NotificationChannel
from api.services.auth import get_current_user

router = APIRouter(prefix="/alerts", tags=["Alerts"])


# ── Alert Rules ───────────────────────────────────────────────────────────────

@router.get("/rules")
async def list_rules(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(AlertRule).order_by(AlertRule.created_at.desc())
    )
    rules = result.scalars().all()
    return [_rule_dict(r) for r in rules]


@router.post("/rules", status_code=201)
async def create_rule(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rule = AlertRule(
        name=body["name"],
        description=body.get("description"),
        rule_type=body.get("rule_type", "metric"),
        metric_name=body.get("metric_name"),
        condition=body.get("condition", ">"),
        threshold=body.get("threshold"),
        duration_minutes=body.get("duration_minutes", 5),
        severity=body.get("severity", "warning"),
        applies_to=body.get("applies_to", "all"),
        group_id=body.get("group_id"),
        agent_id=body.get("agent_id"),
        notify_channels=body.get("notify_channels", []),
        is_active=body.get("is_active", True),
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return _rule_dict(rule)


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Rule not found")

    for field in ["name", "description", "rule_type", "metric_name", "condition",
                  "threshold", "duration_minutes", "severity", "applies_to",
                  "group_id", "agent_id", "notify_channels", "is_active"]:
        if field in body:
            setattr(rule, field, body[field])

    await db.commit()
    return _rule_dict(rule)


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Rule not found")
    await db.delete(rule)
    await db.commit()


# ── Alert Incidents ───────────────────────────────────────────────────────────

@router.get("/incidents")
async def list_incidents(
    status: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    q = select(Alert, Agent.hostname).outerjoin(Agent, Alert.agent_id == Agent.id)
    if status:
        q = q.where(Alert.status == status)
    if severity:
        q = q.where(Alert.severity == severity)
    q = q.order_by(Alert.triggered_at.desc()).limit(limit)

    result = await db.execute(q)
    rows = result.all()
    return [_incident_dict(a, hostname) for a, hostname in rows]


@router.post("/incidents/{alert_id}/acknowledge")
async def acknowledge_incident(
    alert_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(404, "Alert not found")
    if alert.status != "open":
        raise HTTPException(400, f"Alert is already {alert.status}")

    alert.status = "acknowledged"
    alert.acknowledged_at = datetime.now(timezone.utc)
    alert.acknowledged_by = user.id
    await db.commit()
    return {"status": "acknowledged"}


@router.post("/incidents/{alert_id}/resolve")
async def resolve_incident(
    alert_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(404, "Alert not found")

    alert.status = "resolved"
    alert.resolved_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "resolved"}


# ── Stats (for dashboard) ─────────────────────────────────────────────────────

@router.get("/stats")
async def alert_stats(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    total = await db.execute(select(func.count(Alert.id)))
    open_ = await db.execute(select(func.count(Alert.id)).where(Alert.status == "open"))
    acked = await db.execute(select(func.count(Alert.id)).where(Alert.status == "acknowledged"))
    critical = await db.execute(
        select(func.count(Alert.id)).where(Alert.status == "open", Alert.severity == "critical")
    )
    warning = await db.execute(
        select(func.count(Alert.id)).where(Alert.status == "open", Alert.severity == "warning")
    )
    return {
        "total": total.scalar() or 0,
        "open": open_.scalar() or 0,
        "acknowledged": acked.scalar() or 0,
        "critical": critical.scalar() or 0,
        "warning": warning.scalar() or 0,
    }


# ── Internal: evaluate alert rules (called by Celery) ────────────────────────

@router.post("/internal/evaluate", include_in_schema=False)
async def evaluate_alerts(db: AsyncSession = Depends(get_db)):
    rules_res = await db.execute(
        select(AlertRule).where(AlertRule.is_active == True, AlertRule.rule_type == "metric")
    )
    rules = rules_res.scalars().all()

    fired = 0
    resolved = 0

    for rule in rules:
        if rule.metric_name is None or rule.threshold is None:
            continue

        # Build agent list for this rule
        if rule.applies_to == "all":
            agents_res = await db.execute(
                select(Agent).where(Agent.status == "online", Agent.is_active == True)
            )
        elif rule.applies_to == "agent" and rule.agent_id:
            agents_res = await db.execute(
                select(Agent).where(Agent.id == rule.agent_id, Agent.is_active == True)
            )
        elif rule.applies_to == "group" and rule.group_id:
            agents_res = await db.execute(
                select(Agent).where(Agent.group_id == rule.group_id,
                                    Agent.status == "online", Agent.is_active == True)
            )
        else:
            continue

        agents = agents_res.scalars().all()

        for agent in agents:
            # Average metric value over rule duration
            row = await db.execute(
                text("""
                    SELECT AVG(value) AS avg_val
                    FROM metrics
                    WHERE agent_id = :aid
                      AND metric_name = :metric
                      AND time > NOW() - (:mins * INTERVAL '1 minute')
                """),
                {"aid": str(agent.id), "metric": rule.metric_name,
                 "mins": rule.duration_minutes or 5},
            )
            r = row.first()
            if r is None or r.avg_val is None:
                continue

            avg_val = float(r.avg_val)
            thr = float(rule.threshold)
            cond = rule.condition or ">"
            condition_met = (
                (cond in (">", "gt")   and avg_val > thr) or
                (cond in (">=", "gte") and avg_val >= thr) or
                (cond in ("<", "lt")   and avg_val < thr) or
                (cond in ("<=", "lte") and avg_val <= thr) or
                (cond in ("==", "eq")  and avg_val == thr)
            )

            existing_res = await db.execute(
                select(Alert).where(
                    Alert.rule_id == rule.id,
                    Alert.agent_id == agent.id,
                    Alert.status.in_(["open", "acknowledged"]),
                )
            )
            existing = existing_res.scalar_one_or_none()

            if condition_met and not existing:
                alert = Alert(
                    rule_id=rule.id,
                    agent_id=agent.id,
                    source="rule",
                    severity=rule.severity,
                    message=(
                        f"{rule.name}: {rule.metric_name} = {avg_val:.1f} "
                        f"({cond} {thr}) on {agent.hostname}"
                    ),
                    metric_value=avg_val,
                    status="open",
                )
                db.add(alert)
                fired += 1
            elif not condition_met and existing:
                existing.status = "resolved"
                existing.resolved_at = datetime.now(timezone.utc)
                resolved += 1

    await db.commit()
    return {"evaluated_rules": len(rules), "fired": fired, "resolved": resolved}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _rule_dict(r: AlertRule) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "description": r.description,
        "rule_type": r.rule_type,
        "metric_name": r.metric_name,
        "condition": r.condition,
        "threshold": float(r.threshold) if r.threshold is not None else None,
        "duration_minutes": r.duration_minutes,
        "severity": r.severity,
        "applies_to": r.applies_to,
        "group_id": str(r.group_id) if r.group_id else None,
        "agent_id": str(r.agent_id) if r.agent_id else None,
        "notify_channels": r.notify_channels or [],
        "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _incident_dict(a: Alert, hostname: Optional[str]) -> dict:
    return {
        "id": str(a.id),
        "rule_id": str(a.rule_id) if a.rule_id else None,
        "agent_id": str(a.agent_id) if a.agent_id else None,
        "agent_hostname": hostname,
        "source": a.source,
        "severity": a.severity,
        "message": a.message,
        "metric_value": float(a.metric_value) if a.metric_value is not None else None,
        "triggered_at": a.triggered_at.isoformat() if a.triggered_at else None,
        "acknowledged_at": a.acknowledged_at.isoformat() if a.acknowledged_at else None,
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "status": a.status,
    }
