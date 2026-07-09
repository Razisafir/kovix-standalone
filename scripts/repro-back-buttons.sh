#!/usr/bin/env bash
# repro-back-buttons.sh — verify the Back buttons on the spec + plan screens.
#
# Drives the full flow in DEMO_MODE:
#   idea -> refine (3 Q&A) -> spec
#     -> [BACK] spec -> refine (verify conversation preserved)
#     -> answer 1 more question -> spec (regenerated)
#     -> Approve spec -> plan
#     -> [BACK] plan -> spec (verify spec unlocked + editable)
#
# Captures a single screenshot at the final state (back on the spec screen,
# editable) and prints a diagnostic log so we can confirm both Back buttons
# actually worked.
#
# Usage:
#   ./scripts/repro-back-buttons.sh [output-png-name]
#
# Output: ./screenshots/<name>.png  (default: back-buttons-after.png)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_NAME="${1:-back-buttons-after}"
OUT="screenshots/${OUT_NAME}.png"
mkdir -p screenshots

echo "[repro] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start Xvfb
DISPLAY_NUM=79
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-back.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[repro] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-back.log
    exit 1
fi

# The repro script. Drives the full flow then exercises both Back buttons.
# Returns diagnostic JSON via executeJavaScript result.
REPRO_SCRIPT='(async () => {
    const log = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = (id) => !document.getElementById(id).classList.contains("hidden");

    try {
        await sleep(1000);
        log.push("initial-ready");

        // --- First refinement: idea -> 3 Q&A -> spec ---
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
        log.push("after-1st-refine spec-visible=" + visible("state-spec"));

        // Snapshot: how many turns are in the conversation?
        const convTurnsBefore = document.getElementById("conversation").children.length;
        log.push("conversation-turns-before-back=" + convTurnsBefore);

        // --- [BACK] spec -> refine ---
        const specBack = document.getElementById("spec-back");
        if (!specBack) {
            log.push("FAIL: spec-back button missing");
            return { ok: false, log: log, error: "spec-back button missing" };
        }
        specBack.click();
        await sleep(600);
        log.push("after-spec-back refine-visible=" + visible("state-refine") + " spec-visible=" + visible("state-spec"));

        // Conversation should be preserved (same number of turns).
        const convTurnsAfterBack = document.getElementById("conversation").children.length;
        log.push("conversation-turns-after-back=" + convTurnsAfterBack);
        log.push("conversation-preserved=" + (convTurnsAfterBack === convTurnsBefore));

        // Answer one more question to regenerate the spec.
        const ans = document.getElementById("answer-input");
        ans.value = "Actually, also support a --quiet flag.";
        ans.dispatchEvent(new Event("input"));
        document.getElementById("answer-send").click();
        await sleep(900);
        log.push("after-extra-answer spec-visible=" + visible("state-spec"));

        // --- Approve spec -> plan ---
        document.getElementById("spec-approve").click();
        await sleep(1500); // plan generation
        log.push("after-spec-approve plan-visible=" + visible("state-plan"));

        // --- [BACK] plan -> spec ---
        const planBack = document.getElementById("plan-back");
        if (!planBack) {
            log.push("FAIL: plan-back button missing");
            return { ok: false, log: log, error: "plan-back button missing" };
        }
        planBack.click();
        await sleep(600);
        log.push("after-plan-back spec-visible=" + visible("state-spec") + " plan-visible=" + visible("state-plan"));

        // Verify the spec is editable again (not locked).
        const specCard = document.getElementById("spec-card");
        const isLocked = specCard.classList.contains("spec-locked");
        log.push("spec-unlocked-after-plan-back=" + (!isLocked));

        // Verify the spec-approve button is enabled (not stuck loading).
        const specApprove = document.getElementById("spec-approve");
        log.push("spec-approve disabled=" + specApprove.disabled + " text=" + JSON.stringify(specApprove.textContent));

        // Verify the plan UI was torn down.
        const planMilestones = document.getElementById("plan-milestones");
        log.push("plan-milestones-empty=" + (planMilestones.children.length === 0));

        // Final diagnosis.
        const bothWorked =
            visible("state-spec") &&
            !isLocked &&
            !specApprove.disabled &&
            (convTurnsAfterBack === convTurnsBefore);
        log.push("DIAGNOSIS both-back-buttons-work=" + bothWorked);

        // Scroll the spec-actions row (with the Back button) into view so
        // the screenshot actually shows it. The spec screen is taller than
        // the viewport, so without this the buttons are below the fold.
        const specActions = document.querySelector("#state-spec .spec-actions");
        if (specActions) specActions.scrollIntoView({ block: "center" });
        await sleep(400);

        return { ok: bothWorked, log: log };
    } catch (err) {
        return { ok: false, error: String(err), log: log };
    }
})()'

echo "[repro] capturing $OUT ..."
DISPLAY=:${DISPLAY_NUM} \
    KOVIX_DEMO=1 \
    KOVIX_SCREENSHOT="$OUT" \
    KOVIX_SCREENSHOT_SCRIPT="$REPRO_SCRIPT" \
    KOVIX_WIN_W=1280 \
    KOVIX_WIN_H=1200 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    timeout 45 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-back.log

echo ""
echo "[repro] electron log (last 25 lines):"
tail -25 /tmp/electron-back.log 2>/dev/null

if [ -f "$OUT" ]; then
    echo "[repro] screenshot saved: $OUT ($(stat -c%s "$OUT") bytes)"
else
    echo "[repro] FAILED — no screenshot captured"
fi
