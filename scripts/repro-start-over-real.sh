#!/usr/bin/env bash
# repro-start-over-real.sh — reproduce the Start Over stuck loading bug
# using a MOCK Ollama server (exercises the REAL provider code path,
# NOT DEMO_MODE).
#
# Starts a tiny Node HTTP server that pretends to be Ollama at
# localhost:11434, returning valid streaming chat responses. Then runs
# the full flow: refine -> 3 Q&A -> spec -> Start Over -> refine again.
#
# Runs TWO consecutive Start Over cycles as the user demanded.
#
# Usage:
#   ./scripts/repro-start-over-real.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots

echo "[repro] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start mock Ollama server
echo "[repro] starting mock Ollama server on :11434..."
MOCK_PORT=11434
node -e "
const http = require('http');
const server = http.createServer((req, res) => {
    const url = req.url;
    console.error('[mock-ollama] ' + req.method + ' ' + url);

    if (url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            models: [{ name: 'llama3.1:latest', model: 'llama3.1', details: { family: 'llama', parameter_size: '8B' } }]
        }));
        return;
    }

    if (url === '/api/chat') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            // Simulate real LLM latency (2-4 seconds per call)
            const latency = 2000 + Math.random() * 2000;
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
                // Read the messages to count how many Q&A rounds we've done.
                let parsed;
                try { parsed = JSON.parse(body); } catch { parsed = {}; }
                const msgs = parsed.messages || [];
                // Count assistant messages (each assistant msg = one question asked)
                const assistantCount = msgs.filter(m => m.role === 'assistant').length;
                // After 3 assistant questions (3 rounds), emit the spec via tool call.
                // Otherwise, emit a question as text.
                if (assistantCount >= 3) {
                    // Emit spec via tool_call
                    const spec = {
                        must: ['CLI accepts a folder path', 'Prints changed file paths'],
                        should: ['Prints a summary every 60s'],
                        wont: ['No GUI', 'No remote sync'],
                        doneCriteria: ['Running the CLI prints a line within 1s of a file change']
                    };
                    // NDJSON: first a content chunk, then tool_call, then done
                    res.write(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'emit_spec', arguments: JSON.stringify(spec) } }] } }) + '\n');
                    res.write(JSON.stringify({ done: true }) + '\n');
                } else {
                    // Emit a question as text content
                    const questions = [
                        'What should the CLI do when a file is deleted?',
                        'Should it ignore any directories by default?',
                        'What output format do you want — one path per line, or JSON?'
                    ];
                    const q = questions[assistantCount] || 'Can you tell me more?';
                    res.write(JSON.stringify({ message: { content: q } }) + '\n');
                    res.write(JSON.stringify({ done: true }) + '\n');
                }
                res.end();
            }, latency);
        });
        return;
    }

    res.writeHead(404);
    res.end('not found');
});
server.listen(${MOCK_PORT}, () => console.error('[mock-ollama] listening on :' + ${MOCK_PORT}));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
" 2>/tmp/mock-ollama.log &
MOCK_PID=$!
cleanup() {
    kill $MOCK_PID 2>/dev/null || true
    wait $MOCK_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1

if ! curl -s http://localhost:${MOCK_PORT}/api/tags > /dev/null 2>&1; then
    echo "[repro] FAIL: mock Ollama server not reachable"
    cat /tmp/mock-ollama.log
    exit 1
fi
echo "[repro] mock Ollama is up"

# Start Xvfb
DISPLAY_NUM=82
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-real.log 2>&1 &
XVFB_PID=$!
cleanup_xvfb() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap 'cleanup; cleanup_xvfb' EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[repro] FAIL: Xvfb socket not created"
    cat /tmp/xvfb-real.log
    exit 1
fi

# The repro script: runs TWO full Start Over cycles.
# Uses the REAL provider path (Ollama pointing at our mock server).
# NO KOVIX_DEMO=1.
REPRO_SCRIPT='(async () => {
    const log = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = (id) => !document.getElementById(id).classList.contains("hidden");

    async function doRefineCycle(cycleNum, ideaText) {
        log.push("=== CYCLE " + cycleNum + " START ===");

        // Type idea and start
        const idea = document.getElementById("idea-input");
        idea.value = ideaText;
        idea.dispatchEvent(new Event("input"));
        await sleep(200);
        const startBtn = document.getElementById("idea-start");
        log.push("cycle" + cycleNum + " pre-click disabled=" + startBtn.disabled + " text=" + JSON.stringify(startBtn.textContent));
        startBtn.click();

        // Wait for refine to resolve (real provider call, 2-4s latency)
        let waited = 0;
        while (waited < 15000) {
            await sleep(500);
            waited += 500;
            const refineVisible = visible("state-refine");
            const specVisible = visible("state-spec");
            const loadingTurn = document.getElementById("loading-turn");
            const btn = document.getElementById("idea-start");
            // refine resolves when: spec visible OR (refine visible AND no loading turn AND answer input enabled)
            if (specVisible) {
                log.push("cycle" + cycleNum + " spec-visible after " + waited + "ms");
                break;
            }
            if (refineVisible && !loadingTurn) {
                const ans = document.getElementById("answer-input");
                if (!ans.disabled) {
                    log.push("cycle" + cycleNum + " question-shown after " + waited + "ms");
                    break;
                }
            }
            // Still loading
            if (waited % 3000 === 0) {
                log.push("cycle" + cycleNum + " still-loading at " + waited + "ms btn-text=" + JSON.stringify(btn.textContent) + " btn-disabled=" + btn.disabled);
            }
        }

        // Answer 3 questions
        for (let i = 0; i < 3; i++) {
            const ans = document.getElementById("answer-input");
            if (ans.disabled) {
                log.push("cycle" + cycleNum + " WARN answer disabled at Q" + (i+1));
                break;
            }
            ans.value = "Yes, make a sensible default.";
            ans.dispatchEvent(new Event("input"));
            document.getElementById("answer-send").click();
            // Wait for next question or spec (2-4s latency)
            let w2 = 0;
            while (w2 < 12000) {
                await sleep(300);
                w2 += 300;
                if (visible("state-spec")) break;
                const loadingTurn = document.getElementById("loading-turn");
                const ans2 = document.getElementById("answer-input");
                if (!loadingTurn && !ans2.disabled) break;
            }
        }
        await sleep(1000);

        const specVisible = visible("state-spec");
        log.push("cycle" + cycleNum + " after-3-answers spec-visible=" + specVisible);

        if (!specVisible) {
            log.push("cycle" + cycleNum + " FAIL: spec not visible after 3 answers");
            return false;
        }

        // Click Start Over
        const specRestart = document.getElementById("spec-restart");
        log.push("cycle" + cycleNum + " clicking Start Over");
        specRestart.click();
        await sleep(800);

        const ideaVisible = visible("state-idea");
        const btnAfter = document.getElementById("idea-start");
        log.push("cycle" + cycleNum + " after-start-over idea-visible=" + ideaVisible + " btn-disabled=" + btnAfter.disabled + " btn-text=" + JSON.stringify(btnAfter.textContent));

        return true;
    }

    try {
        await sleep(1000);
        log.push("initial-ready");

        // Cycle 1
        const ok1 = await doRefineCycle(1, "a tiny CLI tool that watches a folder and prints file changes");
        log.push("cycle1 result=" + ok1);

        // Cycle 2 — the critical one (this is where the bug manifests)
        const ok2 = await doRefineCycle(2, "a markdown note app with daily journaling and tag-based search");
        log.push("cycle2 result=" + ok2);

        // Final diagnosis: the bug is the button staying on "Starting…"
        // (loading state) after clicking Start Refinement. We detect this
        // by checking if the button text is still "Starting…" after the
        // refine call should have resolved.
        const btn = document.getElementById("idea-start");
        const ideaVisible = visible("state-idea");
        const refineVisible = visible("state-refine");
        const specVisible = visible("state-spec");
        const btnText = btn.textContent.trim();
        const isLoading = btnText === "Starting…" || btn.classList.contains("btn-loading");
        // "Stuck" = on refine screen with a loading button (the refine
        // call never resolved) OR on idea screen with the button still
        // in loading state.
        const stuckLoading = isLoading && (refineVisible || ideaVisible);
        log.push("DIAGNOSIS stuck=" + stuckLoading + " btn-text=" + JSON.stringify(btnText) + " btn-disabled=" + btn.disabled + " btn-loading-class=" + btn.classList.contains("btn-loading") + " idea=" + ideaVisible + " refine=" + refineVisible + " spec=" + specVisible);

        return { ok: !stuckLoading, log: log };
    } catch (err) {
        return { ok: false, error: String(err), log: log };
    }
})()'

echo "[repro] running repro (real provider, 2 cycles)..."
DISPLAY=:${DISPLAY_NUM} \
    KOVIX_SCREENSHOT="screenshots/start-over-real.png" \
    KOVIX_SCREENSHOT_SCRIPT="$REPRO_SCRIPT" \
    KOVIX_WIN_W=1280 \
    KOVIX_WIN_H=1200 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    timeout 150 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-real.log

echo ""
echo "=== MOCK OLLAMA LOG ==="
cat /tmp/mock-ollama.log 2>/dev/null
echo ""
echo "=== ELECTRON LOG (filtered to diag + errors) ==="
grep -E "\[diag\]|\[refine\]|Error|error|FAIL|DIAGNOSIS" /tmp/electron-real.log 2>/dev/null | head -60
echo ""
echo "=== ELECTRON LOG (last 20 lines) ==="
tail -20 /tmp/electron-real.log 2>/dev/null
