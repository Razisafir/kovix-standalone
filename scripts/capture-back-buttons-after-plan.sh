#!/usr/bin/env bash
# capture-back-buttons-after-plan.sh — capture the Plan screen on the
# feat/back-buttons branch, showing the Back button between Start over
# and Approve.
#
# Output: ./screenshots/back-buttons-after-plan.png

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT="screenshots/back-buttons-after-plan.png"
mkdir -p screenshots

echo "[after-plan] building bundle..."
npm run build:bundle > /dev/null 2>&1

DISPLAY_NUM=81
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-after-plan.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[after-plan] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-after-plan.log
    exit 1
fi

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
    console.log("[after-plan] plan-back-present=" + hasBack);
    // Scroll the plan-actions row into view so the Back button is visible.
    const planActions = document.querySelector("#state-plan .spec-actions");
    if (planActions) planActions.scrollIntoView({ block: "center" });
    await sleep(400);
    return { ok: true, planBackPresent: hasBack };
})()'

echo "[after-plan] capturing $OUT ..."
DISPLAY=:${DISPLAY_NUM} \
    KOVIX_DEMO=1 \
    KOVIX_SCREENSHOT="$OUT" \
    KOVIX_SCREENSHOT_SCRIPT="$PLAN_SCRIPT" \
    KOVIX_WIN_W=1280 \
    KOVIX_WIN_H=1200 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    timeout 40 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-after-plan.log

echo ""
if [ -f "$OUT" ]; then
    echo "[after-plan] screenshot saved: $OUT ($(stat -c%s "$OUT") bytes)"
else
    echo "[after-plan] FAILED — no screenshot captured"
    tail -10 /tmp/electron-after-plan.log
fi
