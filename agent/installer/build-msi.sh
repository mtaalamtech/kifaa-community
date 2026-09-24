#!/usr/bin/env bash
# Build Kifaa Agent MSI installer
# Requires: Go (with GOOS=windows cross-compile), msitools (wixl)
#
# Usage:
#   ./build-msi.sh [--output-dir /path/to/output]
#
# Produces:
#   kifaa-installer-amd64.msi   (x64 Windows)
#   kifaa-installer-386.msi     (x86 Windows)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:---output-dir}"

# Parse --output-dir flag
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Default output next to builds/
if [[ "$OUTPUT_DIR" == "--output-dir" ]]; then
  OUTPUT_DIR="$SCRIPT_DIR/../builds"
fi

echo "=== Kifaa MSI Build ==="
echo "    Output: $OUTPUT_DIR"

# ── Check dependencies ────────────────────────────────────────────────────────
if ! command -v wixl &>/dev/null; then
  echo "[*] wixl not found — building via ubuntu:24.04 Docker container …"
  BUILD_IN_DOCKER=1
fi

if ! command -v x86_64-w64-mingw32-gcc &>/dev/null; then
  echo "[*] Installing mingw cross-compiler (for cgo if needed)…"
  apt-get install -y -qq gcc-mingw-w64 2>/dev/null || true
fi

mkdir -p "$OUTPUT_DIR"

# ── Build silent installer — amd64 ───────────────────────────────────────────
echo "[*] Building silent installer (amd64)…"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" \
  -o "$OUTPUT_DIR/kifaa-installer-silent-amd64.exe" \
  "$SCRIPT_DIR/silent/"

# ── Build silent installer — 386 ─────────────────────────────────────────────
echo "[*] Building silent installer (386)…"
GOOS=windows GOARCH=386 CGO_ENABLED=0 \
  go build -ldflags="-s -w" \
  -o "$OUTPUT_DIR/kifaa-installer-silent-386.exe" \
  "$SCRIPT_DIR/silent/"

# ── Build MSIs (use Docker ubuntu:24.04 if wixl not available locally) ────────
build_msi() {
  local ARCH=$1 BIN=$2 OUT=$3
  echo "[*] Building MSI ($ARCH)…"
  if [[ "${BUILD_IN_DOCKER:-0}" == "1" ]]; then
    BDIR=$(mktemp -d)
    cp "$BIN" "$BDIR/helper.exe"
    cp "$SCRIPT_DIR/kifaa.wxs" "$BDIR/kifaa.wxs"
    docker run --rm \
      -v "$BDIR:/build" \
      -v "$(dirname "$OUT"):/out" \
      ubuntu:24.04 bash -c '
        apt-get update -qq && apt-get install -y -qq wixl 2>/dev/null
        cd /build
        wixl -D InstallerBin=helper.exe -o /out/'"$(basename "$OUT")"' kifaa.wxs 2>&1
      '
    rm -rf "$BDIR"
  else
    BDIR=$(mktemp -d)
    cp "$BIN" "$BDIR/helper.exe"
    cp "$SCRIPT_DIR/kifaa.wxs" "$BDIR/kifaa.wxs"
    (cd "$BDIR" && wixl -D InstallerBin=helper.exe -o "$OUT" kifaa.wxs 2>&1)
    rm -rf "$BDIR"
  fi
  echo "    => $OUT"
}

build_msi amd64 "$OUTPUT_DIR/kifaa-installer-silent-amd64.exe" "$OUTPUT_DIR/kifaa-installer-amd64.msi"
build_msi 386   "$OUTPUT_DIR/kifaa-installer-silent-386.exe"   "$OUTPUT_DIR/kifaa-installer-386.msi"

# ── Copy MSIs to agent-builds static dir (if running inside API container) ───
if [[ -d /app/static/agent-builds ]]; then
  cp "$OUTPUT_DIR/kifaa-installer-amd64.msi" /app/static/agent-builds/
  cp "$OUTPUT_DIR/kifaa-installer-386.msi"   /app/static/agent-builds/
  echo "[*] Copied MSIs to /app/static/agent-builds/"
fi

echo "=== Done ==="
ls -lh "$OUTPUT_DIR/"*.msi
