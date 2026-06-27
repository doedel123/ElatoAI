#!/usr/bin/env bash
# Switch the StackChan's NVS-stored AI-agent backend.
# Reads NVS, surgically inserts wifi:ota_url=<URL> on the Active page (preserving
# all other keys, including Wi-Fi creds and PHY cal), flashes it back, then
# reads it again and parses to verify.
#
# Usage:
#   switch_backend.sh <URL> [PORT]
#
# Example:
#   switch_backend.sh http://192.168.1.100:8003/xiaozhi/ota/     # your warble host
#   switch_backend.sh https://api.tenclass.net/xiaozhi/ota/      # back to cloud
#
# Serial port (arg 2): macOS /dev/cu.usbmodem*, Linux /dev/ttyACM*.
# Default: PORT=/dev/cu.usbmodem1101
# NVS partition layout (from upstream/firmware/partitions.csv): offset 0x9000, size 0x4000.
#
# Kill any holders of the serial port first (idf-monitor, cat, python-pty).
# This operation resets the chip; expect any running session to drop.
set -euo pipefail

URL="${1:?URL required}"
PORT="${2:-/dev/cu.usbmodem1101}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "python3 (or python) is required" >&2; exit 1; }
command -v esptool >/dev/null 2>&1 || { echo "esptool is required (pipx install esptool)" >&2; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
BEFORE="/tmp/stackchan-nvs-${STAMP}-before.bin"
AFTER="/tmp/stackchan-nvs-${STAMP}-after.bin"
VERIFY="/tmp/stackchan-nvs-${STAMP}-verify.bin"
BACKUP="$HOME/stackchan-nvs-backup-${STAMP}.bin"

echo "==> reading NVS from $PORT to $BEFORE"
esptool --port "$PORT" read-flash 0x9000 0x4000 "$BEFORE"

cp "$BEFORE" "$BACKUP"
echo "==> backup at $BACKUP (contains plaintext Wi-Fi creds; stays out of synced tree)"

echo "==> inserting wifi:ota_url=$URL"
"$PY" "$HERE/nvs_insert.py" "$BEFORE" "$AFTER" wifi ota_url "$URL"

echo "==> parsing modified bin for sanity"
"$PY" "$HERE/nvs_partition_tool.py" "$AFTER" -d minimal -i | grep -E "ota_url|ssid|CRC32" || true

echo "==> flashing $AFTER to $PORT @ 0x9000"
esptool --port "$PORT" write-flash 0x9000 "$AFTER"

echo "==> reading back to $VERIFY"
esptool --port "$PORT" read-flash 0x9000 0x4000 "$VERIFY"

echo "==> on-device verification"
"$PY" "$HERE/nvs_partition_tool.py" "$VERIFY" -d minimal -i | grep -E "ota_url|ssid|password|CRC32" || true

echo "==> done. Open the AI Agent app on the device to trigger OTA + WS."
