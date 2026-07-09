/**
 * verify-nvidia.ts — NVIDIA NIM provider verification.
 *
 * This is a HONEST verification script. It does NOT invent, hardcode, or
 * reuse any credential. It reads the NVIDIA NIM API key from the settings
 * store (the same path the UI's Settings screen writes to) — or, as a dev
 * fallback, from the NVIDIA_API_KEY environment variable. If no key is
 * available, the script FAILS HONESTLY with a BLOCKED message and prints
 * the exact commands the user needs to run on their own machine to verify.
 *
 * WHAT THIS PROVES (when a key IS available)
 * -------------------------------------------
 *   1. The NVIDIA NIM provider class (src/agent/llm/nvidiaProvider.ts)
 *      instantiates without errors.
 *   2. A real chat-completions HTTP request is sent to
 *      https://integrate.api.nvidia.com/v1/chat/completions with the
 *      Bearer-token Authorization header.
 *   3. The NVIDIA NIM API responds with a stream of OpenAI-compatible
 *      SSE chunks that our CloudProvider's parser correctly converts
 *      into AIStreamEvents (token / done / error).
 *   4. The model emits at least one token in response to the prompt
 *      "say hello in one word".
 *
 * WHAT THIS DOES NOT PROVE
 * ------------------------
 *   - Tool calling (parallel_tool_calls=false workaround) — not exercised
 *     by a no-tools chat. Use verify-settings.ts or verify-refine.ts for
 *     the full tool-calling path.
 *   - Refinement loop / structured spec emission — that's the
 *     verify-refine.ts path.
 *
 * PREREQUISITE
 * ------------
 * Configure the NVIDIA NIM provider in the UI first:
 *   1. Run `npm start`
 *   2. Click the gear icon (top-right)
 *   3. Pick "NVIDIA NIM (unverified)" from the Provider dropdown
 *   4. Paste your nvapi-... key (get one at https://build.nvidia.com)
 *   5. Pick a model (e.g. meta/llama-3.3-70b-instruct)
 *   6. Click "Test connection" — should succeed
 *   7. Click "Save", close the window
 *
 * THEN:
 *   npm run verify:nvidia
 *
 * OR (dev shortcut — no UI needed):
 *   NVIDIA_API_KEY=nvapi-... npm run verify:nvidia
 *
 * EXIT CODES
 * ----------
 *   0 = verification passed (real API call, real response)
 *   1 = fatal error (couldn't build, couldn't spawn electron, etc.)
 *   2 = BLOCKED — no NVIDIA API key configured. The script prints the
 *       exact steps to configure one. This is the EXPECTED state in
 *       sandboxes without credentials.
 *   3 = provider returned an error response (auth failed, rate limited,
 *       model not found, network unreachable, etc.). The transcript is
 *       printed before exit so you can diagnose.
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
console.log('[verify-nvidia] building bundle...');
const build = spawn('npm', ['run', 'build:bundle'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
build.on('close', (code) => {
    if (code !== 0) {
        console.error('[verify-nvidia] build failed with code ' + code);
        process.exit(1);
    }
    runVerify();
});

function runVerify(): void {
    console.log('[verify-nvidia] launching electron in headless NVIDIA-verify mode...');
    console.log('[verify-nvidia] (NVIDIA key is read from settings store OR NVIDIA_API_KEY env)');
    console.log('');

    const env = {
        ...process.env,
        KOVIX_VERIFY_NVIDIA: '1',
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
            console.log('[verify-nvidia] VERIFIED — NVIDIA NIM provider made a real API call.');
        } else if (code === 2) {
            console.log('');
            console.log('[verify-nvidia] BLOCKED — no NVIDIA API key configured.');
            console.log('[verify-nvidia] See the steps printed above to verify locally.');
        } else {
            console.log('');
            console.log('[verify-nvidia] FAILED — verification exited with code ' + code);
        }
        process.exit(code ?? 1);
    });

    child.on('error', (err) => {
        console.error('[verify-nvidia] failed to spawn electron:', err);
        process.exit(1);
    });
}
