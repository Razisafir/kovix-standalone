#!/usr/bin/env bash
# repro-diagnostic.sh — run a diagnostic JS script in the renderer and print results.
# Usage: ./scripts/repro-diagnostic.sh /path/to/script.js [screenshot-name]

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SCRIPT_FILE="$1"
SHOT_NAME="${2:-diag}"
OUT="screenshots/${SHOT_NAME}.png"
mkdir -p screenshots

if [ -z "$SCRIPT_FILE" ] || [ ! -f "$SCRIPT_FILE" ]; then
    echo "Usage: $0 <script.js> [screenshot-name]"
    exit 1
fi

SCRIPT_CONTENT="$(cat "$SCRIPT_FILE")"

echo "[diag] building bundle..."
npm run build:bundle > /dev/null 2>&1

DISPLAY_NUM=79
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-diag.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[diag] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-diag.log
    exit 1
fi

echo "[diag] running script..."
DISPLAY=:${DISPLAY_NUM} \
    KOVIX_DEMO=1 \
    KOVIX_SCREENSHOT="$OUT" \
    KOVIX_SCREENSHOT_SCRIPT="$SCRIPT_CONTENT" \
    KOVIX_WIN_W=1280 \
    KOVIX_WIN_H=1200 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    timeout 45 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-diag.log

echo ""
echo "[diag] result:"
grep "screenshot script result" /tmp/electron-diag.log || echo "(no result line found)"
echo ""
echo "[diag] screenshot: $OUT ($(stat -c%s "$OUT" 2>/dev/null || echo 0) bytes)"
