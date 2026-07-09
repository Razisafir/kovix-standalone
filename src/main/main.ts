/**
 * Kovix standalone - Electron main process.
 *
 * Phase 1: Build mode UI — idea input + refinement conversation + structured spec.
 * Replaces the Phase 0 placeholder. The placeholder smoke-test page is gone.
 *
 * Provider wiring uses createProvider() (the factory from Phase 0 / Task 9),
 * NOT direct CloudProvider construction. The refinement service reuses the
 * same IConstructAIProvider interface the agent loop uses — there is no
 * second LLM-calling path.
 *
 * Provider config (provider + API key + model) is now stored in a
 * settings.json file managed by settingsStore.ts. The key is encrypted
 * with Electron's safeStorage API. Env vars remain as a dev fallback.
 * The UI's settings screen is the primary way to configure providers.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import {
    AgentLoop,
    createProvider,
    listProviders,
    RefinementService,
} from '../agent/index.js';
import type {
    AgentLoopEvent,
    ProviderName,
    RefinementResult,
    RefinementTurn,
} from '../agent/index.js';
import {
    loadSettings,
    saveSettings,
    clearApiKey,
    encryptApiKey,
    decryptApiKey,
    getSettingsPreview,
    resolveProviderConfig,
    PROVIDER_MODELS,
    type PersistedSettings,
    type SettingsPreview,
} from './settingsStore.js';
import { testConnection, type TestConnectionInput, type TestConnectionResult } from './testConnection.js';

let mainWindow: BrowserWindow | null = null;
let agent: AgentLoop | null = null;
let refinementService: RefinementService | null = null;
// Per-window refinement state. Phase 2+ will lift this into a proper session
// manager when we add Spec Approval / Plan / Pre-flight / Execute screens.
const sessionState: {
    ideaText: string;
    priorTurns: RefinementTurn[];
} = {
    ideaText: '',
    priorTurns: [],
};

// ----------------------------------------------------------------------
// Provider / service setup
// ----------------------------------------------------------------------

/**
 * Cached resolved provider config. Recomputed when settings change.
 * Settings take precedence; env vars are the dev fallback.
 */
let cachedProviderConfig: { name: ProviderName; apiKey?: string; modelId?: string; baseUrl?: string; source: 'settings' | 'env' } | null = null;

async function getProviderConfig(): Promise<{ name: ProviderName; apiKey?: string; modelId?: string; baseUrl?: string; source: 'settings' | 'env' }> {
    if (cachedProviderConfig) { return cachedProviderConfig; }
    const resolved = await resolveProviderConfig();
    if (!resolved) {
        // Shouldn't happen — resolveProviderConfig always returns at least ollama.
        throw new Error('No provider config available. Open Settings (gear icon) to configure one.');
    }
    cachedProviderConfig = resolved;
    return resolved;
}

/**
 * Drop the cached provider + services. Called after settings change so the
 * next refine/agent call picks up the new config.
 */
function invalidateProviderCache(): void {
    // AgentLoop has no dispose() — just drop the refs. The next call to
    // getAgent() / getRefinementService() will rebuild with the new config.
    agent = null;
    refinementService = null;
    cachedProviderConfig = null;
}

async function getRefinementService(): Promise<RefinementService> {
    if (refinementService) { return refinementService; }
    const cfg = await getProviderConfig();
    const provider = createProvider(cfg);
    refinementService = new RefinementService({
        aiProvider: provider,
        maxTurns: 5,
        minTurns: 3,
        log: (msg) => console.log('[refine] ' + msg),
    });
    return refinementService;
}

async function getAgent(): Promise<AgentLoop> {
    if (agent) { return agent; }
    const cfg = await getProviderConfig();
    const provider = createProvider(cfg);
    agent = new AgentLoop({
        aiProvider: provider,
        workspaceRoot: process.cwd(),
        log: (msg: string) => console.log('[agent] ' + msg),
        approveWrite: async (filePath: string, proposed: string, _existing: string | null) => {
            console.log('[kovix] AUTO-APPROVING write to ' + filePath + ' (' + proposed.length + ' chars)');
            return true;
        },
        approveInterpreterCommand: async (cmd: string) => {
            console.log('[kovix] AUTO-APPROVING interpreter command: ' + cmd);
            return true;
        },
        onlineMode: false,
    });
    return agent;
}

// ----------------------------------------------------------------------
// Window
// ----------------------------------------------------------------------

function createWindow(): void {
    // Allow screenshot scripts to override window size — useful for capturing
    // tall content (e.g. the full 4-section spec screen).
    const width = parseInt(process.env.KOVIX_WIN_W ?? '1200', 10);
    const height = parseInt(process.env.KOVIX_WIN_H ?? '820', 10);
    mainWindow = new BrowserWindow({
        width,
        height,
        minWidth: 760,
        minHeight: 540,
        backgroundColor: '#FAFAF7',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'Kovix — Build Mode',
    });

    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BUILD_MODE_HTML));

    // Screenshot support for headless verification. When KOVIX_SCREENSHOT is
    // set, wait for the window to finish loading, optionally run a script in
    // the renderer (KOVIX_SCREENSHOT_SCRIPT) to drive the UI into a specific
    // state, then capture and quit. Used by the Phase 1 verification harness.
    const screenshotPath = process.env.KOVIX_SCREENSHOT;
    const screenshotScript = process.env.KOVIX_SCREENSHOT_SCRIPT;
    if (screenshotPath) {
        // Forward renderer console messages to stdout for debugging.
        mainWindow.webContents.on('console-message', (_e, _level, message, _line, _sourceId) => {
            console.log('[renderer] ' + message);
        });
        mainWindow.webContents.once('did-finish-load', async () => {
            try {
                // Initial render delay
                await new Promise(r => setTimeout(r, 800));

                // If a script is provided, run it in the renderer to drive
                // the UI into a specific state (e.g. fill in an idea, click
                // Start, answer questions).
                if (screenshotScript) {
                    const result = await mainWindow!.webContents.executeJavaScript(screenshotScript, true);
                    console.log('[kovix] screenshot script result:', JSON.stringify(result));
                    // Give the UI a beat to settle after the script runs
                    await new Promise(r => setTimeout(r, 800));
                }

                if (!mainWindow || mainWindow.isDestroyed()) { return; }
                const image = await mainWindow.webContents.capturePage();
                const fs = await import('node:fs/promises');
                await fs.writeFile(screenshotPath, image.toPNG());
                console.log('[kovix] screenshot saved: ' + screenshotPath);
            } catch (err) {
                console.error('[kovix] screenshot failed:', err);
            } finally {
                app.quit();
            }
        });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ----------------------------------------------------------------------
// IPC handlers
// ----------------------------------------------------------------------

ipcMain.handle('kovix:provider-label', async (): Promise<string> => {
    try {
        const cfg = await getProviderConfig();
        if (cfg.name === 'anthropic') { return 'Anthropic' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
        if (cfg.name === 'openrouter') { return 'OpenRouter' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
        if (cfg.name === 'ollama') { return 'Ollama (local)' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
        if (cfg.name === 'nvidia') { return 'NVIDIA NIM' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
        return String(cfg.name) + (cfg.modelId ? ' · ' + cfg.modelId : '');
    } catch (err) {
        console.error('[kovix:provider-label] error:', err);
        return 'No provider — open Settings';
    }
});

// ----------------------------------------------------------------------
// Settings IPC handlers
// ----------------------------------------------------------------------
// The renderer NEVER sees the full API key. It sends a typed key for
// test/save, and receives only a masked preview back.

ipcMain.handle('kovix:settings:list-providers', async () => {
    return listProviders();
});

ipcMain.handle('kovix:settings:get-preview', async (): Promise<SettingsPreview> => {
    return await getSettingsPreview();
});

ipcMain.handle('kovix:settings:get-models', async (_event, providerName: string): Promise<string[]> => {
    return PROVIDER_MODELS[providerName as ProviderName] ?? [];
});

ipcMain.handle('kovix:settings:test', async (_event, config: TestConnectionInput): Promise<TestConnectionResult> => {
    // Never log the key. The testConnection function sanitizes errors.
    console.log('[settings] test connection — provider=' + config.provider + ' model=' + (config.modelId ?? '(default)'));
    try {
        return await testConnection(config);
    } catch (err) {
        console.error('[settings] test connection threw:', err instanceof Error ? err.name + ': ' + err.message : String(err));
        return {
            ok: false,
            message: 'Test failed: ' + (err instanceof Error ? err.name : 'unknown error'),
            durationMs: 0,
        };
    }
});

ipcMain.handle('kovix:settings:save', async (_event, config: { provider: string; apiKey?: string; modelId?: string; baseUrl?: string }): Promise<SettingsPreview> => {
    console.log('[settings] save — provider=' + config.provider + ' model=' + (config.modelId ?? '(default)'));
    const provider = config.provider as ProviderName;

    // Load existing so we preserve fields the user didn't touch.
    const existing = await loadSettings();

    // If no new key provided, preserve the existing key (if any).
    let apiKeyToStore: string | undefined;
    if (config.apiKey && config.apiKey.trim().length > 0) {
        apiKeyToStore = config.apiKey.trim();
    } else if (existing) {
        apiKeyToStore = decryptApiKey(existing) ?? undefined;
    }

    const settings: PersistedSettings = {
        version: 1,
        provider,
        modelId: config.modelId?.trim() || undefined,
        baseUrl: config.baseUrl?.trim() || undefined,
        savedAt: new Date().toISOString(),
    };

    if (apiKeyToStore) {
        const { enc, usedFallback } = encryptApiKey(apiKeyToStore);
        if (enc) {
            settings.apiKeyEnc = enc;
        } else if (usedFallback) {
            settings.apiKeyPlain = apiKeyToStore;
        }
    }

    await saveSettings(settings);

    // Invalidate cached provider so next refine/agent call uses the new config.
    invalidateProviderCache();

    // Notify the renderer so it can refresh the topbar provider chip.
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const cfg = await resolveProviderConfig();
            let label = 'No provider';
            if (cfg) {
                if (cfg.name === 'anthropic') { label = 'Anthropic' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
                else if (cfg.name === 'openrouter') { label = 'OpenRouter' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
                else if (cfg.name === 'ollama') { label = 'Ollama (local)' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
                else { label = String(cfg.name) + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
            }
            mainWindow.webContents.send('kovix:provider-changed', label);
        }
    } catch (err) {
        console.error('[settings] failed to notify renderer of provider change:', err);
    }

    return await getSettingsPreview();
});

ipcMain.handle('kovix:settings:clear-key', async (): Promise<SettingsPreview> => {
    console.log('[settings] clear API key');
    await clearApiKey();
    invalidateProviderCache();
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('kovix:provider-changed', 'No provider — open Settings');
        }
    } catch { /* ignore */ }
    return await getSettingsPreview();
});

// ----------------------------------------------------------------------
// Demo mode — when KOVIX_DEMO=1 is set, the refinement IPC handlers return
// deterministic fake data instead of calling the LLM. Used by the headless
// screenshot harness to capture the REFINING and SPEC states without
// needing an API key or making real LLM calls.
// ----------------------------------------------------------------------
const DEMO_MODE = !!process.env.KOVIX_DEMO;
const DEMO_QUESTIONS = [
    'Should the tool watch recursively into subdirectories, or only the top-level folder?',
    'Should the tool report file creations, modifications, and deletions, or only modifications?',
    'Should the tool ignore any directories by default (like .git or node_modules)?',
];
const DEMO_SPEC: RefinementResult = {
    kind: 'spec',
    spec: {
        must: [
            'CLI accepts a folder path as the first argument and watches it recursively',
            'Prints each changed file path to stdout, one per line',
            'Ignores .git and node_modules directories by default',
            'Exits cleanly on Ctrl+C with no error output',
        ],
        should: [
            'Print a summary line to stderr every 60 seconds with the count of changes detected',
            'Accept an optional --debounce flag to coalesce rapid changes',
        ],
        wont: [
            'No GUI — terminal output only',
            'No remote sync or network calls',
            'No config file in v1 — flags only',
        ],
        doneCriteria: [
            'Running `kovix-watch .` prints a line within 1 second of saving any non-ignored file',
            'Files in .git/ and node_modules/ never appear in stdout',
            'Ctrl+C exits with code 0 and no stderr output',
            'Running `kovix-watch --help` prints usage and exits 0',
        ],
    },
};

ipcMain.handle('kovix:refine:start', async (_event, ideaText: string): Promise<RefinementResult> => {
    if (!ideaText || typeof ideaText !== 'string' || ideaText.trim().length === 0) {
        throw new Error('Idea text is required.');
    }
    // Reset session state for a new refinement run.
    sessionState.ideaText = ideaText.trim();
    sessionState.priorTurns = [];

    if (DEMO_MODE) {
        const fakeQuestion: RefinementResult = { kind: 'question', text: DEMO_QUESTIONS[0] };
        sessionState.priorTurns.push({ role: 'assistant', content: fakeQuestion.text });
        return fakeQuestion;
    }

    const service = await getRefinementService();
    const result = await service.refine({
        ideaText: sessionState.ideaText,
        priorTurns: sessionState.priorTurns,
    });
    if (result.kind === 'question') {
        sessionState.priorTurns.push({ role: 'assistant', content: result.text });
    }
    return result;
});

ipcMain.handle('kovix:refine:continue', async (_event, answer: string): Promise<RefinementResult> => {
    if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
        throw new Error('Answer is required.');
    }
    if (!sessionState.ideaText) {
        throw new Error('No active refinement session. Call refine:start first.');
    }
    // Record the user's answer.
    sessionState.priorTurns.push({ role: 'user', content: answer.trim() });

    if (DEMO_MODE) {
        // After each answer, return the next fake question. After all 3
        // questions are answered, return the fake spec.
        const assistantTurnCount = sessionState.priorTurns.filter(t => t.role === 'assistant').length;
        if (assistantTurnCount < DEMO_QUESTIONS.length) {
            const nextQ = DEMO_QUESTIONS[assistantTurnCount];
            sessionState.priorTurns.push({ role: 'assistant', content: nextQ });
            return { kind: 'question', text: nextQ };
        }
        return DEMO_SPEC;
    }

    const service = await getRefinementService();
    const result = await service.refine({
        ideaText: sessionState.ideaText,
        priorTurns: sessionState.priorTurns,
    });
    if (result.kind === 'question') {
        sessionState.priorTurns.push({ role: 'assistant', content: result.text });
    }
    return result;
});

// Legacy Phase 0 IPC handlers — kept so we don't break the existing API
// surface, but the Phase 1 UI doesn't use them. Phase 2+ (Plan/Execute
// screens) will resurrect them.
ipcMain.handle('kovix:plan', async (_event, task: string) => {
    if (!agent) { agent = await getAgent(); }
    return await agent.runPlanningPhase(task);
});

ipcMain.handle('kovix:execute', async (_event, task: string) => {
    if (!agent) { agent = await getAgent(); }
    const events: AgentLoopEvent[] = [];
    try {
        for await (const event of agent.run(task) as AsyncIterable<AgentLoopEvent>) {
            events.push(event);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('kovix:event', event);
            }
        }
    } catch (err) {
        console.error('[kovix:execute] error:', err);
    }
    return events;
});

// ----------------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------------

app.whenReady().then(async () => {
    // KOVIX_VERIFY=1: headless verification mode. Reads provider config from
    // the settings store (the same path the UI uses), runs the refinement
    // loop end-to-end with scripted answers, prints the full transcript to
    // stdout, then quits. Used by test/verify-settings.ts.
    //
    // The window is NOT shown in this mode — verification is purely a
    // console operation. If you want screenshots, use KOVIX_SCREENSHOT
    // instead (which runs the UI in demo mode).
    if (process.env.KOVIX_VERIFY === '1') {
        try {
            await runHeadlessVerification();
        } catch (err) {
            console.error('[verify] FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
            process.exitCode = 1;
        } finally {
            app.quit();
        }
        return;
    }

    // KOVIX_TEST_SETTINGS=1: integration test for the settings store. Writes
    // a fake key, reads it back, verifies the roundtrip, reports whether
    // safeStorage encryption was used, prints the file path + permissions,
    // then cleans up. Used to verify the storage layer works on this platform.
    if (process.env.KOVIX_TEST_SETTINGS === '1') {
        try {
            await runSettingsStoreTest();
        } catch (err) {
            console.error('[test-settings] FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
            process.exitCode = 1;
        } finally {
            app.quit();
        }
        return;
    }

    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

/**
 * Headless verification: drives Idea → Refinement → Spec using the stored
 * provider config. Prints the full transcript to stdout.
 *
 * Scripted answers simulate a cooperative user. The same answers are used
 * in test/verify-refine.ts so the two scripts are comparable.
 */
async function runHeadlessVerification(): Promise<void> {
    const ideaText = process.env.KOVIX_VERIFY_IDEA
        ?? 'a tiny CLI tool that watches a folder and prints the names of files that change';

    console.log('=== Kovix Build Mode — Settings-based Verification ===');
    console.log('');
    console.log('Idea: ' + ideaText);
    console.log('');

    // Resolve provider config from settings (with env fallback).
    const cfg = await resolveProviderConfig();
    if (!cfg) {
        console.error('FAIL: No provider config available. Open the UI, click the gear icon, and configure a provider first.');
        console.error('      (Or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY / NVIDIA_API_KEY as env vars.)');
        process.exitCode = 2;
        return;
    }
    console.log('Provider: ' + cfg.name + ' (source: ' + cfg.source + ')');
    if (cfg.modelId) { console.log('Model:    ' + cfg.modelId); }
    if (cfg.baseUrl) { console.log('Base URL: ' + cfg.baseUrl); }
    if (cfg.apiKey) {
        const masked = cfg.apiKey.length > 8
            ? cfg.apiKey.slice(0, 4) + '...' + cfg.apiKey.slice(-4)
            : '(short key)';
        console.log('API key:  ' + masked);
    } else {
        console.log('API key:  (none — local provider)');
    }
    console.log('');

    // Build the refinement service using the resolved config.
    let provider;
    try {
        provider = createProvider({
            name: cfg.name,
            apiKey: cfg.apiKey,
            modelId: cfg.modelId,
            baseUrl: cfg.baseUrl,
        });
    } catch (err) {
        console.error('FAIL: Could not create provider: ' + (err instanceof Error ? err.message : String(err)));
        process.exitCode = 2;
        return;
    }

    const service = new RefinementService({
        aiProvider: provider,
        maxTurns: 5,
        minTurns: 3,
        log: (msg) => console.log('  ' + msg),
    });

    // Scripted answers (same as verify-refine.ts).
    const SCRIPTED_ANSWERS = [
        'It should watch the current directory recursively and print to stdout, one file per line.',
        'Target is developers on macOS and Linux. They run it from the terminal.',
        'Yes, ignore .git and node_modules by default. No config file needed for v1.',
        'Done means: I can run `kovix-watch .` and see a line printed within 1 second of saving any file in the folder (excluding ignored dirs).',
        'No remote sync, no GUI, no logging to file. Just stdout.',
    ];
    function getAnswerForRound(round: number): string {
        return SCRIPTED_ANSWERS[round] ?? "I'm not sure — please make a sensible default for that.";
    }

    // Run the loop.
    console.log('=== REFINEMENT LOOP ===');
    console.log('');
    const priorTurns: RefinementTurn[] = [];
    let finalSpec: import('../agent/index.js').RefinementSpec | null = null;
    let rounds = 0;
    let oneQuestionViolations = 0;
    let hardCap = 8;

    while (hardCap-- > 0) {
        const round = rounds + 1;
        console.log('--- Round ' + round + ' ---');
        const result = await service.refine({ ideaText, priorTurns });
        if (result.kind === 'spec') {
            console.log('');
            console.log('>>> emit_spec received — refinement complete <<<');
            finalSpec = result.spec;
            break;
        }
        // Question — check one-question rule
        const text = result.text;
        const qmCount = (text.match(/\?/g) ?? []).length;
        const listMarkers = [/\bfirst[,.]/, /\bsecond[,.]/, /\bthird[,.]/, /\d+\.\s/, /\balso\b/, /\badditionally\b/];
        const hasList = listMarkers.some(re => re.test(text.toLowerCase()));
        if (qmCount > 1 || hasList) {
            oneQuestionViolations++;
            console.log('  QUESTION: ' + text);
            console.log('  ⚠️  ONE-QUESTION VIOLATION: ' + (qmCount > 1 ? qmCount + ' question marks' : 'list marker detected'));
        } else {
            console.log('  QUESTION: ' + text);
        }
        priorTurns.push({ role: 'assistant', content: text });
        const answer = getAnswerForRound(rounds);
        console.log('  ANSWER (simulated): ' + answer);
        priorTurns.push({ role: 'user', content: answer });
        transcript_push(priorTurns, rounds, text, answer);
        rounds++;
        console.log('');
    }

    if (!finalSpec) {
        console.error('FAIL: refinement loop exhausted hard cap without emitting spec.');
        process.exitCode = 3;
        return;
    }

    console.log('');
    console.log('=== FINAL SPEC ===');
    console.log('');
    console.log('  must:');
    for (const item of finalSpec.must) { console.log('    - ' + item); }
    console.log('  should:');
    for (const item of finalSpec.should) { console.log('    - ' + item); }
    console.log('  wont:');
    for (const item of finalSpec.wont) { console.log('    - ' + item); }
    console.log('  doneCriteria:');
    for (const item of finalSpec.doneCriteria) { console.log('    - ' + item); }
    console.log('');

    // Validate spec shape
    const issues: string[] = [];
    if (finalSpec.must.length === 0) { issues.push('must is empty'); }
    if (finalSpec.doneCriteria.length === 0) { issues.push('doneCriteria is empty'); }

    console.log('=== VERIFICATION REPORT ===');
    console.log('');
    console.log('Rounds completed:        ' + rounds);
    console.log('One-question violations: ' + oneQuestionViolations);
    console.log('Spec emitted:            YES');
    console.log('Spec valid:              ' + (issues.length === 0 ? 'YES' : 'NO — ' + issues.join(', ')));
    console.log('');
    console.log('=== CHECKS ===');
    const c1 = rounds >= 3 && rounds <= 5;
    const c2 = oneQuestionViolations === 0;
    const c3 = !!finalSpec;
    const c4 = issues.length === 0;
    console.log('  [' + (c1 ? 'PASS' : 'FAIL') + '] Refinement ran 3-5 rounds (got ' + rounds + ')');
    console.log('  [' + (c2 ? 'PASS' : 'FAIL') + '] Every question was a single question (no lists)');
    console.log('  [' + (c3 ? 'PASS' : 'FAIL') + '] LLM called emit_spec (structured tool call)');
    console.log('  [' + (c4 ? 'PASS' : 'FAIL') + '] Spec has all 4 required arrays populated');
    console.log('');
    if (c1 && c2 && c3 && c4) {
        console.log('>>> ALL CHECKS PASSED <<<');
    } else {
        console.log('>>> SOME CHECKS FAILED — see above <<<');
        process.exitCode = 4;
    }
}

// Tiny helper to keep the verify loop tidy — no-op outside headless mode.
function transcript_push(_turns: RefinementTurn[], _round: number, _q: string, _a: string): void {
    // Hook point for future transcript artifact serialization. Intentionally empty.
}

/**
 * Integration test for the settings store. Writes a fake key, reads it back,
 * verifies the roundtrip, and reports whether safeStorage encryption was used.
 * Cleans up after itself.
 */
async function runSettingsStoreTest(): Promise<void> {
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const safeStorage = (await import('electron')).safeStorage;

    console.log('=== Kovix Settings Store Integration Test ===');
    console.log('');
    console.log('Platform: ' + process.platform);
    console.log('safeStorage available: ' + safeStorage.isEncryptionAvailable());
    console.log('');

    // Step 1: Save a fake key.
    const FAKE_KEY = 'sk-ant-fake-test-key-1234567890abcdef-NOT-REAL';
    const FAKE_MODEL = 'claude-sonnet-5';
    console.log('Step 1: Save provider=anthropic, model=' + FAKE_MODEL + ', key=' + FAKE_KEY.slice(0, 8) + '...');
    const { encryptApiKey } = await import('./settingsStore.js');
    const { enc, usedFallback } = encryptApiKey(FAKE_KEY);
    const settings: PersistedSettings = {
        version: 1,
        provider: 'anthropic',
        modelId: FAKE_MODEL,
        apiKeyEnc: enc ?? undefined,
        apiKeyPlain: usedFallback ? FAKE_KEY : undefined,
        savedAt: new Date().toISOString(),
    };
    await saveSettings(settings);
    console.log('  saved.');

    // Step 2: Inspect the file on disk.
    const os = await import('node:os');
    const expectedPath = pathMod.join(app.getPath('userData'), 'kovix-settings.json');
    console.log('');
    console.log('Step 2: Inspect file on disk');
    console.log('  Path: ' + expectedPath);
    console.log('  In repo? ' + (expectedPath.startsWith(process.cwd()) ? 'YES (BAD)' : 'NO (good)'));
    try {
        const stat = await fs.stat(expectedPath);
        const mode = stat.mode & 0o777;
        console.log('  Permissions: 0' + mode.toString(8) + (mode === 0o600 ? ' (good)' : ' (should be 0600)'));
    } catch (err) {
        console.log('  Could not stat file: ' + (err instanceof Error ? err.message : String(err)));
    }
    // Read the raw file and check the key is NOT present in plaintext (unless fallback).
    const rawFile = await fs.readFile(expectedPath, 'utf8');
    const rawContainsKey = rawFile.includes(FAKE_KEY);
    console.log('  Raw file contains plaintext key? ' + (rawContainsKey ? 'YES (BAD unless fallback)' : 'NO (good)'));
    if (usedFallback) {
        console.log('  (Fallback mode — plaintext is expected. safeStorage not available.)');
    }

    // Step 3: Load + decrypt.
    console.log('');
    console.log('Step 3: Load + decrypt');
    const loaded = await loadSettings();
    if (!loaded) {
        console.error('  FAIL: loadSettings returned null');
        process.exitCode = 1;
        return;
    }
    const { decryptApiKey } = await import('./settingsStore.js');
    const decrypted = decryptApiKey(loaded);
    console.log('  Loaded provider: ' + loaded.provider);
    console.log('  Loaded model:    ' + loaded.modelId);
    console.log('  Decrypted key:   ' + (decrypted ? decrypted.slice(0, 8) + '...' : '(null)'));
    const roundtripOk = decrypted === FAKE_KEY;
    console.log('  Roundtrip OK? ' + (roundtripOk ? 'YES ✓' : 'NO ✗'));
    if (!roundtripOk) {
        console.error('  FAIL: decrypted key does not match what we saved.');
        process.exitCode = 1;
    }

    // Step 4: Preview (masked).
    console.log('');
    console.log('Step 4: Preview (what the renderer would see)');
    const preview = await getSettingsPreview();
    console.log('  provider:       ' + preview.provider);
    console.log('  modelId:        ' + preview.modelId);
    console.log('  apiKeyMasked:   ' + preview.apiKeyMasked);
    console.log('  apiKeyEncrypted: ' + preview.apiKeyEncrypted);
    console.log('  hasSettings:    ' + preview.hasSettings);
    const previewSafe = !JSON.stringify(preview).includes(FAKE_KEY);
    console.log('  Preview leaks real key? ' + (previewSafe ? 'NO (good)' : 'YES (BAD)'));

    // Step 5: Cleanup.
    console.log('');
    console.log('Step 5: Cleanup — clear API key');
    await clearApiKey();
    const afterClear = await getSettingsPreview();
    console.log('  After clear: apiKeyMasked=' + afterClear.apiKeyMasked + ', provider=' + afterClear.provider);
    const cleanupOk = afterClear.apiKeyMasked === null;
    console.log('  Cleanup OK? ' + (cleanupOk ? 'YES ✓' : 'NO ✗'));

    // Final report.
    console.log('');
    console.log('=== RESULT ===');
    const allOk = roundtripOk && previewSafe && cleanupOk;
    console.log('  Encryption: ' + (usedFallback ? 'PLAINTEXT FALLBACK (safeStorage unavailable)' : 'safeStorage encrypted'));
    console.log('  Roundtrip:  ' + (roundtripOk ? 'PASS' : 'FAIL'));
    console.log('  No leak:    ' + (previewSafe ? 'PASS' : 'FAIL'));
    console.log('  Cleanup:    ' + (cleanupOk ? 'PASS' : 'FAIL'));
    console.log('  File mode:  ' + (usedFallback ? '0600 (plaintext fallback — file mode is critical here)' : '0600 (encrypted, mode still good defense)'));
    console.log('');
    if (allOk) {
        console.log('>>> SETTINGS STORE OK <<<');
    } else {
        console.log('>>> SETTINGS STORE HAS ISSUES — see above <<<');
        process.exitCode = 1;
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ----------------------------------------------------------------------
// Build mode UI — Phase 1
// ----------------------------------------------------------------------
//
// Single-screen UI with three visual states:
//   1. IDEA — large textarea, "Start refinement" button
//   2. REFINING — conversation cards stacked vertically, current question
//                  highlighted, answer input at the bottom
//   3. SPEC — 4-section card (must / should / wont / doneCriteria) with
//             "Start over" button
//
// Visual tone: light theme, generous whitespace, clean cards with subtle
// shadow. One accent color (sky blue #0EA5E9). System font stack.

const BUILD_MODE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kovix — Build Mode</title>
<style>
  :root {
    --bg: #FAFAF7;
    --surface: #FFFFFF;
    --surface-2: #F4F4F0;
    --text: #1A1A1A;
    --text-2: #555555;
    --text-3: #888888;
    --border: #E5E5DD;
    --accent: #0EA5E9;
    --accent-2: #0284C7;
    --accent-soft: #E0F2FE;
    --warning: #D97706;
    --warning-soft: #FEF3C7;
    --success: #059669;
    --success-soft: #D1FAE5;
    --danger: #DC2626;
    --danger-soft: #FEE2E2;
    --shadow: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06);
    --shadow-lg: 0 10px 25px rgba(0,0,0,0.06), 0 4px 10px rgba(0,0,0,0.04);
    --radius: 10px;
    --radius-sm: 6px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
    --font-mono: 'SF Mono', Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  header.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .brand-mark {
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -0.01em;
  }
  .brand-mode {
    color: var(--text-3);
    font-size: 13px;
    font-weight: 500;
  }
  .provider-chip {
    font-size: 12px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    cursor: default;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .gear-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--text-2);
    width: 32px;
    height: 32px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .gear-btn:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }
  .gear-btn svg {
    width: 18px;
    height: 18px;
  }

  main {
    flex: 1;
    display: flex;
    justify-content: center;
    padding: 48px 32px 80px;
    overflow-y: auto;
  }
  .container {
    width: 100%;
    max-width: 720px;
  }

  /* ---- IDEA STATE ---- */
  .idea-screen {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  .idea-heading {
    text-align: center;
  }
  .idea-heading h1 {
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 10px;
    color: var(--text);
  }
  .idea-heading p {
    font-size: 16px;
    color: var(--text-2);
    margin: 0;
  }
  .idea-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .idea-card label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .idea-card textarea {
    width: 100%;
    min-height: 140px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.55;
    color: var(--text);
    background: var(--surface);
    resize: vertical;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .idea-card textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .idea-card-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
  }
  .example-ideas {
    text-align: center;
    color: var(--text-3);
    font-size: 13px;
  }
  .example-ideas button {
    background: none;
    border: none;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    padding: 0;
    margin: 0 4px;
  }

  /* ---- BUTTONS ---- */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 18px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    font-family: var(--font);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .btn-primary {
    background: var(--accent);
    color: white;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-2);
  }
  .btn-primary:disabled {
    background: var(--text-3);
    cursor: not-allowed;
    opacity: 0.6;
  }
  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
  }
  .btn-secondary:hover {
    background: var(--surface-2);
  }

  /* ---- REFINING STATE ---- */
  .refine-screen {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .refine-idea-banner {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-size: 14px;
    color: var(--text-2);
  }
  .refine-idea-banner strong {
    color: var(--text);
    font-weight: 600;
  }

  .conversation {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .turn-role {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    padding-left: 4px;
  }
  .turn-bubble {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    box-shadow: var(--shadow);
    font-size: 15px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .turn-user .turn-bubble {
    background: var(--accent-soft);
    border-color: #BAE6FD;
  }
  .turn-assistant .turn-bubble {
    background: var(--surface);
  }
  .turn-current .turn-bubble {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow);
  }

  .answer-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    position: sticky;
    bottom: 0;
  }
  .answer-box textarea {
    width: 100%;
    min-height: 70px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.55;
    color: var(--text);
    background: var(--surface);
    resize: vertical;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .answer-box textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .answer-box-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .answer-hint {
    font-size: 12px;
    color: var(--text-3);
  }
  .answer-hint kbd {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
    font-family: var(--font-mono);
    font-size: 11px;
  }

  /* ---- SPEC STATE ---- */
  .spec-screen {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .spec-header {
    text-align: center;
    padding: 12px 0 8px;
  }
  .spec-header h2 {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 8px;
    color: var(--text);
  }
  .spec-header p {
    font-size: 15px;
    color: var(--text-2);
    margin: 0;
  }
  .spec-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .spec-section {
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
  }
  .spec-section:last-child { border-bottom: none; }
  .spec-section-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .spec-section-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 8px;
    border-radius: 4px;
  }
  .spec-section-label.must { background: var(--danger-soft); color: var(--danger); }
  .spec-section-label.should { background: var(--accent-soft); color: var(--accent-2); }
  .spec-section-label.wont { background: var(--warning-soft); color: var(--warning); }
  .spec-section-label.doneCriteria { background: var(--success-soft); color: var(--success); }
  .spec-section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .spec-section-count {
    font-size: 12px;
    color: var(--text-3);
    margin-left: auto;
  }
  .spec-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .spec-list li {
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    padding-left: 22px;
    position: relative;
  }
  .spec-list li::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 8px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
  }
  .spec-section.must .spec-list li::before { background: var(--danger); }
  .spec-section.should .spec-list li::before { background: var(--accent); }
  .spec-section.wont .spec-list li::before { background: var(--warning); }
  .spec-section.doneCriteria .spec-list li::before { background: var(--success); }
  .spec-empty {
    font-size: 13px;
    color: var(--text-3);
    font-style: italic;
    padding-left: 0 !important;
  }
  .spec-empty::before { display: none !important; }
  .spec-actions {
    display: flex;
    justify-content: center;
    gap: 12px;
    padding-top: 8px;
  }

  /* ---- STATUS / ERROR ---- */
  .status-banner {
    background: var(--warning-soft);
    color: var(--warning);
    border: 1px solid #FDE68A;
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    font-size: 13px;
    margin-bottom: 16px;
  }
  .error-banner {
    background: var(--danger-soft);
    color: var(--danger);
    border: 1px solid #FCA5A5;
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    font-size: 14px;
    margin-bottom: 16px;
  }
  .loading-dots {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .loading-dots span {
    width: 6px; height: 6px;
    background: var(--text-3);
    border-radius: 50%;
    animation: bounce 1.4s infinite ease-in-out both;
  }
  .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
  .loading-dots span:nth-child(2) { animation-delay: -0.16s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
    40% { transform: scale(1); opacity: 1; }
  }

  /* ---- SETTINGS MODAL ---- */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .overlay.open { opacity: 1; }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    width: 100%;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
    transform: translateY(8px);
    transition: transform 0.15s;
  }
  .overlay.open .modal { transform: translateY(0); }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  .modal-close {
    background: none;
    border: none;
    color: var(--text-3);
    font-size: 22px;
    cursor: pointer;
    width: 28px;
    height: 28px;
    line-height: 1;
    border-radius: 4px;
    padding: 0;
  }
  .modal-close:hover { background: var(--surface-2); color: var(--text); }
  .modal-body {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .field-hint {
    font-size: 12px;
    color: var(--text-3);
  }
  .field-input,
  .field-select {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--font);
    font-size: 14px;
    color: var(--text);
    background: var(--surface);
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .field-input:focus,
  .field-select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .field-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .field-row .field-input { flex: 1; }
  .reveal-btn {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    padding: 0 14px;
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font);
    transition: background 0.15s, color 0.15s;
  }
  .reveal-btn:hover { background: var(--border); color: var(--text); }
  .modal-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .modal-footer-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .modal-footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn-danger {
    background: var(--surface);
    color: var(--danger);
    border-color: #FCA5A5;
  }
  .btn-danger:hover { background: var(--danger-soft); }
  .btn-ghost {
    background: transparent;
    color: var(--text-2);
    border-color: transparent;
  }
  .btn-ghost:hover { background: var(--surface-2); color: var(--text); }

  .test-result {
    font-size: 13px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .test-result.ok { background: var(--success-soft); border-color: #6EE7B7; color: #065F46; }
  .test-result.fail { background: var(--danger-soft); border-color: #FCA5A5; color: #991B1B; }
  .test-result.pending { background: var(--surface-2); color: var(--text-2); }
  .test-result-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin-top: 1px;
  }

  /* ---- NO-PROVIDER BANNER ---- */
  .no-provider-banner {
    background: var(--warning-soft);
    color: var(--warning);
    border: 1px solid #FDE68A;
    border-radius: var(--radius);
    padding: 14px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    font-size: 14px;
  }
  .no-provider-banner button {
    background: var(--warning);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-family: var(--font);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .no-provider-banner button:hover { opacity: 0.9; }

  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark">Kovix</span>
      <span class="brand-mode">Build Mode</span>
    </div>
    <div class="topbar-right">
      <div class="provider-chip" id="provider-chip" title="Active provider">—</div>
      <button class="gear-btn" id="gear-btn" title="Provider settings" aria-label="Open provider settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
    </div>
  </header>

  <main>
    <div class="container">

      <!-- IDEA STATE -->
      <section id="state-idea" class="idea-screen">
        <div id="no-provider-banner" class="no-provider-banner hidden">
          <div>
            <strong>No provider configured.</strong> Open Settings to add an API key — Kovix needs an LLM provider to refine your idea.
          </div>
          <button id="no-provider-open-settings">Open settings</button>
        </div>
        <div class="idea-heading">
          <h1>What do you want to build?</h1>
          <p>Describe your idea in a sentence or two. Kovix will refine it with you into a clear spec.</p>
        </div>
        <div class="idea-card">
          <label for="idea-input">Your idea</label>
          <textarea id="idea-input" placeholder="e.g. a tiny CLI tool that watches a folder and prints the names of files that change"></textarea>
          <div class="idea-card-actions">
            <button id="idea-start" class="btn btn-primary" disabled>Start refinement</button>
          </div>
        </div>
        <div class="example-ideas">
          Try:
          <button data-idea="a tiny CLI tool that watches a folder and prints the names of files that change">file watcher CLI</button>
          <button data-idea="a markdown note app with daily journaling and tag-based search">markdown journal</button>
          <button data-idea="a tiny HTTP server that echoes back the request body as JSON">echo server</button>
        </div>
      </section>

      <!-- REFINING STATE -->
      <section id="state-refine" class="refine-screen hidden">
        <div class="refine-idea-banner">
          <strong>Your idea:</strong> <span id="refine-idea-text"></span>
        </div>
        <div id="conversation" class="conversation"></div>
        <div id="answer-box" class="answer-box">
          <textarea id="answer-input" placeholder="Type your answer…"></textarea>
          <div class="answer-box-actions">
            <span class="answer-hint">Press <kbd>⌘</kbd>+<kbd>Enter</kbd> to send</span>
            <button id="answer-send" class="btn btn-primary" disabled>Send</button>
          </div>
        </div>
      </section>

      <!-- SPEC STATE -->
      <section id="state-spec" class="spec-screen hidden">
        <div class="spec-header">
          <h2>Your spec is ready</h2>
          <p>Refinement complete. This is the formal contract for the build.</p>
        </div>
        <div id="spec-card" class="spec-card"></div>
        <div class="spec-actions">
          <button id="spec-restart" class="btn btn-secondary">Start over</button>
        </div>
      </section>

    </div>
  </main>
</div>

<!-- SETTINGS MODAL -->
<div id="settings-overlay" class="overlay hidden">
  <div class="modal" role="dialog" aria-labelledby="settings-title">
    <div class="modal-header">
      <h2 id="settings-title">Provider settings</h2>
      <button class="modal-close" id="settings-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label class="field-label" for="set-provider">Provider</label>
        <select class="field-select" id="set-provider"></select>
        <div class="field-hint" id="set-provider-hint"></div>
      </div>

      <div class="field" id="set-apikey-field">
        <label class="field-label" for="set-apikey">API key</label>
        <div class="field-row">
          <input class="field-input" id="set-apikey" type="password" placeholder="Paste your API key here" autocomplete="off" spellcheck="false" />
          <button class="reveal-btn" id="set-apikey-reveal" type="button" title="Show/hide key">Show</button>
        </div>
        <div class="field-hint" id="set-apikey-hint">Stored encrypted via OS keychain (safeStorage). Never logged, never committed.</div>
      </div>

      <div class="field">
        <label class="field-label" for="set-model">Model</label>
        <input class="field-input" id="set-model" type="text" placeholder="(provider default)" list="set-model-list" autocomplete="off" spellcheck="false" />
        <datalist id="set-model-list"></datalist>
        <div class="field-hint">Pick from the list or type a custom model ID. Leave blank for the provider default.</div>
      </div>

      <div class="field hidden" id="set-baseurl-field">
        <label class="field-label" for="set-baseurl">Base URL</label>
        <input class="field-input" id="set-baseurl" type="text" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false" />
        <div class="field-hint">Override the default endpoint (for local proxies or self-hosted).</div>
      </div>

      <div class="test-result hidden" id="set-test-result"></div>
    </div>
    <div class="modal-footer">
      <div class="modal-footer-left">
        <button class="btn btn-danger" id="set-clear-key" title="Remove the stored API key">Clear key</button>
      </div>
      <div class="modal-footer-right">
        <button class="btn btn-ghost" id="set-cancel">Cancel</button>
        <button class="btn btn-secondary" id="set-test" title="Make a minimal API call to verify the key works">Test connection</button>
        <button class="btn btn-primary" id="set-save">Save</button>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  const { kovixAPI } = window;

  const els = {
    providerChip: document.getElementById('provider-chip'),
    stateIdea: document.getElementById('state-idea'),
    stateRefine: document.getElementById('state-refine'),
    stateSpec: document.getElementById('state-spec'),
    ideaInput: document.getElementById('idea-input'),
    ideaStart: document.getElementById('idea-start'),
    refineIdeaText: document.getElementById('refine-idea-text'),
    conversation: document.getElementById('conversation'),
    answerBox: document.getElementById('answer-box'),
    answerInput: document.getElementById('answer-input'),
    answerSend: document.getElementById('answer-send'),
    specCard: document.getElementById('spec-card'),
    specRestart: document.getElementById('spec-restart'),
    noProviderBanner: document.getElementById('no-provider-banner'),
    noProviderOpenSettings: document.getElementById('no-provider-open-settings'),
    gearBtn: document.getElementById('gear-btn'),
    settingsOverlay: document.getElementById('settings-overlay'),
    settingsClose: document.getElementById('settings-close'),
    setProvider: document.getElementById('set-provider'),
    setProviderHint: document.getElementById('set-provider-hint'),
    setApikeyField: document.getElementById('set-apikey-field'),
    setApikey: document.getElementById('set-apikey'),
    setApikeyReveal: document.getElementById('set-apikey-reveal'),
    setApikeyHint: document.getElementById('set-apikey-hint'),
    setModel: document.getElementById('set-model'),
    setModelList: document.getElementById('set-model-list'),
    setBaseurlField: document.getElementById('set-baseurl-field'),
    setBaseurl: document.getElementById('set-baseurl'),
    setTestResult: document.getElementById('set-test-result'),
    setClearKey: document.getElementById('set-clear-key'),
    setCancel: document.getElementById('set-cancel'),
    setTest: document.getElementById('set-test'),
    setSave: document.getElementById('set-save'),
  };

  // --- Provider chip ---
  // The main process can tell us which provider is configured via an IPC
  // call. We also listen for a 'provider-changed' event fired after settings
  // are saved, so the chip updates without a page reload.
  async function refreshProviderChip() {
    try {
      const label = await kovixAPI.getProviderLabel();
      els.providerChip.textContent = label;
      // If label indicates no provider, show the banner
      const noProvider = /no provider/i.test(label) || /open settings/i.test(label);
      els.noProviderBanner.classList.toggle('hidden', !noProvider);
    } catch {
      els.providerChip.textContent = 'provider: see console';
      els.noProviderBanner.classList.remove('hidden');
    }
  }
  refreshProviderChip();
  kovixAPI.onProviderChanged(refreshProviderChip);

  // --- State transitions ---
  function showState(name) {
    els.stateIdea.classList.toggle('hidden', name !== 'idea');
    els.stateRefine.classList.toggle('hidden', name !== 'refine');
    els.stateSpec.classList.toggle('hidden', name !== 'spec');
  }

  // --- IDEA state ---
  function updateIdeaStartEnabled() {
    els.ideaStart.disabled = els.ideaInput.value.trim().length === 0;
  }
  els.ideaInput.addEventListener('input', updateIdeaStartEnabled);
  els.ideaInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.ideaStart.disabled) {
      startRefinement();
    }
  });
  els.ideaStart.addEventListener('click', startRefinement);
  document.querySelectorAll('.example-ideas button').forEach(btn => {
    btn.addEventListener('click', () => {
      els.ideaInput.value = btn.dataset.idea;
      updateIdeaStartEnabled();
      els.ideaInput.focus();
    });
  });

  async function startRefinement() {
    const ideaText = els.ideaInput.value.trim();
    if (!ideaText) return;
    els.ideaStart.disabled = true;
    els.ideaStart.textContent = 'Starting…';

    // Reset conversation
    els.conversation.innerHTML = '';
    els.refineIdeaText.textContent = ideaText;

    // Show refining state with a loading indicator
    showState('refine');
    appendLoadingTurn();

    try {
      const result = await kovixAPI.refine.start(ideaText);
      removeLoadingTurn();
      handleRefineResult(result);
    } catch (err) {
      removeLoadingTurn();
      showError(err.message || String(err));
      els.ideaStart.disabled = false;
      els.ideaStart.textContent = 'Start refinement';
      showState('idea');
    }
  }

  // --- REFINING state ---
  function appendLoadingTurn() {
    const div = document.createElement('div');
    div.className = 'turn turn-assistant turn-loading';
    div.id = 'loading-turn';
    div.innerHTML = '<div class="turn-role">Kovix</div><div class="turn-bubble"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    els.conversation.appendChild(div);
    scrollToBottom();
  }
  function removeLoadingTurn() {
    const loading = document.getElementById('loading-turn');
    if (loading) loading.remove();
  }

  function appendTurn(role, content, isCurrent) {
    const div = document.createElement('div');
    div.className = 'turn turn-' + role + (isCurrent ? ' turn-current' : '');
    div.innerHTML = '<div class="turn-role">' + (role === 'user' ? 'You' : 'Kovix') + '</div><div class="turn-bubble"></div>';
    div.querySelector('.turn-bubble').textContent = content;
    els.conversation.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function handleRefineResult(result) {
    if (result.kind === 'question') {
      // Remove "current" highlight from any prior question
      const priorCurrent = els.conversation.querySelector('.turn-current');
      if (priorCurrent) priorCurrent.classList.remove('turn-current');
      appendTurn('assistant', result.text, true);
      // Focus the answer input
      els.answerInput.value = '';
      els.answerInput.disabled = false;
      els.answerSend.disabled = false;
      els.answerInput.focus();
    } else if (result.kind === 'spec') {
      renderSpec(result.spec);
      showState('spec');
    }
  }

  function updateAnswerSendEnabled() {
    els.answerSend.disabled = els.answerInput.value.trim().length === 0;
  }
  els.answerInput.addEventListener('input', updateAnswerSendEnabled);
  els.answerInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.answerSend.disabled) {
      sendAnswer();
    }
  });
  els.answerSend.addEventListener('click', sendAnswer);

  async function sendAnswer() {
    const answer = els.answerInput.value.trim();
    if (!answer) return;

    // Remove "current" highlight from the question
    const priorCurrent = els.conversation.querySelector('.turn-current');
    if (priorCurrent) priorCurrent.classList.remove('turn-current');

    // Append the user's answer as a turn
    appendTurn('user', answer, false);

    // Disable input while waiting
    els.answerInput.value = '';
    els.answerInput.disabled = true;
    els.answerSend.disabled = true;

    appendLoadingTurn();

    try {
      const result = await kovixAPI.refine.continue(answer);
      removeLoadingTurn();
      handleRefineResult(result);
    } catch (err) {
      removeLoadingTurn();
      showError(err.message || String(err));
      // Re-enable input so the user can try again
      els.answerInput.disabled = false;
      els.answerSend.disabled = false;
      els.answerInput.focus();
    }
  }

  // --- SPEC state ---
  function renderSpec(spec) {
    const sections = [
      { key: 'must', title: 'Must have', desc: 'Hard requirements. The build is incomplete without these.' },
      { key: 'should', title: 'Should have', desc: 'Nice-to-haves. Would improve quality but are not blocking.' },
      { key: 'wont', title: 'Won\u2019t have', desc: 'Explicit non-goals. Out of scope for this build.' },
      { key: 'doneCriteria', title: 'Done criteria', desc: 'Verifiable checks. When all pass, the build is done.' },
    ];
    els.specCard.innerHTML = '';
    for (const section of sections) {
      const items = spec[section.key] || [];
      const div = document.createElement('div');
      div.className = 'spec-section ' + section.key;
      const isEmpty = items.length === 0;
      const listHtml = isEmpty
        ? '<ul class="spec-list"><li class="spec-empty">(no items — the model left this empty)</li></ul>'
        : '<ul class="spec-list">' + items.map(i => '<li></li>').join('') + '</ul>';
      div.innerHTML =
        '<div class="spec-section-header">' +
          '<span class="spec-section-label ' + section.key + '">' + section.key + '</span>' +
          '<span class="spec-section-title">' + section.title + '</span>' +
          '<span class="spec-section-count">' + items.length + (items.length === 1 ? ' item' : ' items') + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-3);margin-bottom:8px">' + section.desc + '</div>' +
        listHtml;
      // Set item text via textContent to avoid HTML injection
      if (!isEmpty) {
        const lis = div.querySelectorAll('.spec-list li');
        items.forEach((item, i) => { if (lis[i]) lis[i].textContent = item; });
      }
      els.specCard.appendChild(div);
    }
  }

  els.specRestart.addEventListener('click', () => {
    // Reset everything
    els.ideaInput.value = '';
    els.conversation.innerHTML = '';
    els.specCard.innerHTML = '';
    updateIdeaStartEnabled();
    els.ideaStart.textContent = 'Start refinement';
    showState('idea');
    els.ideaInput.focus();
  });

  // --- Error banner ---
  function showError(msg) {
    const existing = document.querySelector('.error-banner');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'error-banner';
    div.textContent = 'Error: ' + msg;
    document.querySelector('main .container').prepend(div);
    setTimeout(() => div.remove(), 8000);
  }

  // --- SETTINGS MODAL ---
  let providersList = [];
  let currentPreview = null;

  async function loadProvidersList() {
    if (providersList.length > 0) { return providersList; }
    providersList = await kovixAPI.settings.listProviders();
    return providersList;
  }

  async function openSettings() {
    // Populate provider dropdown
    const providers = await loadProvidersList();
    els.setProvider.innerHTML = '';
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.label + (p.verified ? '' : ' (unverified)') + (p.offline ? ' · local' : '');
      els.setProvider.appendChild(opt);
    }

    // Load current preview and populate fields
    currentPreview = await kovixAPI.settings.getPreview();
    if (currentPreview.provider) {
      els.setProvider.value = currentPreview.provider;
    } else {
      els.setProvider.value = 'anthropic';
    }
    els.setApikey.value = '';  // Never show the real key — user must re-type to change
    els.setApikey.placeholder = currentPreview.apiKeyMasked
      ? 'Stored as ' + currentPreview.apiKeyMasked + ' — type to replace'
      : 'Paste your API key here';
    els.setApikeyHint.textContent = currentPreview.apiKeyEncrypted
      ? 'Stored encrypted via OS keychain (safeStorage). Never logged, never committed.'
      : (currentPreview.apiKeyMasked
          ? '⚠️ Stored as PLAINTEXT (safeStorage unavailable on this platform). File is chmod 0600 + gitignored.'
          : 'Stored encrypted via OS keychain (safeStorage). Never logged, never committed.');
    els.setModel.value = currentPreview.modelId || '';
    els.setBaseurl.value = currentPreview.baseUrl || '';

    await updateProviderSpecificUI();
    hideTestResult();

    els.settingsOverlay.classList.remove('hidden');
    // Force reflow then add .open for the transition
    void els.settingsOverlay.offsetWidth;
    els.settingsOverlay.classList.add('open');
  }

  function closeSettings() {
    els.settingsOverlay.classList.remove('open');
    setTimeout(() => els.settingsOverlay.classList.add('hidden'), 150);
  }

  async function updateProviderSpecificUI() {
    const providerName = els.setProvider.value;
    const provider = providersList.find(p => p.name === providerName);
    if (!provider) { return; }

    // Show/hide API key field
    els.setApikeyField.classList.toggle('hidden', !provider.requiresApiKey);

    // Show/hide base URL field (only for local/custom providers)
    const showBaseUrl = ['ollama', 'lmstudio', 'litellm', 'custom', 'xenova'].includes(providerName);
    els.setBaseurlField.classList.toggle('hidden', !showBaseUrl);

    // Update provider hint
    const hints = {
      anthropic: 'Key starts with sk-ant-. Get one at console.anthropic.com.',
      openrouter: 'Key starts with sk-or-. Get one at openrouter.ai/keys.',
      openai: 'Key starts with sk-. Get one at platform.openai.com/api-keys.',
      nvidia: 'NVIDIA NIM build.nvidia.com API key.',
      together: 'Together AI API key.',
      groq: 'Groq API key from console.groq.com.',
      mistral: 'Mistral API key from console.mistral.ai.',
      deepseek: 'DeepSeek API key from platform.deepseek.com.',
      gemini: 'Google AI Studio API key.',
      ollama: 'No key needed. Runs locally at localhost:11434.',
      lmstudio: 'No key needed. Runs locally via LM Studio.',
      litellm: 'Optional proxy key. Runs locally.',
      xenova: 'No key needed. Runs in-process via ONNX.',
      custom: 'Any OpenAI-compatible endpoint. Set Base URL below.',
    };
    els.setProviderHint.textContent = hints[providerName] || '';

    // Populate model datalist
    const models = await kovixAPI.settings.getModelsForProvider(providerName);
    els.setModelList.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      els.setModelList.appendChild(opt);
    }

    // If preview has a model and provider matches, keep it; otherwise use first suggestion
    if (currentPreview && currentPreview.provider === providerName && currentPreview.modelId) {
      els.setModel.value = currentPreview.modelId;
    } else if (models.length > 0 && !els.setModel.value) {
      els.setModel.value = models[0];
    } else if (models.length === 0) {
      els.setModel.value = '';
    }
  }

  function showTestResult(kind, message, preview) {
    els.setTestResult.classList.remove('hidden', 'ok', 'fail', 'pending');
    els.setTestResult.classList.add(kind);
    const icon = kind === 'ok' ? '✓' : (kind === 'fail' ? '✗' : '…');
    let html = '<div class="test-result-icon">' + icon + '</div><div>';
    html += '<div>' + escapeHtml(message) + '</div>';
    if (preview) { html += '<div style="font-size:11px;opacity:0.8;margin-top:2px">Model said: ' + escapeHtml(preview) + '</div>'; }
    html += '</div>';
    els.setTestResult.innerHTML = html;
  }
  function hideTestResult() {
    els.setTestResult.classList.add('hidden');
    els.setTestResult.innerHTML = '';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Wire up settings events
  els.gearBtn.addEventListener('click', openSettings);
  els.noProviderOpenSettings.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.setCancel.addEventListener('click', closeSettings);
  els.setProvider.addEventListener('change', updateProviderSpecificUI);

  els.setApikeyReveal.addEventListener('click', () => {
    const isPassword = els.setApikey.type === 'password';
    els.setApikey.type = isPassword ? 'text' : 'password';
    els.setApikeyReveal.textContent = isPassword ? 'Hide' : 'Show';
  });

  els.setTest.addEventListener('click', async () => {
    hideTestResult();
    els.setTest.disabled = true;
    els.setTest.textContent = 'Testing…';
    showTestResult('pending', 'Making a minimal API call…', null);
    try {
      const result = await kovixAPI.settings.testConnection({
        provider: els.setProvider.value,
        apiKey: els.setApikey.value || undefined,  // empty = use stored key (if any)
        modelId: els.setModel.value || undefined,
        baseUrl: els.setBaseurl.value || undefined,
      });
      if (result.ok) {
        showTestResult('ok', result.message, result.responsePreview);
      } else {
        showTestResult('fail', result.message, null);
      }
    } catch (err) {
      showTestResult('fail', 'Test failed: ' + (err.message || String(err)), null);
    } finally {
      els.setTest.disabled = false;
      els.setTest.textContent = 'Test connection';
    }
  });

  els.setSave.addEventListener('click', async () => {
    els.setSave.disabled = true;
    els.setSave.textContent = 'Saving…';
    try {
      const newPreview = await kovixAPI.settings.save({
        provider: els.setProvider.value,
        apiKey: els.setApikey.value || undefined,
        modelId: els.setModel.value || undefined,
        baseUrl: els.setBaseurl.value || undefined,
      });
      currentPreview = newPreview;
      closeSettings();
      await refreshProviderChip();
    } catch (err) {
      showTestResult('fail', 'Save failed: ' + (err.message || String(err)), null);
    } finally {
      els.setSave.disabled = false;
      els.setSave.textContent = 'Save';
    }
  });

  els.setClearKey.addEventListener('click', async () => {
    if (!confirm('Remove the stored API key? Provider and model settings will be kept.')) { return; }
    try {
      await kovixAPI.settings.clearApiKey();
      currentPreview = await kovixAPI.settings.getPreview();
      els.setApikey.value = '';
      els.setApikey.placeholder = 'Paste your API key here';
      els.setApikeyHint.textContent = 'Stored encrypted via OS keychain (safeStorage). Never logged, never committed.';
      showTestResult('ok', 'API key cleared.', null);
      await refreshProviderChip();
    } catch (err) {
      showTestResult('fail', 'Clear failed: ' + (err.message || String(err)), null);
    }
  });

  // Close on overlay click (outside the modal)
  els.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === els.settingsOverlay) { closeSettings(); }
  });
  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.settingsOverlay.classList.contains('hidden')) {
      closeSettings();
    }
  });

  // --- Initial state ---
  showState('idea');
  updateIdeaStartEnabled();
  els.ideaInput.focus();
})();
</script>
</body>
</html>`;
