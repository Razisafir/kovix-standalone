#!/usr/bin/env bash
# capture-phase2-screenshots.sh — capture Phase 2 screens.
#
# Runs Electron under Xvfb in the SAME shell session (Xvfb backgrounded but
# kept alive for the duration of the script). Uses KOVIX_DEMO=1 so the
# refinement + planning flows return deterministic fake data.
#
# Output: ./screenshots/{spec-approved,plan,preflight,execute}.png

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots

echo "[phase2-screenshots] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start Xvfb in THIS shell session (so it stays alive for all captures)
DISPLAY_NUM=77
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-phase2.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[phase2-screenshots] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-phase2.log
    exit 1
fi

# Helper: capture a single screenshot by running electron with a script.
capture() {
    local name="$1"
    local script="$2"
    local win_h="${3:-1100}"
    local out="screenshots/${name}.png"
    echo "[phase2-screenshots] capturing $out ..."

    DISPLAY=:${DISPLAY_NUM} \
        KOVIX_DEMO=1 \
        KOVIX_SCREENSHOT="$out" \
        KOVIX_SCREENSHOT_SCRIPT="$script" \
        KOVIX_WIN_W=1280 \
        KOVIX_WIN_H="$win_h" \
        ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
        timeout 30 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-phase2-${name}.log

    if [ -f "$out" ]; then
        echo "  saved ($(stat -c%s "$out") bytes)"
    else
        echo "  FAILED — see /tmp/electron-phase2-${name}.log"
        tail -8 /tmp/electron-phase2-${name}.log 2>/dev/null
    fi
}

# --- 1. SPEC APPROVED (editable state with Approve button) ---
SPEC_APPROVED_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 1000));
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

# --- 2. PLAN SCREEN ---
PLAN_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 1000));
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

# --- 3. PREFLIGHT SCREEN ---
PREFLIGHT_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 1000));
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

# --- 4. EXECUTE SCREEN ---
EXECUTE_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 1000));
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
echo "[phase2-screenshots] Phase 2 screenshots captured:"
ls -la screenshots/spec-approved.png screenshots/plan.png screenshots/preflight.png screenshots/execute.png 2>&1
