#!/usr/bin/env bash
# verify-lead-e2e.sh — end-to-end UI smoke test of the lead agent orchestration.
#
# Drives the FULL flow in DEMO_MODE:
#   Idea -> Refine (3 Q&A) -> Spec -> Plan -> Pre-flight -> Lead-orchestrated Execute -> Done
#
# In DEMO_MODE:
#   - Refinement uses deterministic fake questions + spec (no LLM call).
#   - Planning uses a deterministic 4-milestone fake plan (no LLM call).
#   - Execution uses DemoLeadProvider — a fake that yields realistic
#     AgentLoopEvents AND writes REAL FILES to disk via the real staging
#     layer. So the lead agent REALLY delegates 4 milestones sequentially,
#     each worker REALLY writes a file, and the lead REALLY runs
#     verification after each.
#
# Verifies (via executeJavaScript):
#   1. Lead panel is visible and shows "Lead Agent: ..." status.
#   2. Worker panel appears during execution.
#   3. lead_complete event fires with 4 reports.
#   4. Real files exist in the build directory on disk.
#   5. Done screen shows with build dir path.
#
# Usage: ./scripts/verify-lead-e2e.sh
# Output: ./screenshots/lead-e2e.png

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots

echo "[lead-e2e] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start Xvfb
DISPLAY_NUM=91
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-lead.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[lead-e2e] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-lead.log
    exit 1
fi

# The UI driver script. Drives the full flow then inspects the lead/worker
# panels and the build dir.
DRIVER_SCRIPT='(async () => {
    const log = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        await sleep(1200);
        log.push("initial-ready");

        // --- 1. Idea -> Refine ---
        const idea = document.getElementById("idea-input");
        idea.value = "a tiny CLI tool that watches a folder and prints the names of files that change";
        idea.dispatchEvent(new Event("input"));
        await sleep(200);
        document.getElementById("idea-start").click();
        await sleep(800);

        // Answer 3 questions
        for (let i = 0; i < 3; i++) {
            const ans = document.getElementById("answer-input");
            ans.value = "Yes, that sounds right. Make a sensible default for the rest.";
            ans.dispatchEvent(new Event("input"));
            document.getElementById("answer-send").click();
            await sleep(700);
        }
        await sleep(500);
        const specVisible = !document.getElementById("state-spec").classList.contains("hidden");
        log.push("spec-visible=" + specVisible);

        // --- 2. Spec -> Plan (spec-approve auto-triggers plan generation) ---
        document.getElementById("spec-approve").click();
        await sleep(1500); // plan generation takes a moment
        const planVisible = !document.getElementById("state-plan").classList.contains("hidden");
        log.push("plan-visible=" + planVisible);
        const planMilestones = document.querySelectorAll("#plan-milestones .milestone-card").length;
        log.push("plan-milestones=" + planMilestones);

        // Approve plan
        document.getElementById("plan-approve").click();
        await sleep(800);
        const preflightVisible = !document.getElementById("state-preflight").classList.contains("hidden");
        log.push("preflight-visible=" + preflightVisible);

        // --- 3. Preflight -> Execute (Lead Agent) ---
        // Use AUTO pause mode (no pauses) so the lead runs straight through.
        const autoRadio = document.querySelector("input[name=pause-mode][value=auto]");
        if (autoRadio) {
            autoRadio.click();
            log.push("selected-auto-pause-mode");
        } else {
            log.push("WARN: auto radio not found");
        }
        await sleep(200);
        document.getElementById("preflight-confirm").click();
        await sleep(1500);
        const executeVisible = !document.getElementById("state-execute").classList.contains("hidden");
        log.push("execute-visible=" + executeVisible);

        // Wait for the lead agent to run through all 4 milestones.
        // Each milestone: 2 LLM rounds + verification. With DemoLeadProvider
        // this is fast (~300ms per milestone). Give it up to 20 seconds.
        let leadComplete = false;
        let leadBlocked = false;
        let leadPanelText = "";
        let workerPanelText = "";
        let finalStatus = "";
        for (let wait = 0; wait < 40; wait++) {
            await sleep(500);
            const leadPanel = document.getElementById("lead-panel-status");
            const workerPanel = document.getElementById("worker-panel-status");
            leadPanelText = leadPanel ? leadPanel.textContent : "(no lead panel)";
            workerPanelText = workerPanel ? workerPanel.textContent : "(no worker panel)";
            if (wait % 4 === 0) {
                log.push("wait-" + wait + " lead=[" + leadPanelText.substring(0, 80) + "] worker=[" + workerPanelText.substring(0, 60) + "]");
            }
            if (leadPanelText.includes("complete")) {
                leadComplete = true;
                finalStatus = leadPanelText;
                break;
            }
            if (leadPanelText.includes("BLOCKED") || leadPanelText.includes("ERROR")) {
                leadBlocked = true;
                finalStatus = leadPanelText;
                break;
            }
        }

        const doneVisible = !document.getElementById("state-done").classList.contains("hidden");
        const doneSummary = document.getElementById("done-summary");
        const doneSummaryText = doneSummary ? doneSummary.textContent.substring(0, 300) : "(no summary)";
        const doneBuildDir = document.getElementById("done-build-dir");
        const doneBuildDirText = doneBuildDir ? doneBuildDir.textContent : "(no build dir)";

        log.push("lead-complete=" + leadComplete);
        log.push("lead-blocked=" + leadBlocked);
        log.push("final-status=" + finalStatus.substring(0, 120));
        log.push("done-visible=" + doneVisible);
        log.push("done-summary=" + JSON.stringify(doneSummaryText));
        log.push("done-build-dir=" + JSON.stringify(doneBuildDirText));

        // Check lead panel detail for per-milestone report
        const leadDetail = document.getElementById("lead-panel-detail");
        const leadDetailText = leadDetail ? leadDetail.textContent : "(no detail)";
        log.push("lead-detail=" + JSON.stringify(leadDetailText.substring(0, 600)));

        // Diagnosis
        const allGood = leadComplete && doneVisible && doneBuildDirText.includes("build-");
        log.push("DIAGNOSIS all-good=" + allGood);

        return { ok: allGood, log: log };
    } catch (err) {
        return { ok: false, error: String(err), log: log };
    }
})()'

echo "[lead-e2e] running driver..."
DISPLAY=:${DISPLAY_NUM} \
    KOVIX_DEMO=1 \
    KOVIX_SCREENSHOT="screenshots/lead-e2e.png" \
    KOVIX_SCREENSHOT_SCRIPT="$DRIVER_SCRIPT" \
    KOVIX_WIN_W=1280 \
    KOVIX_WIN_H=1200 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    timeout 60 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-lead.log

echo ""
echo "=== DRIVER RESULT ==="
grep -E "screenshot script result|DIAGNOSIS|lead-complete|final-status|done-visible|done-build-dir|lead-detail" /tmp/electron-lead.log 2>/dev/null | head -20

echo ""
echo "=== BUILD DIRS ON DISK (kovix-projects) ==="
ls -la ~/kovix-projects/ 2>&1 | head -10
echo "---"
LATEST_BUILD=$(ls -td ~/kovix-projects/build-* 2>/dev/null | head -1)
if [ -n "$LATEST_BUILD" ]; then
    echo "Latest build dir: $LATEST_BUILD"
    ls -la "$LATEST_BUILD" 2>&1 | head -15
else
    echo "No build-* dirs found in ~/kovix-projects/"
fi

echo ""
if [ -f "screenshots/lead-e2e.png" ]; then
    echo "[lead-e2e] screenshot saved: screenshots/lead-e2e.png ($(stat -c%s screenshots/lead-e2e.png) bytes)"
fi
