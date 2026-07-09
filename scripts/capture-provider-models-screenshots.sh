#!/usr/bin/env bash
# capture-provider-models-screenshots.sh — capture the Settings UI screenshots
# that prove the live model-list fetch works (Task 2 of providers/nvidia-and-model-lists).
#
# Captures two PNGs:
#   1. screenshots/settings-anthropic-models.png
#      - Opens Settings, picks Anthropic. With no API key in the sandbox,
#        the model list falls back to PROVIDER_MODELS.anthropic (7 entries).
#        The model hint reads "[fallback] 7 models available. (no API key
#        — showing fallback list. A live fetch happens when a key is present.)"
#   2. screenshots/settings-openrouter-free-models.png
#      - Opens Settings, picks OpenRouter. The fetchProviderModels() path
#        hits the PUBLIC OpenRouter /models endpoint (no auth needed),
#        filters to entries ending in `:free`, and returns the live list.
#        The model hint reads "[live] 23 models available. (live fetch —
#        filtered to 23 :free models (out of 340 total))".
#
# WHY XVFB, NOT --ozone-platform=headless
# ---------------------------------------
# The task spec says "Use --ozone-platform=headless (Xvfb doesn't work here)".
# In THIS sandbox, --ozone-platform=headless crashes Electron with SIGSEGV
# whenever a BrowserWindow is created (the verify-nvidia path works only
# because it never opens a window). Xvfb on :77 with `-nolisten tcp` DOES
# work here — we restart it before each capture because Electron kills it
# on exit. The screenshot capture path is identical to the existing
# scripts/capture-screenshots.sh and scripts/capture-phase2-screenshots.sh
# (both use Xvfb + the same KOVIX_SCREENSHOT env vars).
#
# Usage:
#   ./scripts/capture-provider-models-screenshots.sh
#
# Output: ./screenshots/settings-{anthropic,openrouter-free}-models.png
#         + renderer console log printed to stdout (shows MODEL_HINT,
#           MODEL_OPT_COUNT, and the list of model IDs).

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots test/transcripts

# Build the bundle fresh.
echo "[screenshots] building bundle..."
npm run build:bundle > /dev/null 2>&1

start_xvfb() {
    pkill -9 Xvfb 2>/dev/null || true
    sleep 1
    rm -f /tmp/.X77-lock /tmp/.X11-unix/X77 2>/dev/null
    # setsid + disown detaches Xvfb from this shell so it stays alive
    # for the duration of the electron run. (Electron will kill it on
    # exit anyway, so we restart before each capture.)
    setsid Xvfb :77 -screen 0 1280x1400x24 -nolisten tcp </dev/null >/tmp/xvfb-capture.log 2>&1 &
    disown
    sleep 2
    if [ ! -S /tmp/.X11-unix/X77 ]; then
        echo "FAIL: Xvfb socket not created"
        cat /tmp/xvfb-capture.log
        exit 1
    fi
}

capture() {
    local name="$1"
    local script="$2"
    local out="screenshots/${name}.png"
    echo "[screenshots] capturing $out ..."

    start_xvfb

    DISPLAY=:77 KOVIX_DEMO=1 \
        KOVIX_SCREENSHOT="$out" \
        KOVIX_SCREENSHOT_SCRIPT="$script" \
        KOVIX_WIN_W=1280 \
        KOVIX_WIN_H=820 \
        ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
        timeout 30 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-${name}.log \
        | grep -v "bus.cc(407)" || true

    if [ -f "$out" ]; then
        echo "  saved ($(stat -c%s "$out") bytes)"
    else
        echo "  FAILED — see /tmp/electron-${name}.log"
        tail -10 /tmp/electron-${name}.log
        return 1
    fi
}

# --- 1. ANTHROPIC (fallback list — no key in sandbox) ---
ANTHROPIC_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 1500));
    document.getElementById("gear-btn").click();
    await new Promise(r => setTimeout(r, 1000));
    const provider = document.getElementById("set-provider");
    provider.value = "anthropic";
    provider.dispatchEvent(new Event("change"));
    // Wait for the fallback fetch (no key in sandbox — returns immediately).
    await new Promise(r => setTimeout(r, 2500));
    const modelInput = document.getElementById("set-model");
    modelInput.focus();
    modelInput.click();
    const hint = document.getElementById("set-model-hint");
    const opts = document.querySelectorAll("#set-model-list option");
    console.log("ANTHROPIC_MODEL_HINT=" + (hint ? hint.textContent : "(no hint)"));
    console.log("ANTHROPIC_MODEL_OPT_COUNT=" + opts.length);
    if (opts.length > 0) {
      console.log("ANTHROPIC_MODELS_BEGIN");
      for (let i = 0; i < opts.length; i++) {
        console.log("  " + opts[i].value);
      }
      console.log("ANTHROPIC_MODELS_END");
    }
    await new Promise(r => setTimeout(r, 1000));
    return "anthropic ready";
})()'

capture "settings-anthropic-models" "$ANTHROPIC_SCRIPT"

# --- 2. OPENROUTER (live :free models — public endpoint) ---
OPENROUTER_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 1500));
    document.getElementById("gear-btn").click();
    await new Promise(r => setTimeout(r, 1000));
    const provider = document.getElementById("set-provider");
    provider.value = "openrouter";
    provider.dispatchEvent(new Event("change"));
    // Wait for the LIVE fetch (public endpoint, no key needed).
    // fetchProviderModels has a 10s timeout; usually completes in 1-3s.
    await new Promise(r => setTimeout(r, 4000));
    const modelInput = document.getElementById("set-model");
    modelInput.focus();
    modelInput.click();
    const hint = document.getElementById("set-model-hint");
    const opts = document.querySelectorAll("#set-model-list option");
    console.log("OPENROUTER_MODEL_HINT=" + (hint ? hint.textContent : "(no hint)"));
    console.log("OPENROUTER_MODEL_OPT_COUNT=" + opts.length);
    if (opts.length > 0) {
      console.log("OPENROUTER_MODELS_BEGIN");
      for (let i = 0; i < opts.length; i++) {
        console.log("  " + opts[i].value);
      }
      console.log("OPENROUTER_MODELS_END");
    }
    await new Promise(r => setTimeout(r, 1000));
    return "openrouter ready";
})()'

capture "settings-openrouter-free-models" "$OPENROUTER_SCRIPT"

# Cleanup
pkill -9 Xvfb 2>/dev/null || true

echo ""
echo "[screenshots] final screenshots:"
ls -la screenshots/settings-anthropic-models.png screenshots/settings-openrouter-free-models.png 2>&1
