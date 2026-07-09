#!/usr/bin/env bash
# capture-screens-ozone.sh — capture all Build Mode screens.
#
# Runs Electron under a private Xvfb display in the SAME shell session.
# Uses KOVIX_DEMO=1 so refine/plan/exec return deterministic fake data.
#
# Usage: ./scripts/capture-screens-ozone.sh <out-dir> [win_h]
#   <out-dir>   — directory to write screenshots into (created if missing)
#   [win_h]     — optional window height override (default 1100)
#
# Output: <out-dir>/{settings,idea,refining,spec,spec-approved,plan,preflight,execute}.png

set -e

OUT_DIR="${1:-screenshots/capture}"
WIN_H_DEFAULT="${2:-1100}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p "$OUT_DIR"

echo "[screenshots] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start Xvfb on a private display.
DISPLAY_NUM=77
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1600x24 -nolisten tcp -ac >/tmp/xvfb-capture.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5
if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[screenshots] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-capture.log
    exit 1
fi

capture() {
    local name="$1"
    local script="$2"
    local win_h="${3:-$WIN_H_DEFAULT}"
    local out="$OUT_DIR/${name}.png"
    echo "[screenshots] capturing $out ..."
    DISPLAY=:${DISPLAY_NUM} \
        KOVIX_DEMO=1 \
        KOVIX_SCREENSHOT="$out" \
        KOVIX_SCREENSHOT_SCRIPT="$script" \
        KOVIX_WIN_W=1280 \
        KOVIX_WIN_H="$win_h" \
        ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
        timeout 40 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-capture-${name}.log
    if [ -f "$out" ]; then
        echo "  saved ($(stat -c%s "$out") bytes)"
    else
        echo "  FAILED — see /tmp/electron-capture-${name}.log"
        tail -8 /tmp/electron-capture-${name}.log 2>/dev/null
    fi
}

# --- 1. SETTINGS SCREEN ---
SETTINGS_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    document.getElementById("gear-btn").click();
    await new Promise(r => setTimeout(r, 600));
    const provider = document.getElementById("set-provider");
    provider.value = "anthropic";
    provider.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 400));
    const keyInput = document.getElementById("set-apikey");
    keyInput.value = "sk-ant-fake-key-for-screenshot-only-NOT-REAL";
    keyInput.dispatchEvent(new Event("input"));
    const modelInput = document.getElementById("set-model");
    modelInput.value = "claude-sonnet-5";
    await new Promise(r => setTimeout(r, 500));
    return "settings ready";
})()'
capture "settings" "$SETTINGS_SCRIPT" 900

# --- 2. IDEA SCREEN ---
capture "idea" '(async () => { await new Promise(r => setTimeout(r, 800)); return "idea ready"; })()' 900

# --- 3. REFINING SCREEN ---
REFINING_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    document.getElementById("idea-start").click();
    await new Promise(r => setTimeout(r, 1500));
    return "refining ready";
})()'
capture "refining" "$REFINING_SCRIPT" 900

# --- 4. SPEC SCREEN ---
SPEC_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    document.getElementById("idea-start").click();
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await new Promise(r => setTimeout(r, 1000));
    }
    await new Promise(r => setTimeout(r, 800));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
    return "spec ready";
})()'
capture "spec" "$SPEC_SCRIPT" 1100

# --- 5. SPEC APPROVED (locked, plan generating) ---
SPEC_APPROVED_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    document.getElementById("idea-start").click();
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await new Promise(r => setTimeout(r, 1200));
    }
    await new Promise(r => setTimeout(r, 700));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 400));
    return "spec-approved ready";
})()'
capture "spec-approved" "$SPEC_APPROVED_SCRIPT" 1200

# --- 6. PLAN SCREEN ---
PLAN_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    document.getElementById("idea-start").click();
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await new Promise(r => setTimeout(r, 1200));
    }
    await new Promise(r => setTimeout(r, 700));
    document.getElementById("spec-approve").click();
    await new Promise(r => setTimeout(r, 1800));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 400));
    return "plan ready";
})()'
capture "plan" "$PLAN_SCRIPT" 1400

# --- 7. PREFLIGHT SCREEN ---
PREFLIGHT_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    document.getElementById("idea-start").click();
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await new Promise(r => setTimeout(r, 1200));
    }
    await new Promise(r => setTimeout(r, 700));
    document.getElementById("spec-approve").click();
    await new Promise(r => setTimeout(r, 1800));
    document.getElementById("plan-approve").click();
    await new Promise(r => setTimeout(r, 900));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 400));
    return "preflight ready";
})()'
capture "preflight" "$PREFLIGHT_SCRIPT" 1100

# --- 8. EXECUTE SCREEN ---
EXECUTE_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    document.getElementById("idea-start").click();
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await new Promise(r => setTimeout(r, 1200));
    }
    await new Promise(r => setTimeout(r, 700));
    document.getElementById("spec-approve").click();
    await new Promise(r => setTimeout(r, 1800));
    document.getElementById("plan-approve").click();
    await new Promise(r => setTimeout(r, 900));
    document.getElementById("preflight-confirm").click();
    await new Promise(r => setTimeout(r, 1500));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 400));
    return "execute ready";
})()'
capture "execute" "$EXECUTE_SCRIPT" 1400

echo ""
echo "[screenshots] all captures written to $OUT_DIR:"
ls -la "$OUT_DIR" 2>&1
