/**
 * verify-settings.ts — wrapper that runs the Idea → Refinement → Spec flow
 * using the provider config stored in the settings file (the same path the
 * UI's Settings screen writes to).
 *
 * WHY A WRAPPER, NOT A STANDALONE SCRIPT?
 * ---------------------------------------
 * The settings store uses Electron's safeStorage API, which only works inside
 * the Electron main process. So this script spawns `electron .` with
 * KOVIX_VERIFY=1, which makes main.ts run `runHeadlessVerification()` —
 * a function that loads the stored config, builds the RefinementService,
 * drives the refinement loop with scripted answers, and prints the full
 * transcript to stdout.
 *
 * PREREQUISITE
 * ------------
 * You MUST have entered your provider config via the UI first:
 *   1. Run `npm start`
 *   2. Click the gear icon in the top-right
 *   3. Pick provider (e.g. Anthropic), paste API key, pick model
 *   4. Click "Test connection" — must succeed
 *   5. Click "Save"
 *   6. Close the window
 *
 * THEN:
 *   npx tsx test/verify-settings.ts
 *
 * Or with a custom idea:
 *   KOVIX_VERIFY_IDEA="a markdown journal app" npx tsx test/verify-settings.ts
 *
 * EXIT CODES
 * ----------
 *   0 = all checks passed
 *   1 = fatal error
 *   2 = no provider config (run the UI first to configure)
 *   3 = refinement loop exhausted hard cap without emitting spec
 *   4 = some checks failed (see transcript)
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '..');
const electronBin = path.join(repoRoot, 'node_modules', '.bin', 'electron');

if (!fs.existsSync(electronBin)) {
    console.error('FAIL: electron binary not found at ' + electronBin);
    console.error('       Run `npm install` first.');
    process.exit(1);
}

// Make sure the bundle is up to date.
console.log('[verify-settings] building bundle...');
const build = spawn('npm', ['run', 'build:bundle'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
build.on('close', (code) => {
    if (code !== 0) {
        console.error('[verify-settings] build failed with code ' + code);
        process.exit(1);
    }
    runVerify();
});

function runVerify(): void {
    console.log('[verify-settings] launching electron in headless verify mode...');
    console.log('[verify-settings] (provider config is read from the settings store)');
    console.log('');

    const env = { ...process.env, KOVIX_VERIFY: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
    const child = spawn(electronBin, ['.'], {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    child.on('close', (code) => {
        if (code === 0) {
            console.log('');
            console.log('[verify-settings] ✅ verification complete.');
        } else {
            console.log('');
            console.log('[verify-settings] ❌ verification exited with code ' + code);
        }
        process.exit(code ?? 1);
    });

    child.on('error', (err) => {
        console.error('[verify-settings] failed to spawn electron:', err);
        process.exit(1);
    });
}
