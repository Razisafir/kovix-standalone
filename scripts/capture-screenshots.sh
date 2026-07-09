#!/usr/bin/env bash
# capture-screenshots.sh — capture the 4 product screenshots:
#   1. settings.png      — the new settings modal (masked key as dots)
#   2. idea.png          — idea input screen
#   3. refining.png      — refinement conversation in progress (demo mode)
#   4. spec.png          — final structured spec
#
# Runs Electron under a directly-launched Xvfb (no xauth needed) so it works
# on a headless server. Uses KOVIX_DEMO=1 so the refinement flow returns
# deterministic fake data — no real API key needed for the screenshots.
# The settings screen is real UI, not demo — but the key shown is a fake
# placeholder (clearly marked).
#
# Usage:
#   ./scripts/capture-screenshots.sh
#
# Output: ./screenshots/{settings,idea,refining,spec}.png

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots

# Build the bundle fresh.
echo "[screenshots] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start a private Xvfb on display :77 (unlikely to collide).
DISPLAY_NUM=77
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1200x24 -nolisten tcp -nolisten unix >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
trap "kill $XVFB_PID 2>/dev/null || true; wait $XVFB_PID 2>/dev/null || true" EXIT

# Give Xvfb a moment to start.
sleep 1.5

# Helper: capture a single screenshot by running electron with a script.
# Optional 3rd arg: window height (default 900).
capture() {
    local name="$1"
    local script="$2"
    local win_h="${3:-900}"
    local out="screenshots/${name}.png"
    echo "[screenshots] capturing $out ..."
    DISPLAY=:${DISPLAY_NUM} \
        KOVIX_DEMO=1 \
        KOVIX_SCREENSHOT="$out" \
        KOVIX_SCREENSHOT_SCRIPT="$script" \
        KOVIX_WIN_W=1280 \
        KOVIX_WIN_H="$win_h" \
        ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
        timeout 30 ./node_modules/.bin/electron . --no-sandbox 2>/tmp/electron-${name}.log
    if [ -f "$out" ]; then
        echo "  saved ($(stat -c%s "$out") bytes)"
    else
        echo "  FAILED — see /tmp/electron-${name}.log"
        tail -5 /tmp/electron-${name}.log
    fi
}

# --- 1. SETTINGS SCREEN ---
# Open the settings modal, pick Anthropic, type a FAKE key (clearly marked),
# pick a model. The masked field will show dots (••••••••) once a key is
# saved — for the screenshot we type a fake one but the field is in
# password mode by default so it shows dots.
SETTINGS_SCRIPT='(async () => {
    await new Promise(r => setTimeout(r, 800));
    document.getElementById("gear-btn").click();
    await new Promise(r => setTimeout(r, 600));
    const provider = document.getElementById("set-provider");
    provider.value = "anthropic";
    provider.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 400));
    const keyInput = document.getElementById("set-apikey");
    // FAKE key — clearly marked as not-real. The field is type=password so
    // it displays as dots in the screenshot.
    keyInput.value = "sk-ant-fake-key-for-screenshot-only-NOT-REAL";
    keyInput.dispatchEvent(new Event("input"));
    const modelInput = document.getElementById("set-model");
    modelInput.value = "claude-sonnet-5";
    await new Promise(r => setTimeout(r, 500));
    return "settings ready";
})()'

capture "settings" "$SETTINGS_SCRIPT"

# --- 2. IDEA SCREEN ---
capture "idea" '(async () => { await new Promise(r => setTimeout(r, 800)); return "idea ready"; })()'

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

capture "refining" "$REFINING_SCRIPT"

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
    // Scroll to top so all 4 spec sections are visible.
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
    return "spec ready";
})()'

capture "spec" "$SPEC_SCRIPT" 1100

echo ""
echo "[screenshots] all 4 screenshots captured:"
ls -la screenshots/
