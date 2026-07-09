#!/usr/bin/env bash
# capture-back-buttons-before.sh — capture spec + plan screens on main
# (before the Back buttons existed) to prove they were missing.
#
# Outputs:
#   screenshots/back-buttons-before-spec.png
#   screenshots/back-buttons-before-plan.png

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots

echo "[before] building bundle..."
npm run build:bundle > /dev/null 2>&1

DISPLAY_NUM=80
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-before.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

run_capture() {
    local OUT="$1"
    local SCRIPT="$2"
    echo "[before] capturing $OUT ..."
    DISPLAY=:${DISPLAY_NUM} \
        KOVIX_DEMO=1 \
        KOVIX_SCREENSHOT="$OUT" \
        KOVIX_SCREENSHOT_SCRIPT="$SCRIPT" \
        KOVIX_WIN_W=1280 \
        KOVIX_WIN_H=1200 \
        ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
        timeout 40 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-before.log
    if [ -f "$OUT" ]; then
        echo "[before] saved: $OUT ($(stat -c%s "$OUT") bytes)"
    else
        echo "[before] FAILED — no screenshot captured"
        tail -10 /tmp/electron-before.log
    fi
}

# Drive: idea -> 3 Q&A -> spec screen. Then check whether spec-back exists.
SPEC_SCRIPT='(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    await sleep(1000);
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    await sleep(200);
    document.getElementById("idea-start").click();
    await sleep(800);
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await sleep(700);
    }
    await sleep(500);
    const hasBack = !!document.getElementById("spec-back");
    console.log("[before] spec-back-present=" + hasBack);
    // Scroll the spec-actions row into view so the screenshot shows the
    // button row (Start over + Approve — no Back on main).
    const specActions = document.querySelector("#state-spec .spec-actions");
    if (specActions) specActions.scrollIntoView({ block: "center" });
    await sleep(400);
    return { ok: true, specBackPresent: hasBack };
})()'

run_capture "screenshots/back-buttons-before-spec.png" "$SPEC_SCRIPT"

# Drive: idea -> 3 Q&A -> spec -> approve -> plan. Check plan-back.
PLAN_SCRIPT='(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    await sleep(1000);
    const idea = document.getElementById("idea-input");
    idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
    idea.dispatchEvent(new Event("input"));
    await sleep(200);
    document.getElementById("idea-start").click();
    await sleep(800);
    for (let i = 0; i < 3; i++) {
        const ans = document.getElementById("answer-input");
        ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await sleep(700);
    }
    await sleep(500);
    document.getElementById("spec-approve").click();
    await sleep(1500);
    const hasBack = !!document.getElementById("plan-back");
    console.log("[before] plan-back-present=" + hasBack);
    // Scroll the plan-actions row into view so the screenshot shows the
    // button row (Start over + Approve — no Back on main).
    const planActions = document.querySelector("#state-plan .spec-actions");
    if (planActions) planActions.scrollIntoView({ block: "center" });
    await sleep(400);
    return { ok: true, planBackPresent: hasBack };
})()'

run_capture "screenshots/back-buttons-before-plan.png" "$PLAN_SCRIPT"

echo "[before] done."
