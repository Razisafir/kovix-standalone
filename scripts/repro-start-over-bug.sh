#!/usr/bin/env bash
# repro-start-over-bug.sh — reproduce the "Start over -> stuck loading" bug.
#
# Drives the full flow: idea -> refine (3 Q&A) -> spec -> Start over -> new idea
# -> click Start Refinement. Captures a screenshot at the end and prints the
# diagnostic log from the renderer.
#
# Usage:
#   ./scripts/repro-start-over-bug.sh [output-png-name]
#
# Output: ./screenshots/<name>.png  (default: bug-repro.png)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_NAME="${1:-bug-repro}"
OUT="screenshots/${OUT_NAME}.png"
mkdir -p screenshots

echo "[repro] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start Xvfb
DISPLAY_NUM=78
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-repro.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[repro] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-repro.log
    exit 1
fi

# The repro script. Drives the full flow then attempts a second refinement.
# Returns diagnostic JSON via executeJavaScript result.
REPRO_SCRIPT='(async () => {
    const log = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        await sleep(1000);
        log.push("initial-ready");

        // --- First refinement ---
        const idea = document.getElementById("idea-input");
        idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
        idea.dispatchEvent(new Event("input"));
        await sleep(200);
        const startBtn = document.getElementById("idea-start");
        log.push("pre-1st-click disabled=" + startBtn.disabled + " text=" + JSON.stringify(startBtn.textContent));
        startBtn.click();
        await sleep(800);

        const answerInput = document.getElementById("answer-input");
        log.push("after-1st-refine answerDisabled=" + answerInput.disabled);

        for (let i = 0; i < 3; i++) {
            const ans = document.getElementById("answer-input");
            ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
            ans.dispatchEvent(new Event("input"));
            document.getElementById("answer-send").click();
            await sleep(700);
        }
        await sleep(500);

        const specScreen = document.getElementById("state-spec");
        const specVisible = !specScreen.classList.contains("hidden");
        log.push("spec-visible=" + specVisible);

        // --- Start over ---
        const specRestart = document.getElementById("spec-restart");
        log.push("pre-click-spec-restart");
        specRestart.click();
        await sleep(700);

        const ideaScreen = document.getElementById("state-idea");
        const ideaVisible = !ideaScreen.classList.contains("hidden");
        log.push("idea-visible-after-restart=" + ideaVisible);

        const startBtn2 = document.getElementById("idea-start");
        log.push("after-restart btn disabled=" + startBtn2.disabled + " text=" + JSON.stringify(startBtn2.textContent));

        // --- Type a new idea ---
        const idea2 = document.getElementById("idea-input");
        idea2.value = "a markdown note app with daily journaling and tag-based search";
        idea2.dispatchEvent(new Event("input"));
        await sleep(200);
        log.push("after-type-new-idea btn disabled=" + startBtn2.disabled);

        // --- Click Start Refinement again ---
        log.push("pre-2nd-click");
        startBtn2.click();
        log.push("post-2nd-click btn disabled=" + startBtn2.disabled + " text=" + JSON.stringify(startBtn2.textContent));

        // Wait for it to (hopefully) resolve
        await sleep(2500);

        const startBtn3 = document.getElementById("idea-start");
        const refineScreen = document.getElementById("state-refine");
        const refineVisible = !refineScreen.classList.contains("hidden");
        const ideaVisible2 = !ideaScreen.classList.contains("hidden");
        const conversation = document.getElementById("conversation");
        const loadingTurn = document.getElementById("loading-turn");
        log.push("AFTER-2ND-REFINE btn-text=" + JSON.stringify(startBtn3.textContent) + " btn-disabled=" + startBtn3.disabled);
        log.push("AFTER-2ND-REFINE refine-visible=" + refineVisible + " idea-visible=" + ideaVisible2);
        log.push("AFTER-2ND-REFINE loading-turn-present=" + !!loadingTurn);
        log.push("AFTER-2ND-REFINE conversation-children=" + conversation.children.length);
        if (conversation.children.length > 0) {
            log.push("AFTER-2ND-REFINE first-child-class=" + conversation.children[0].className);
        }

        // Diagnose: did the 2nd refinement succeed?
        const stuck = startBtn3.disabled && refineVisible && !!loadingTurn;
        log.push("DIAGNOSIS stuck=" + stuck);

        return { ok: true, log: log };
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
    timeout 45 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-repro.log

echo ""
echo "[repro] electron log (last 20 lines):"
tail -20 /tmp/electron-repro.log 2>/dev/null

if [ -f "$OUT" ]; then
    echo "[repro] screenshot saved: $OUT ($(stat -c%s "$OUT") bytes)"
else
    echo "[repro] FAILED — no screenshot captured"
fi
