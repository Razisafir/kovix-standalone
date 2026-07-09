/**
 * verify-end-to-end.ts — Phase 2 full-flow verification.
 *
 * Runs ONE real idea through the complete Build mode flow:
 *   Idea → Refinement (real LLM) → Spec approval → Plan (real LLM)
 *   → Pre-flight config → Execute (real staged writes + approval gate +
 *   real disk writes + real verification) → Done
 *
 * PREREQUISITE
 * ------------
 * A provider config MUST be stored in the settings file (the same path the
 * UI's Settings screen writes to). This script reads it via the same
 * resolveProviderConfig() the app uses — it never hardcodes a key.
 *
 *   To set up: run `npm start`, click the gear icon, configure a provider
 *   (e.g. Anthropic + claude-sonnet-5 + your API key), Test connection,
 *   Save, close the window. Then run this script.
 *
 * ENV VARS
 * --------
 *   KOVIX_VERIFY_IDEA   : override the default idea text
 *   KOVIX_VERIFY_PAUSE  : pause mode for preflight ('every'|'major'|'auto'|'custom')
 *                         default: 'auto' (fastest — no pauses)
 *
 * EXIT CODES
 * ----------
 *   0 = all checks passed
 *   1 = fatal error
 *   2 = no provider config (run the UI first to configure)
 *   3 = refinement failed to produce a spec
 *   4 = planning failed to produce milestones
 *   5 = execution failed (no complete event)
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

// Build the bundle first.
console.log('[verify-e2e] building bundle...');
const build = spawn('npm', ['run', 'build:bundle'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
build.on('close', (code) => {
    if (code !== 0) {
        console.error('[verify-e2e] build failed with code ' + code);
        process.exit(1);
    }
    runVerify();
});

function runVerify(): void {
    console.log('[verify-e2e] launching electron in headless e2e verify mode...');
    console.log('[verify-e2e] (provider config is read from the settings store)');
    console.log('');

    const env = {
        ...process.env,
        KOVIX_E2E_VERIFY: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    const child = spawn(electronBin, [
        '.',
        '--no-sandbox',
        '--disable-gpu',
        '--enable-features=UseOzonePlatform',
        '--ozone-platform=headless',
    ], {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    child.on('close', (code) => {
        if (code === 0) {
            console.log('');
            console.log('[verify-e2e] ✅ end-to-end verification complete.');
        } else {
            console.log('');
            console.log('[verify-e2e] ❌ end-to-end verification exited with code ' + code);
        }
        process.exit(code ?? 1);
    });

    child.on('error', (err) => {
        console.error('[verify-e2e] failed to spawn electron:', err);
        process.exit(1);
    });
}
