/**
 * check-stored-key.ts — check whether a REAL Anthropic API key is stored.
 *
 * This script uses the app's OWN settingsStore module (via the main process)
 * to inspect stored provider config. It does NOT read env vars by itself and
 * does NOT hardcode anything.
 *
 * Why spawn Electron: settingsStore.ts imports `electron` and uses
 * `app.getPath('userData')` to locate the settings file, so the only way to
 * call `resolveProviderConfig()` faithfully is inside the Electron runtime.
 * The main process has a `KOVIX_CHECK_KEY=1` branch (added in the same commit
 * as this script) that does the check and prints structured output. This
 * script parses that output and translates it into a YES/NO answer with
 * exit code 0 (key present) or 2 (no key).
 *
 * Usage:
 *   npx tsx scripts/check-stored-key.ts
 *
 * Exit codes:
 *   0 = real cloud-provider key present in the settings store
 *   2 = no real key present (settings file missing, or no key, or only a
 *       local/free provider like ollama)
 *   1 = unexpected error (electron failed to spawn, output unparseable, etc.)
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

// Build the bundle first so the latest main.ts is what Electron loads.
console.log('[check-stored-key] building bundle...');
const build = spawn('npm', ['run', 'build:bundle'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
});
build.on('close', (code) => {
    if (code !== 0) {
        console.error('[check-stored-key] build failed with code ' + code);
        process.exit(1);
    }
    runCheck();
});

function runCheck(): void {
    console.log('[check-stored-key] launching electron to inspect settings store...');
    console.log('');

    const env = {
        ...process.env,
        KOVIX_CHECK_KEY: '1',
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
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
        // The main process prints structured lines starting with
        // "CHECK_KEY:" that we parse here. Anything else is echoed as-is for
        // debugging.
        if (stdout.trim().length > 0) {
            process.stdout.write(stdout);
        }
        if (stderr.trim().length > 0) {
            process.stderr.write(stderr);
        }

        const lines = stdout.split('\n').map((l) => l.trim());
        const present = lines.find((l) => l.startsWith('CHECK_KEY:KEY_PRESENT='));
        if (!present) {
            console.error('');
            console.error('[check-stored-key] ERROR: did not receive CHECK_KEY:KEY_PRESENT= line from main process.');
            console.error('[check-stored-key] electron exit code: ' + code);
            process.exit(1);
        }

        const value = present.replace('CHECK_KEY:KEY_PRESENT=', '').trim();
        const isPresent = value === 'YES';

        // Re-print the parsed fields in the user-facing format requested by
        // the task. The main process already printed them, but we re-print so
        // the YES/NO answer is unambiguous and at the end.
        const getField = (key: string): string | null => {
            const line = lines.find((l) => l.startsWith('CHECK_KEY:' + key + '='));
            return line ? line.replace('CHECK_KEY:' + key + '=', '').trim() : null;
        };
        const provider = getField('PROVIDER');
        const source = getField('SOURCE');
        const model = getField('MODEL');
        const masked = getField('KEY_MASKED');
        const settingsPath = getField('SETTINGS_PATH');
        const reason = getField('REASON');

        console.log('');
        console.log('=== check-stored-key summary ===');
        console.log('Real key present: ' + (isPresent ? 'YES' : 'NO'));
        if (provider) { console.log('Provider: ' + provider); }
        if (source) { console.log('Source:   ' + source); }
        if (model) { console.log('Model:    ' + model); }
        if (masked) { console.log('Key (masked, first 8 + last 4): ' + masked); }
        if (settingsPath) { console.log('Settings file: ' + settingsPath); }
        if (reason) { console.log('Reason:   ' + reason); }
        console.log('');
        console.log('Exit code: ' + (isPresent ? 0 : 2));
        process.exit(isPresent ? 0 : 2);
    });

    child.on('error', (err) => {
        console.error('[check-stored-key] failed to spawn electron:', err);
        process.exit(1);
    });
}
