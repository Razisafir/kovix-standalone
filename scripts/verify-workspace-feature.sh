#!/usr/bin/env bash
# verify-workspace-feature.sh — verify the workspace folder picker feature.
#
# Verifies:
# 1. The workspace chip is visible in the topbar on launch
# 2. The default workspace path is ~/Documents/kovix-projects
# 3. kovixAPI.workspace.get() returns the correct path
# 4. kovixAPI.workspace.open() is callable (returns ok or error, doesn't crash)
# 5. The "Open folder" button exists on the Done screen (initially disabled)
#
# NOTE: The OS directory picker (dialog.showOpenDialog) can't be automated
# in headless mode, so we verify the wiring but not the picker dialog itself.
# The picker is verified manually by the user.
#
# Usage: ./scripts/verify-workspace-feature.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p screenshots

echo "[verify] building bundle..."
npm run build:bundle > /dev/null 2>&1

# Start Xvfb
DISPLAY_NUM=83
rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null || true
Xvfb :${DISPLAY_NUM} -screen 0 1280x1400x24 -nolisten tcp >/tmp/xvfb-ws.log 2>&1 &
XVFB_PID=$!
cleanup() {
    kill $XVFB_PID 2>/dev/null || true
    wait $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 1.5

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUM} ]; then
    echo "[verify] FAIL: Xvfb socket not created"
    exit 1
fi

VERIFY_SCRIPT='(async () => {
    const log = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        await sleep(1500);
        log.push("initial-ready");

        // 1. Check workspace chip is visible
        const chip = document.getElementById("workspace-chip");
        const chipVisible = chip && !chip.classList.contains("hidden");
        log.push("workspace-chip-visible=" + chipVisible);

        // 2. Check workspace path text is populated
        const pathEl = document.getElementById("workspace-chip-path");
        const pathText = pathEl ? pathEl.textContent : "(no element)";
        log.push("workspace-chip-path=" + JSON.stringify(pathText));

        // 3. Check Change button exists
        const changeBtn = document.getElementById("workspace-change-btn");
        log.push("change-btn-exists=" + !!changeBtn);

        // 4. Call kovixAPI.workspace.get() and verify
        const wsResult = await kovixAPI.workspace.get();
        log.push("workspace-get dir=" + JSON.stringify(wsResult.dir));
        log.push("workspace-get isDefault=" + wsResult.isDefault);

        // 5. Verify the default path contains kovix-projects
        const isKovixProjects = wsResult.dir.includes("kovix-projects");
        log.push("default-contains-kovix-projects=" + isKovixProjects);

        // 6. Check Done screen has Open folder button (initially disabled)
        const openFolderBtn = document.getElementById("done-open-folder");
        log.push("open-folder-btn-exists=" + !!openFolderBtn);
        log.push("open-folder-btn-disabled=" + (openFolderBtn ? openFolderBtn.disabled : "n/a"));

        // 7. Call kovixAPI.workspace.open() — should return ok or error (not crash)
        // We pass a known path (the workspace dir itself) to test the IPC.
        const openResult = await kovixAPI.workspace.open(wsResult.dir);
        log.push("workspace-open ok=" + openResult.ok + " error=" + JSON.stringify(openResult.error || null));

        // 8. Check that the workspace dir actually exists on disk
        // (the default path should have been created by getEffectiveWorkspaceDir)
        // We cannot check disk from the renderer, but we can verify the IPC
        // returned a non-empty path.

        const allGood = chipVisible && changeBtn && isKovixProjects && openFolderBtn && wsResult.dir;
        log.push("DIAGNOSIS all-good=" + allGood);

        return { ok: allGood, log: log };
    } catch (err) {
        return { ok: false, error: String(err), log: log };
    }
})()'

echo "[verify] running verification..."
DISPLAY=:${DISPLAY_NUM} \
    KOVIX_DEMO=1 \
    KOVIX_SCREENSHOT="screenshots/workspace-feature.png" \
    KOVIX_SCREENSHOT_SCRIPT="$VERIFY_SCRIPT" \
    KOVIX_WIN_W=1280 \
    KOVIX_WIN_H=1200 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    timeout 30 ./node_modules/.bin/electron . --no-sandbox --disable-gpu 2>/tmp/electron-ws.log

echo ""
echo "=== VERIFICATION RESULT ==="
grep -E "screenshot script result|workspace-|DIAGNOSIS|open-folder|change-btn" /tmp/electron-ws.log 2>/dev/null | head -20

echo ""
echo "=== WORKSPACE DIR ON DISK ==="
ls -la ~/Documents/kovix-projects 2>&1 | head -5

echo ""
if [ -f "screenshots/workspace-feature.png" ]; then
    echo "[verify] screenshot saved: screenshots/workspace-feature.png ($(stat -c%s screenshots/workspace-feature.png) bytes)"
fi
