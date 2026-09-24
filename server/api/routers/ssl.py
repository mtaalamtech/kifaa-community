"""
SSL / Certificate Management Router
- Generate CSR + private key
- Download CSR to send to CA
- Upload signed certificate
- List/view certificates
- Let's Encrypt ACME HTTP-01 automatic certificate issuance and renewal
"""
import asyncio
import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec
from cryptography.x509 import random_serial_number
import ipaddress

from api.database import get_db
from api.models.models import SSLCertificate
from api.schemas.schemas import CSRCreateRequest, CSRResponse
from api.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/ssl", tags=["SSL Certificates"])

SSL_DIR = "/app/ssl"
PRIVATE_DIR = f"{SSL_DIR}/private"
CSR_DIR = f"{SSL_DIR}/csr"
CERT_DIR = f"{SSL_DIR}/certs"

for d in [PRIVATE_DIR, CSR_DIR, CERT_DIR]:
    os.makedirs(d, exist_ok=True)

# ── Let's Encrypt constants ────────────────────────────────────────────────────
LE_STAGING_DIR = "https://acme-staging-v02.api.letsencrypt.org/directory"
LE_PROD_DIR    = "https://acme-v02.api.letsencrypt.org/directory"
LE_ACCOUNT_KEY = f"{PRIVATE_DIR}/le_account.key"

# In-process challenge store keyed by token (shared across requests in one worker).
# For multi-worker setups Redis would be ideal, but single-worker LE requests are fine.
_acme_challenges: dict[str, str] = {}


def _load_or_create_le_account_key() -> rsa.RSAPrivateKey:
    """Load the ACME account key from disk or generate a new one."""
    if os.path.exists(LE_ACCOUNT_KEY):
        with open(LE_ACCOUNT_KEY, "rb") as f:
            return serialization.load_pem_private_key(f.read(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with open(LE_ACCOUNT_KEY, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    os.chmod(LE_ACCOUNT_KEY, 0o600)
    return key


def _run_acme_flow(domains: list[str], email: str, staging: bool) -> dict:
    """
    Direct ACME v2 HTTP-01 implementation using httpx + cryptography only.
    Bypasses the high-level 'acme' Python library to avoid pyOpenSSL 26.x
    incompatibilities (load_certificate_request was removed).
    """
    import base64
    import hashlib
    import json as _json
    import httpx

    from cryptography.hazmat.primitives.asymmetric import padding as asym_padding

    directory_url = LE_STAGING_DIR if staging else LE_PROD_DIR
    primary_domain = domains[0]

    # ── Account key & JWK helpers ────────────────────────────────────────────
    acct_key = _load_or_create_le_account_key()
    pub       = acct_key.public_key()
    pub_n     = pub.public_numbers()

    def _b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

    def _int_b64(n: int) -> str:
        return _b64(n.to_bytes((n.bit_length() + 7) // 8, "big"))

    # JWK public key (canonical for thumbprint — keys must be sorted)
    jwk_pub = {"e": _int_b64(pub_n.e), "kty": "RSA", "n": _int_b64(pub_n.n)}
    jwk_thumb = _b64(
        hashlib.sha256(
            _json.dumps(jwk_pub, sort_keys=True, separators=(",", ":")).encode()
        ).digest()
    )

    def _jws(url: str, payload, nonce: str, kid: str = None) -> dict:
        """Build and sign a JWS POST body (RS256)."""
        header: dict = {"alg": "RS256", "nonce": nonce, "url": url}
        if kid:
            header["kid"] = kid
        else:
            header["jwk"] = jwk_pub

        protected  = _b64(_json.dumps(header, separators=(",", ":")).encode())
        payload_b64 = "" if payload is None else _b64(_json.dumps(payload, separators=(",", ":")).encode())
        sig_input   = f"{protected}.{payload_b64}".encode("ascii")
        signature   = acct_key.sign(sig_input, asym_padding.PKCS1v15(), hashes.SHA256())
        return {"protected": protected, "payload": payload_b64, "signature": _b64(signature)}

    with httpx.Client(timeout=30, verify=True) as http:

        def _nonce() -> str:
            return http.head(directory["newNonce"]).headers["Replay-Nonce"]

        def _post(url: str, payload, kid: str = None):
            body = _jws(url, payload, _nonce(), kid)
            r    = http.post(url, json=body, headers={"Content-Type": "application/jose+json"})
            return r

        # 1. Directory
        directory = http.get(directory_url).raise_for_status().json()

        # 2. Account — create or retrieve existing
        acct_r = _post(directory["newAccount"], {
            "termsOfServiceAgreed": True,
            "contact": [f"mailto:{email}"],
        })
        if acct_r.status_code not in (200, 201):
            raise RuntimeError(f"Account error ({acct_r.status_code}): {acct_r.text}")
        kid = acct_r.headers["Location"]

        # 3. New order
        order_r = _post(directory["newOrder"], {
            "identifiers": [{"type": "dns", "value": d} for d in domains]
        }, kid=kid)
        if order_r.status_code not in (200, 201):
            raise RuntimeError(f"New order error ({order_r.status_code}): {order_r.text}")
        order_url = order_r.headers["Location"]
        order     = order_r.json()

        # 4. HTTP-01 challenges
        tokens: list[str] = []
        for authz_url in order["authorizations"]:
            authz      = _post(authz_url, None, kid=kid).json()
            domain_val = authz["identifier"]["value"]

            if authz.get("status") == "valid":
                continue  # Already validated (cached by LE)

            chall = next((c for c in authz["challenges"] if c["type"] == "http-01"), None)
            if not chall:
                raise RuntimeError(f"No HTTP-01 challenge available for {domain_val}")

            token    = chall["token"]
            key_auth = f"{token}.{jwk_thumb}"
            _acme_challenges[token] = key_auth
            tokens.append(token)
            logger.info("ACME HTTP-01 token stored: %s (domain: %s)", token, domain_val)

            # Signal readiness
            r = _post(chall["url"], {}, kid=kid)
            if r.status_code not in (200, 202):
                raise RuntimeError(f"Challenge trigger failed ({r.status_code}): {r.text}")

        # 5. Poll until all authorizations valid
        deadline = time.time() + 120
        while time.time() < deadline:
            all_valid = True
            for authz_url in order["authorizations"]:
                authz  = _post(authz_url, None, kid=kid).json()
                status = authz.get("status")
                if status == "valid":
                    continue
                if status in ("invalid", "revoked", "deactivated", "expired"):
                    err = next(
                        (c.get("error", {}) for c in authz.get("challenges", []) if c.get("error")),
                        {}
                    )
                    dv = authz.get("identifier", {}).get("value", "?")
                    detail = err.get("detail", "no detail")
                    raise RuntimeError(
                        f"Authorization failed for {dv}: {err.get('type','unknown')} — {detail}"
                    )
                all_valid = False
            if all_valid:
                break
            time.sleep(3)
        else:
            for t in tokens:
                _acme_challenges.pop(t, None)
            raise RuntimeError(
                "Timed out waiting for ACME authorization (120 s). "
                "Ensure port 80 is publicly reachable and your domain's DNS points to this server."
            )

        # Clean up tokens
        for t in tokens:
            _acme_challenges.pop(t, None)

        # 6. Build CSR (pure cryptography — no pyOpenSSL)
        domain_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        csr = (
            x509.CertificateSigningRequestBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, primary_domain)]))
            .add_extension(
                x509.SubjectAlternativeName([x509.DNSName(d) for d in domains]),
                critical=False,
            )
            .sign(domain_key, hashes.SHA256())
        )
        csr_der_b64 = _b64(csr.public_bytes(serialization.Encoding.DER))

        # 7. Finalize
        fin_r = _post(order["finalize"], {"csr": csr_der_b64}, kid=kid)
        if fin_r.status_code not in (200, 202):
            raise RuntimeError(f"Finalize failed ({fin_r.status_code}): {fin_r.text}")

        # 8. Poll order for certificate URL
        deadline = time.time() + 60
        cert_url  = None
        while time.time() < deadline:
            ord_status = _post(order_url, None, kid=kid).json()
            if ord_status.get("status") == "valid":
                cert_url = ord_status.get("certificate")
                break
            if ord_status.get("status") in ("invalid", "revoked"):
                raise RuntimeError(f"Order failed: {ord_status.get('error', {})}")
            time.sleep(3)
        if not cert_url:
            raise RuntimeError("Timed out waiting for certificate URL (60 s)")

        # 9. Download certificate chain
        # Send Accept header so LE always returns PEM (not DER or PKCS7)
        # We build the JWS manually then send with explicit Accept header
        cert_jws  = _jws(cert_url, None, _nonce(), kid)
        cert_r    = http.post(
            cert_url,
            json=cert_jws,
            headers={
                "Content-Type": "application/jose+json",
                "Accept": "application/pem-certificate-chain",
            },
        )
        if cert_r.status_code != 200:
            raise RuntimeError(
                f"Certificate download failed ({cert_r.status_code}): {cert_r.text[:300]}"
            )

        cert_pem = cert_r.text
        if "BEGIN CERTIFICATE" not in cert_pem:
            raise RuntimeError(
                f"ACME server did not return PEM certificate. "
                f"Response ({cert_r.status_code}, {cert_r.headers.get('content-type', '?')}): "
                f"{cert_pem[:200]}"
            )

        # Strip any leading whitespace / BOM that would cause PEM parsing to fail
        cert_pem = cert_pem.strip()

        key_pem = domain_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ).decode()

        parsed = x509.load_pem_x509_certificate(cert_pem.encode())
        return {
            "cert_pem":   cert_pem,
            "key_pem":    key_pem,
            "domain_key": domain_key,
            "expires_at": parsed.not_valid_after_utc,
            "issued_by":  "Let's Encrypt" + (" (Staging)" if staging else ""),
        }


def _reload_nginx() -> tuple[bool, str]:
    """
    Send 'nginx -s reload' to the kifaa-nginx container via Docker SDK.
    Requires /var/run/docker.sock mounted in the API container.
    """
    try:
        import docker as docker_sdk
        dclient = docker_sdk.DockerClient(base_url="unix:///var/run/docker.sock")
        container = dclient.containers.get("kifaa-nginx")
        result = container.exec_run("nginx -s reload")
        output = result.output.decode().strip() if result.output else ""
        return result.exit_code == 0, output or "nginx reloaded"
    except Exception as exc:
        return False, str(exc)


def _build_name(req: CSRCreateRequest) -> x509.Name:
    attrs = []
    if req.country:
        attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, req.country))
    if req.state:
        attrs.append(x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, req.state))
    if req.city:
        attrs.append(x509.NameAttribute(NameOID.LOCALITY_NAME, req.city))
    if req.organization:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, req.organization))
    if req.org_unit:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, req.org_unit))
    if req.email:
        attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, req.email))
    attrs.append(x509.NameAttribute(NameOID.COMMON_NAME, req.common_name))
    return x509.Name(attrs)


def _build_san(san_names: list) -> Optional[x509.SubjectAlternativeName]:
    if not san_names:
        return None
    sans = []
    for name in san_names:
        try:
            ip = ipaddress.ip_address(name)
            sans.append(x509.IPAddress(ip))
        except ValueError:
            sans.append(x509.DNSName(name))
    return x509.SubjectAlternativeName(sans)


@router.post("/csr", response_model=CSRResponse, status_code=201)
async def generate_csr(body: CSRCreateRequest, db: AsyncSession = Depends(get_db)):
    cert_id = str(uuid.uuid4())
    key_path = f"{PRIVATE_DIR}/{cert_id}.key"
    csr_path = f"{CSR_DIR}/{cert_id}.csr"

    # Generate key
    if body.key_type.upper() == "ECDSA":
        private_key = ec.generate_private_key(ec.SECP256R1())
    else:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=body.key_size,
        )

    # Save private key (PEM, no passphrase for now — stored with 600 perms)
    with open(key_path, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    os.chmod(key_path, 0o600)

    # Build CSR
    subject = _build_name(body)
    csr_builder = x509.CertificateSigningRequestBuilder().subject_name(subject)

    san_ext = _build_san([body.common_name] + body.san_names)
    if san_ext:
        csr_builder = csr_builder.add_extension(san_ext, critical=False)

    csr = csr_builder.sign(private_key, hashes.SHA256())
    csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode()

    with open(csr_path, "w") as f:
        f.write(csr_pem)

    # Save to DB
    cert_record = SSLCertificate(
        id=uuid.UUID(cert_id),
        name=body.name,
        common_name=body.common_name,
        san_names=body.san_names,
        organization=body.organization,
        org_unit=body.org_unit,
        country=body.country,
        state=body.state,
        city=body.city,
        email=body.email,
        key_type=body.key_type,
        key_size=body.key_size,
        csr_path=csr_path,
        key_path=key_path,
        status="csr_pending",
        used_for=body.used_for,
    )
    db.add(cert_record)
    await db.commit()

    return CSRResponse(
        id=cert_record.id,
        name=cert_record.name,
        common_name=cert_record.common_name,
        status=cert_record.status,
        csr_content=csr_pem,
        created_at=cert_record.created_at,
    )


def _safe_filename(common_name: str) -> str:
    """Convert common_name to a safe filename slug, e.g. kifaa.kenyanut.com → kifaa_kenyanut_com"""
    import re
    return re.sub(r'[^a-zA-Z0-9]+', '_', common_name).strip('_')


@router.get("/csr/{cert_id}/download")
async def download_csr(cert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = result.scalar_one_or_none()
    if not cert or not cert.csr_path:
        raise HTTPException(status_code=404, detail="CSR not found")
    with open(cert.csr_path) as f:
        content = f.read()
    filename = f"{_safe_filename(cert.common_name)}.csr"
    return Response(
        content=content,
        media_type="application/x-pem-file",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{cert_id}/download-key")
async def download_private_key(cert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = result.scalar_one_or_none()
    if not cert or not cert.key_path:
        raise HTTPException(status_code=404, detail="Private key not found")
    if not os.path.exists(cert.key_path):
        raise HTTPException(status_code=404, detail="Private key file missing on disk")
    with open(cert.key_path) as f:
        content = f.read()
    filename = f"{_safe_filename(cert.common_name)}.key"
    return Response(
        content=content,
        media_type="application/x-pem-file",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{cert_id}/download-cert")
async def download_certificate(cert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = result.scalar_one_or_none()
    if not cert or not cert.cert_path:
        raise HTTPException(status_code=404, detail="Certificate not found")
    if not os.path.exists(cert.cert_path):
        raise HTTPException(status_code=404, detail="Certificate file missing on disk")
    with open(cert.cert_path) as f:
        content = f.read()
    filename = f"{_safe_filename(cert.common_name)}.crt"
    return Response(
        content=content,
        media_type="application/x-pem-file",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{cert_id}/upload-cert")
async def upload_signed_cert(
    cert_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = result.scalar_one_or_none()
    if not cert:
        raise HTTPException(status_code=404, detail="Certificate record not found")

    cert_path = f"{CERT_DIR}/{cert_id}.crt"
    contents = await file.read()

    # Validate PEM
    try:
        parsed = x509.load_pem_x509_certificate(contents)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid PEM certificate file")

    # Verify the certificate's public key matches the stored private key
    key_path = f"{PRIVATE_DIR}/{cert_id}.key"
    if os.path.exists(key_path):
        try:
            with open(key_path, "rb") as kf:
                private_key = serialization.load_pem_private_key(kf.read(), password=None)
            cert_pub = parsed.public_key()
            priv_pub = private_key.public_key()
            # Compare serialised public keys — the simplest reliable method
            cert_pub_bytes = cert_pub.public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            priv_pub_bytes = priv_pub.public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            if cert_pub_bytes != priv_pub_bytes:
                raise HTTPException(
                    status_code=400,
                    detail="Certificate does not match the private key on file. "
                           "Make sure you are uploading the certificate that was signed from this record's CSR."
                )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not verify key match: {e}")

    with open(cert_path, "wb") as f:
        f.write(contents)

    # Extract validity dates
    cert.cert_path = cert_path
    cert.valid_from = parsed.not_valid_before_utc
    cert.valid_until = parsed.not_valid_after_utc
    cert.issued_by = parsed.issuer.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value if parsed.issuer.get_attributes_for_oid(NameOID.COMMON_NAME) else "Unknown"
    cert.status = "active"
    await db.commit()

    return {
        "status": "ok",
        "message": "Certificate uploaded and activated",
        "valid_from": cert.valid_from.isoformat(),
        "valid_until": cert.valid_until.isoformat(),
        "issued_by": cert.issued_by,
    }


@router.get("")
async def list_certificates(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SSLCertificate).order_by(SSLCertificate.created_at.desc()))
    certs = result.scalars().all()
    now = datetime.now(timezone.utc)
    return [
        {
            "id": str(c.id),
            "name": c.name,
            "common_name": c.common_name,
            "status": c.status,
            "key_type": c.key_type,
            "key_size": c.key_size,
            "valid_until": c.valid_until.isoformat() if c.valid_until else None,
            "days_until_expiry": (c.valid_until - now).days if c.valid_until else None,
            "used_for": c.used_for,
            "renewed_from_id": str(c.renewed_from_id) if c.renewed_from_id else None,
            "provider": getattr(c, "provider", "manual") or "manual",
            "auto_renew": getattr(c, "auto_renew", False) or False,
            "le_staging": getattr(c, "le_staging", False) or False,
            "created_at": c.created_at.isoformat(),
        }
        for c in certs
    ]


@router.post("/{cert_id}/renew", status_code=201)
async def renew_certificate(cert_id: str, db: AsyncSession = Depends(get_db)):
    """Generate a new CSR + private key for the same domain, keeping the original cert active."""
    result = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    old = result.scalar_one_or_none()
    if not old:
        raise HTTPException(status_code=404, detail="Certificate not found")

    new_id = str(uuid.uuid4())
    key_path = f"{PRIVATE_DIR}/{new_id}.key"
    csr_path = f"{CSR_DIR}/{new_id}.csr"

    # Generate new private key (same type/size as original)
    if (old.key_type or "RSA").upper() == "ECDSA":
        private_key = ec.generate_private_key(ec.SECP256R1())
    else:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=old.key_size or 2048,
        )

    with open(key_path, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    os.chmod(key_path, 0o600)

    # Rebuild subject from original cert
    from api.schemas.schemas import CSRCreateRequest
    req = CSRCreateRequest(
        name=old.name,
        common_name=old.common_name,
        san_names=old.san_names or [],
        organization=old.organization or "",
        org_unit=old.org_unit or "",
        country=old.country or "",
        state=old.state or "",
        city=old.city or "",
        email=old.email or "",
        key_type=old.key_type or "RSA",
        key_size=old.key_size or 2048,
        used_for=old.used_for or "platform",
    )
    subject = _build_name(req)
    csr_builder = x509.CertificateSigningRequestBuilder().subject_name(subject)
    san_ext = _build_san([old.common_name] + (old.san_names or []))
    if san_ext:
        csr_builder = csr_builder.add_extension(san_ext, critical=False)

    csr = csr_builder.sign(private_key, hashes.SHA256())
    csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode()

    with open(csr_path, "w") as f:
        f.write(csr_pem)

    new_cert = SSLCertificate(
        id=uuid.UUID(new_id),
        name=old.name,
        common_name=old.common_name,
        san_names=old.san_names,
        organization=old.organization,
        org_unit=old.org_unit,
        country=old.country,
        state=old.state,
        city=old.city,
        email=old.email,
        key_type=old.key_type,
        key_size=old.key_size,
        csr_path=csr_path,
        key_path=key_path,
        status="csr_pending",
        used_for=old.used_for,
        renewed_from_id=old.id,
    )
    db.add(new_cert)

    # Mark old cert as superseded if it's still active
    if old.status == "active":
        old.status = "superseded"

    await db.commit()

    return {
        "id": str(new_cert.id),
        "name": new_cert.name,
        "common_name": new_cert.common_name,
        "status": new_cert.status,
        "csr_content": csr_pem,
        "renewed_from_id": str(old.id),
        "created_at": new_cert.created_at.isoformat() if new_cert.created_at else None,
    }


# ── ACME pre-flight helpers ───────────────────────────────────────────────────

def _get_server_public_ip() -> str | None:
    """Discover server's public IP via ipify (outbound request)."""
    try:
        import httpx
        r = httpx.get("https://api.ipify.org", timeout=6)
        return r.text.strip()
    except Exception:
        return None


def _resolve_via_doh(domain: str) -> str | None:
    """
    Resolve domain's A record via Google DNS-over-HTTPS.
    This returns what the public internet sees, not the local DNS.
    """
    try:
        import httpx
        r = httpx.get(
            "https://dns.google/resolve",
            params={"name": domain, "type": "A"},
            timeout=8,
        )
        data = r.json()
        for answer in data.get("Answer", []):
            if answer.get("type") == 1:   # A record
                return answer["data"]
    except Exception:
        pass
    return None


def _is_private_ip(ip: str) -> bool:
    """Return True if ip is an RFC-1918 / loopback / link-local address."""
    try:
        import ipaddress
        return ipaddress.ip_address(ip).is_private
    except Exception:
        return False


def _check_port_open(host: str, port: int, timeout: float = 5.0) -> bool:
    """Try TCP connect to host:port from this server."""
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _run_preflight(domain: str) -> dict:
    """
    Pre-flight check for ACME HTTP-01 challenge reachability.

    The kifaa server does NOT need to be the IP the domain points to.
    For local/NAT setups, port 80 on the domain's public IP just needs to
    be port-forwarded to this kifaa server so nginx can serve the challenge.

    Returns a dict:
      domain_ip      — what public DNS resolves the domain to
      server_ip      — this server's public IP (via ipify)
      has_public_dns — domain resolves to a routable public IP
      port_ok        — TCP port 80 reachable at domain_ip from this host
                       (false-negative possible if NAT hairpin not supported)
      behind_nat     — server appears to be behind NAT
      challenge_ok   — we can fetch our own test token via the domain (best test)
      ready          — True when has_public_dns and (challenge_ok or port_ok)
      warnings       — list of human-readable advisory strings
      suggestions    — actionable fix steps
    """
    import socket, uuid as _uuid

    result: dict = {
        "domain":      domain,
        "domain_ip":   None,
        "server_ip":   None,
        "has_public_dns": False,
        "port_ok":     False,
        "behind_nat":  False,
        "challenge_ok": False,
        "ready":       False,
        "warnings":    [],
        "suggestions": [],
    }

    # 1. Resolve domain from public internet (Google DoH)
    domain_ip = _resolve_via_doh(domain)
    result["domain_ip"] = domain_ip

    if not domain_ip:
        result["warnings"].append(
            f"{domain} has no public DNS A record. "
            f"Let's Encrypt resolves the domain from the internet — it must have a public A record."
        )
        result["suggestions"].append(f"Add a DNS A record: {domain} → <your public IP>")
        return result

    has_public_dns = not _is_private_ip(domain_ip)
    result["has_public_dns"] = has_public_dns

    if not has_public_dns:
        result["warnings"].append(
            f"{domain} resolves to a private/RFC-1918 IP ({domain_ip}). "
            f"Let's Encrypt validates from the internet and cannot reach a private IP. "
            f"Update the DNS A record to point to a public IP."
        )
        result["suggestions"].append(f"Change DNS A record: {domain} → <your public IP>")
        return result

    # 2. Get server's public IP (informational)
    server_ip = _get_server_public_ip()
    result["server_ip"] = server_ip

    # 3. Detect NAT (server's public IP not in local interfaces)
    local_ips: set[str] = set()
    try:
        for iface_info in socket.getaddrinfo(socket.gethostname(), None):
            local_ips.add(iface_info[4][0])
    except Exception:
        pass
    try:
        local_ips.add(socket.gethostbyname(socket.gethostname()))
    except Exception:
        pass

    behind_nat = server_ip is not None and server_ip not in local_ips
    result["behind_nat"] = behind_nat

    # 4. Live end-to-end challenge test
    # Store a test token, fetch it via the public domain, remove it.
    # This proves the full path: DNS → public IP → port 80 → nginx → this API.
    test_token    = f"kifaa-preflight-{_uuid.uuid4().hex[:12]}"
    test_key_auth = f"{test_token}.preflight-ok"
    _acme_challenges[test_token] = test_key_auth
    challenge_ok = False
    try:
        import httpx
        r = httpx.get(
            f"http://{domain}/.well-known/acme-challenge/{test_token}",
            timeout=8,
            follow_redirects=False,
        )
        challenge_ok = r.status_code == 200 and test_key_auth in r.text
    except Exception:
        challenge_ok = False
    finally:
        _acme_challenges.pop(test_token, None)
    result["challenge_ok"] = challenge_ok

    # 5. TCP port 80 check (fallback signal — may be blocked by hairpin NAT)
    port_ok = challenge_ok or _check_port_open(domain_ip, 80, timeout=5)
    result["port_ok"] = port_ok

    # 6. Warnings
    if not challenge_ok:
        if behind_nat:
            result["warnings"].append(
                f"{domain} resolves to {domain_ip} (public). "
                f"This server is behind NAT (public IP: {server_ip}). "
                f"Port 80 at {domain_ip} must be forwarded to this server's LAN IP on port 80. "
                f"Also confirm your router supports hairpin/NAT loopback (some routers don't, "
                f"causing internal tests to fail even when external access works)."
            )
            result["suggestions"].append(
                f"Add router port-forward: {domain_ip}:80 → (this server LAN IP):80"
            )
            if not port_ok:
                result["suggestions"].append(
                    "If router lacks hairpin NAT, add a /etc/hosts entry for testing, "
                    "or verify from an external network."
                )
        else:
            result["warnings"].append(
                f"{domain} resolves to {domain_ip} but the ACME challenge endpoint "
                f"is not reachable at http://{domain}/.well-known/acme-challenge/. "
                f"Ensure port 80 is open and nginx is running."
            )
            result["suggestions"].append(f"Test: curl http://{domain}/.well-known/acme-challenge/test")
            result["suggestions"].append("Ensure port 80 is open: sudo ufw allow 80/tcp")

    # 7. Ready?
    result["ready"] = has_public_dns and (challenge_ok or port_ok)
    return result


# ── Let's Encrypt endpoints ────────────────────────────────────────────────────

@router.get("/letsencrypt/preflight")
async def letsencrypt_preflight(domain: str):
    """
    Pre-flight connectivity check for ACME HTTP-01 challenge.
    Resolves the domain via public DNS (Google DoH), detects NAT,
    and tests TCP port 80 reachability.
    """
    if not domain or "." not in domain:
        raise HTTPException(status_code=400, detail="Valid 'domain' query param required")
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _run_preflight, domain)
    return result


@router.post("/letsencrypt/request", status_code=201)
async def request_letsencrypt_cert(
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """
    Request a free Let's Encrypt certificate via ACME HTTP-01 challenge.

    Body fields:
      domain       (str)       — primary domain (CN)
      extra_domains([str])     — additional SANs (optional)
      email        (str)       — contact email for the LE account
      staging      (bool)      — use LE staging (test without rate limits)
      auto_renew   (bool)      — auto-renew before expiry via Celery
      install      (bool)      — copy cert to active nginx path and reload nginx

    Prerequisites:
      - The server must be reachable from the internet on port 80
      - `/.well-known/acme-challenge/` must proxy to this API (handled by nginx config)
    """
    domain        = body.get("domain", "").strip()
    extra_domains = [d.strip() for d in body.get("extra_domains", []) if d.strip()]
    email         = body.get("email", "").strip()
    staging       = bool(body.get("staging", False))
    auto_renew    = bool(body.get("auto_renew", True))

    if not domain:
        raise HTTPException(status_code=400, detail="'domain' is required")
    if not email:
        raise HTTPException(status_code=400, detail="'email' is required")

    all_domains = [domain] + extra_domains

    # Run synchronous ACME flow in thread pool (avoids blocking the event loop)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _run_acme_flow, all_domains, email, staging
        )
    except Exception as exc:
        logger.error("ACME flow failed: %s", exc)
        # Enrich error with preflight diagnostics so the user gets actionable info
        try:
            pf = await loop.run_in_executor(None, _run_preflight, domain)
            diag_parts = [str(exc)]
            if pf.get("warnings"):
                diag_parts.append("Diagnostics: " + "; ".join(pf["warnings"]))
            if pf.get("suggestions"):
                diag_parts.append("Fix: " + "; ".join(pf["suggestions"]))
            detail = "\n".join(diag_parts)
        except Exception:
            detail = f"Certificate request failed: {exc}"
        raise HTTPException(status_code=502, detail=detail)

    # Save cert + key files
    cert_id  = str(uuid.uuid4())
    key_path  = f"{PRIVATE_DIR}/{cert_id}.key"
    cert_path = f"{CERT_DIR}/{cert_id}.crt"

    with open(key_path, "w") as f:
        f.write(result["key_pem"])
    os.chmod(key_path, 0o600)

    with open(cert_path, "w") as f:
        f.write(result["cert_pem"])

    # Persist to DB
    cert_record = SSLCertificate(
        id=uuid.UUID(cert_id),
        name=f"Let's Encrypt — {domain}" + (" (Staging)" if staging else ""),
        common_name=domain,
        san_names=extra_domains,
        email=email,
        key_type="RSA",
        key_size=2048,
        key_path=key_path,
        cert_path=cert_path,
        issued_by=result["issued_by"],
        valid_from=datetime.now(timezone.utc),
        valid_until=result["expires_at"],
        status="active",
        used_for="platform",
        provider="letsencrypt",
        auto_renew=auto_renew,
        le_email=email,
        le_staging=staging,
    )
    db.add(cert_record)
    await db.commit()
    await db.refresh(cert_record)

    return {
        "id":            str(cert_record.id),
        "domain":        domain,
        "status":        "active",
        "issued_by":     result["issued_by"],
        "valid_until":   result["expires_at"].isoformat(),
        "days_until_expiry": (result["expires_at"] - datetime.now(timezone.utc)).days,
        "auto_renew":    auto_renew,
    }


@router.post("/letsencrypt/{cert_id}/renew")
async def renew_letsencrypt_cert(
    cert_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Re-run ACME flow for an existing Let's Encrypt certificate."""
    result_q = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = result_q.scalar_one_or_none()
    if not cert:
        raise HTTPException(status_code=404, detail="Certificate not found")
    if cert.provider != "letsencrypt":
        raise HTTPException(status_code=400, detail="This certificate was not issued by Let's Encrypt")

    all_domains = [cert.common_name] + (cert.san_names or [])
    email       = cert.le_email or ""
    staging     = bool(cert.le_staging)

    loop = asyncio.get_event_loop()
    try:
        r = await loop.run_in_executor(None, _run_acme_flow, all_domains, email, staging)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Renewal failed: {exc}")

    # Overwrite files
    with open(cert.key_path, "w") as f:
        f.write(r["key_pem"])
    with open(cert.cert_path, "w") as f:
        f.write(r["cert_pem"])

    cert.valid_from  = datetime.now(timezone.utc)
    cert.valid_until = r["expires_at"]
    cert.issued_by   = r["issued_by"]
    cert.status      = "active"
    await db.commit()

    # Re-install to nginx if this is the active platform cert
    nginx_reloaded, nginx_message = False, ""
    active_cert = f"{CERT_DIR}/kifaa.crt"
    if os.path.exists(active_cert):
        import shutil
        shutil.copy2(cert.cert_path, active_cert)
        shutil.copy2(cert.key_path,  f"{PRIVATE_DIR}/kifaa.key")
        nginx_reloaded, nginx_message = _reload_nginx()

    return {
        "id":             cert_id,
        "domain":         cert.common_name,
        "valid_until":    r["expires_at"].isoformat(),
        "nginx_reloaded": nginx_reloaded,
        "nginx_message":  nginx_message,
    }


@router.get("/letsencrypt/account")
async def letsencrypt_account_info():
    """Return Let's Encrypt account status (whether account key exists)."""
    has_key = os.path.exists(LE_ACCOUNT_KEY)
    return {
        "account_key_exists": has_key,
        "account_key_path":   LE_ACCOUNT_KEY if has_key else None,
        "staging_directory":  LE_STAGING_DIR,
        "production_directory": LE_PROD_DIR,
    }


@router.patch("/{cert_id}/auto-renew")
async def set_auto_renew(
    cert_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Enable or disable automatic renewal for a Let's Encrypt certificate."""
    enabled = body.get("enabled")
    if enabled is None:
        raise HTTPException(status_code=400, detail="'enabled' field required")
    await db.execute(
        text("UPDATE ssl_certificates SET auto_renew = :v WHERE id = CAST(:id AS uuid)"),
        {"v": bool(enabled), "id": cert_id},
    )
    await db.commit()
    return {"status": "ok", "auto_renew": bool(enabled)}


@router.post("/letsencrypt/reload-nginx")
async def reload_nginx_endpoint():
    """Send nginx -s reload to the nginx container (requires docker.sock mounted)."""
    ok, message = _reload_nginx()
    if not ok:
        raise HTTPException(
            status_code=500,
            detail=f"nginx reload failed: {message}. "
                   "Ensure /var/run/docker.sock is mounted in the API container, "
                   "or run: docker compose restart nginx"
        )
    return {"status": "ok", "message": message}


# ── Certificate deployment to agents ─────────────────────────────────────────

# Default cert/key paths per web server type
_SERVER_DEFAULTS = {
    "nginx":        {"cert": "/etc/nginx/ssl/certs/{domain}.crt",    "key": "/etc/nginx/ssl/private/{domain}.key",    "service": "nginx"},
    "apache2":      {"cert": "/etc/ssl/certs/{domain}.crt",           "key": "/etc/ssl/private/{domain}.key",           "service": "apache2"},
    "apache_httpd": {"cert": "/etc/httpd/ssl/certs/{domain}.crt",     "key": "/etc/httpd/ssl/private/{domain}.key",     "service": "httpd"},
    "ibm_http":     {"cert": "/opt/IBM/HTTPServer/ssl/{domain}.crt",  "key": "/opt/IBM/HTTPServer/ssl/{domain}.key",    "service": "ibmhttpd"},
    "iis":          {"cert": None, "key": None, "service": "W3SVC"},  # Windows — PFX import
    "other":        {"cert": "/etc/ssl/certs/{domain}.crt",           "key": "/etc/ssl/private/{domain}.key",           "service": ""},
}


def _deploy_linux_cert(
    host: str,
    port: int,
    username: str,
    password: str | None,
    ssh_key: str | None,
    use_sudo: bool,
    cert_pem: str,
    key_pem: str,
    cert_path: str,
    key_path: str,
    service_name: str,
    restart_service: bool,
) -> dict:
    """Deploy cert + key to a Linux agent via SSH/SFTP using paramiko."""
    import paramiko, io, tempfile

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs: dict = {"hostname": host, "port": port, "username": username, "timeout": 15}
    if ssh_key:
        pkey = paramiko.RSAKey.from_private_key(io.StringIO(ssh_key))
        connect_kwargs["pkey"] = pkey
    elif password:
        connect_kwargs["password"] = password
    else:
        raise RuntimeError("No SSH credentials configured (password or key required)")

    client.connect(**connect_kwargs)
    sftp = client.open_sftp()

    def _exec(cmd: str) -> tuple[int, str]:
        _, stdout, stderr = client.exec_command(cmd)
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
        rc  = stdout.channel.recv_exit_status()
        return rc, out or err

    sudo = "sudo " if use_sudo else ""

    try:
        # Write to temp files first, then move to final paths with sudo
        with tempfile.NamedTemporaryFile(suffix=".crt", delete=False) as tf:
            tmp_cert = tf.name
        with tempfile.NamedTemporaryFile(suffix=".key", delete=False) as tf:
            tmp_key = tf.name

        with sftp.open(tmp_cert, "w") as rf:
            rf.write(cert_pem)
        with sftp.open(tmp_key, "w") as rf:
            rf.write(key_pem)

        # Ensure target directories exist
        cert_dir = os.path.dirname(cert_path)
        key_dir  = os.path.dirname(key_path)
        if cert_dir:
            rc, out = _exec(f"{sudo}mkdir -p {cert_dir}")
            if rc != 0:
                raise RuntimeError(f"mkdir cert dir failed: {out}")
        if key_dir and key_dir != cert_dir:
            rc, out = _exec(f"{sudo}mkdir -p {key_dir}")
            if rc != 0:
                raise RuntimeError(f"mkdir key dir failed: {out}")

        # Move and set permissions
        for src, dst, mode in [(tmp_cert, cert_path, "644"), (tmp_key, key_path, "600")]:
            rc, out = _exec(f"{sudo}mv {src} {dst}")
            if rc != 0:
                raise RuntimeError(f"mv {src} → {dst} failed: {out}")
            rc, out = _exec(f"{sudo}chmod {mode} {dst}")
            if rc != 0:
                raise RuntimeError(f"chmod {mode} {dst} failed: {out}")

        result = {"deployed": True, "cert_path": cert_path, "key_path": key_path}

        if restart_service and service_name:
            rc, out = _exec(f"{sudo}systemctl restart {service_name}")
            result["service_restarted"] = rc == 0
            result["service_output"]    = out
            if rc != 0:
                result["service_restart_error"] = out
        return result
    finally:
        sftp.close()
        client.close()


def _deploy_windows_iis_cert(
    host: str,
    winrm_port: int,
    username: str,
    password: str,
    domain: str,
    cert_pem: str,
    key_pem: str,
    restart_service: bool,
) -> dict:
    """Deploy cert to Windows IIS via WinRM — converts PEM to PFX and imports."""
    try:
        import winrm
    except ImportError:
        raise RuntimeError("pywinrm is not installed. Run: pip install pywinrm")

    from cryptography.hazmat.primitives.serialization import pkcs12

    # Convert PEM cert + key → PFX
    cert_obj = x509.load_pem_x509_certificate(cert_pem.encode())
    priv_key = serialization.load_pem_private_key(key_pem.encode(), password=None)
    pfx_bytes = pkcs12.serialize_key_and_certificates(
        name=domain.encode(),
        key=priv_key,
        cert=cert_obj,
        cas=None,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pfx_b64 = __import__("base64").b64encode(pfx_bytes).decode()

    session = winrm.Session(
        f"http://{host}:{winrm_port}/wsman",
        auth=(username, password),
        transport="ntlm",
    )

    # Import PFX into Windows cert store
    import_ps = f"""
$pfxBytes = [System.Convert]::FromBase64String('{pfx_b64}')
$pfxPath = "$env:TEMP\\kifaa_deploy.pfx"
[System.IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
$cert = Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation Cert:\\LocalMachine\\My
Remove-Item $pfxPath -Force

# Bind to Default Web Site on port 443
Import-Module WebAdministration -ErrorAction SilentlyContinue
$binding = Get-WebBinding -Name "Default Web Site" -Protocol https -Port 443 -ErrorAction SilentlyContinue
if ($binding) {{
    $binding.AddSslCertificate($cert.Thumbprint, "My")
}} else {{
    New-WebBinding -Name "Default Web Site" -Protocol https -Port 443
    (Get-WebBinding -Name "Default Web Site" -Protocol https -Port 443).AddSslCertificate($cert.Thumbprint, "My")
}}
Write-Output "Thumbprint: $($cert.Thumbprint)"
"""
    result = session.run_ps(import_ps)
    if result.status_code != 0:
        raise RuntimeError(f"PowerShell import failed: {result.std_err.decode()}")

    output = result.std_out.decode().strip()
    response = {"deployed": True, "output": output}

    if restart_service:
        restart_result = session.run_ps("Restart-Service W3SVC")
        response["service_restarted"] = restart_result.status_code == 0
        if restart_result.status_code != 0:
            response["service_restart_error"] = restart_result.std_err.decode().strip()

    return response


@router.post("/{cert_id}/deploy")
async def deploy_certificate(
    cert_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """
    Deploy a certificate to a remote agent's web server.

    Body:
      agent_id        (str)  — UUID of the target agent
      server_type     (str)  — nginx | apache2 | apache_httpd | ibm_http | iis | other
      cert_path       (str)  — destination cert path on the agent (auto-filled for known server types)
      key_path        (str)  — destination key path on the agent
      service_name    (str)  — systemctl service to restart (e.g. nginx, apache2, httpd)
      restart_service (bool) — whether to restart the service after deploy (default true)
    """
    from api.models.models import Agent, AgentSSHCredentials

    agent_id        = body.get("agent_id", "").strip()
    server_type     = body.get("server_type", "nginx").lower()
    cert_path_arg   = body.get("cert_path", "").strip()
    key_path_arg    = body.get("key_path", "").strip()
    service_name    = body.get("service_name", "").strip()
    restart_service = bool(body.get("restart_service", True))

    if not agent_id:
        raise HTTPException(status_code=400, detail="'agent_id' is required")

    # Load cert record
    cert_q = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = cert_q.scalar_one_or_none()
    if not cert:
        raise HTTPException(status_code=404, detail="Certificate not found")
    if not cert.cert_path or not cert.key_path:
        raise HTTPException(status_code=400, detail="Certificate files not available (cert not yet issued)")

    # Load agent
    agent_q = await db.execute(
        select(Agent).where(Agent.id == uuid.UUID(agent_id))
    )
    agent = agent_q.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Load SSH credentials
    creds_q = await db.execute(
        select(AgentSSHCredentials).where(AgentSSHCredentials.agent_id == uuid.UUID(agent_id))
    )
    creds = creds_q.scalar_one_or_none()
    if not creds:
        raise HTTPException(
            status_code=400,
            detail="No SSH credentials configured for this agent. "
                   "Add credentials under the agent's settings first."
        )

    # Read cert/key from disk
    with open(cert.cert_path) as f:
        cert_pem = f.read()
    with open(cert.key_path) as f:
        key_pem = f.read()

    domain = cert.common_name

    # Resolve default paths for server type
    defaults = _SERVER_DEFAULTS.get(server_type, _SERVER_DEFAULTS["other"])
    final_cert_path  = cert_path_arg  or (defaults["cert"]    or "").replace("{domain}", domain.replace(".", "_"))
    final_key_path   = key_path_arg   or (defaults["key"]     or "").replace("{domain}", domain.replace(".", "_"))
    final_service    = service_name   or defaults.get("service", "")

    # Determine host
    host = creds.host_override or agent.ip_address or agent.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Agent has no IP address or host override configured")

    connect_type = creds.connect_type or "linux"

    loop = asyncio.get_event_loop()
    try:
        if connect_type in ("windows_winrm", "iis") or server_type == "iis":
            result = await loop.run_in_executor(
                None,
                _deploy_windows_iis_cert,
                host, creds.winrm_port or 5985,
                creds.username, creds.password or "",
                domain, cert_pem, key_pem, restart_service,
            )
        else:
            result = await loop.run_in_executor(
                None,
                _deploy_linux_cert,
                host, creds.port or 22,
                creds.username, creds.password, creds.ssh_key,
                creds.use_sudo, cert_pem, key_pem,
                final_cert_path, final_key_path,
                final_service, restart_service,
            )
    except Exception as exc:
        logger.error("Certificate deploy failed for agent %s: %s", agent_id, exc)
        raise HTTPException(status_code=502, detail=f"Deployment failed: {exc}")

    return {
        "status": "ok",
        "agent":  agent.display_name or agent.hostname,
        **result,
    }


# ── ACME HTTP-01 challenge serving ────────────────────────────────────────────
# NOTE: This route is also registered on the root FastAPI app in main.py
# so nginx can proxy /.well-known/acme-challenge/ to the API without /api/v1 prefix.

@router.get("/acme-challenge/{token}", include_in_schema=False)
async def serve_acme_challenge_under_ssl(token: str):
    """Fallback challenge endpoint (under /api/v1/ssl/)."""
    val = _acme_challenges.get(token)
    if val is None:
        raise HTTPException(status_code=404, detail="Challenge not found")
    return Response(content=val, media_type="text/plain")


@router.delete("/{cert_id}")
async def delete_certificate(cert_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SSLCertificate).where(SSLCertificate.id == uuid.UUID(cert_id))
    )
    cert = result.scalar_one_or_none()
    if not cert:
        raise HTTPException(status_code=404, detail="Not found")

    # Clean up files
    for path in [cert.key_path, cert.csr_path, cert.cert_path]:
        if path and os.path.exists(path):
            os.remove(path)

    await db.delete(cert)
    await db.commit()
    return {"status": "deleted"}
