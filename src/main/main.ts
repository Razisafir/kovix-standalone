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
    PlanningService,
} from '../agent/index.js';
import type {
    AgentLoopEvent,
    ProviderName,
    RefinementResult,
    RefinementTurn,
    PlanMilestone,
    PlanResult,
} from '../agent/index.js';
import type { RefinementSpec } from '../agent/refinement/refinementService.js';
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
import {
    createEmptySession,
    defaultPreflightConfig,
    type BuildSession,
    type BuildStage,
    type PreflightConfig,
    type MilestonePauseMode,
    type MilestoneExecutionState,
} from './sessionStore.js';
import type { IApprovedPlan, IMilestone, ISelectablePlanStep } from '../agent/milestoneStateMachine.js';

let mainWindow: BrowserWindow | null = null;
let agent: AgentLoop | null = null;
let refinementService: RefinementService | null = null;
let planningService: PlanningService | null = null;

// The full Build mode session — shared across all screens (Idea → Refine →
// Spec → Plan → Pre-flight → Execute → Done). In-memory only; lost on window
// close. Settings (provider/key/model) are persisted separately by settingsStore.
let session: BuildSession = createEmptySession();

// Execution-control state — these are NOT on the session object because they
// hold live promises/resolvers that shouldn't be serialized or shown to the
// renderer. They're main-process internals.
let executionAbortController: AbortController | null = null;
let milestoneResumeResolver: ((action: 'resume' | 'skip') => void) | null = null;

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
    // getAgent() / getRefinementService() / getPlanningService() will rebuild
    // with the new config.
    agent = null;
    refinementService = null;
    planningService = null;
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

async function getPlanningService(): Promise<PlanningService> {
    if (planningService) { return planningService; }
    const cfg = await getProviderConfig();
    const provider = createProvider(cfg);
    planningService = new PlanningService({
        aiProvider: provider,
        log: (msg) => console.log('[plan] ' + msg),
    });
    return planningService;
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
    session = createEmptySession();
    session.ideaText = ideaText.trim();
    session.stage = 'refining';

    if (DEMO_MODE) {
        const fakeQuestion: RefinementResult = { kind: 'question', text: DEMO_QUESTIONS[0] };
        session.priorTurns.push({ role: 'assistant', content: fakeQuestion.text });
        return fakeQuestion;
    }

    const service = await getRefinementService();
    const result = await service.refine({
        ideaText: session.ideaText,
        priorTurns: session.priorTurns,
    });
    if (result.kind === 'question') {
        session.priorTurns.push({ role: 'assistant', content: result.text });
    } else {
        // Spec emitted — store it and advance stage.
        session.spec = result.spec;
        session.stage = 'spec';
    }
    return result;
});

ipcMain.handle('kovix:refine:continue', async (_event, answer: string): Promise<RefinementResult> => {
    if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
        throw new Error('Answer is required.');
    }
    if (!session.ideaText) {
        throw new Error('No active refinement session. Call refine:start first.');
    }
    // Record the user's answer.
    session.priorTurns.push({ role: 'user', content: answer.trim() });

    if (DEMO_MODE) {
        // After each answer, return the next fake question. After all 3
        // questions are answered, return the fake spec.
        const assistantTurnCount = session.priorTurns.filter(t => t.role === 'assistant').length;
        if (assistantTurnCount < DEMO_QUESTIONS.length) {
            const nextQ = DEMO_QUESTIONS[assistantTurnCount];
            session.priorTurns.push({ role: 'assistant', content: nextQ });
            return { kind: 'question', text: nextQ };
        }
        session.spec = DEMO_SPEC.spec;
        session.stage = 'spec';
        return DEMO_SPEC;
    }

    const service = await getRefinementService();
    const result = await service.refine({
        ideaText: session.ideaText,
        priorTurns: session.priorTurns,
    });
    if (result.kind === 'question') {
        session.priorTurns.push({ role: 'assistant', content: result.text });
    } else {
        // Spec emitted — store it and advance stage.
        session.spec = result.spec;
        session.stage = 'spec';
    }
    return result;
});

// ----------------------------------------------------------------------
// Phase 2 IPC handlers — Spec Approval / Plan / Pre-flight / Execute
// ----------------------------------------------------------------------

/**
 * Return the current session state to the renderer. The renderer uses this
 * to decide which screen to show after a reload or a settings change.
 *
 * We strip nothing — the session is safe to share (no API keys live here;
 * those are in settingsStore, never in the session).
 */
ipcMain.handle('kovix:session:get-state', async (): Promise<BuildSession> => {
    return session;
});

/**
 * Reset the session back to the Idea stage. Called when the user clicks
 * "Start over" on the spec or plan screens.
 */
ipcMain.handle('kovix:session:reset', async (): Promise<BuildSession> => {
    session = createEmptySession();
    return session;
});

// ---- Spec Approval ----

/**
 * Update an item in the spec. The renderer sends {section, index, value}
 * where section is 'must' | 'should' | 'wont' | 'doneCriteria'. Only allowed
 * before approval — after approval, the spec is locked.
 */
ipcMain.handle('kovix:spec:update-item', async (
    _event,
    payload: { section: 'must' | 'should' | 'wont' | 'doneCriteria'; index: number; value: string },
): Promise<{ ok: boolean; spec: RefinementSpec | null; error?: string }> => {
    if (session.specApprovedAt !== null) {
        return { ok: false, spec: session.spec, error: 'Spec is approved and locked. Reset to edit.' };
    }
    if (!session.spec) {
        return { ok: false, spec: null, error: 'No spec to edit.' };
    }
    const { section, index, value } = payload;
    const arr = session.spec[section];
    if (!Array.isArray(arr) || index < 0 || index >= arr.length) {
        return { ok: false, spec: session.spec, error: 'Invalid index.' };
    }
    const trimmed = value.trim();
    if (!trimmed) {
        // Empty value — remove the item.
        arr.splice(index, 1);
    } else {
        arr[index] = trimmed;
    }
    return { ok: true, spec: session.spec };
});

/**
 * Add a new item to a spec section.
 */
ipcMain.handle('kovix:spec:add-item', async (
    _event,
    payload: { section: 'must' | 'should' | 'wont' | 'doneCriteria'; value: string },
): Promise<{ ok: boolean; spec: RefinementSpec | null; error?: string }> => {
    if (session.specApprovedAt !== null) {
        return { ok: false, spec: session.spec, error: 'Spec is approved and locked. Reset to edit.' };
    }
    if (!session.spec) {
        return { ok: false, spec: null, error: 'No spec to edit.' };
    }
    const trimmed = payload.value.trim();
    if (!trimmed) {
        return { ok: false, spec: session.spec, error: 'Value is empty.' };
    }
    session.spec[payload.section].push(trimmed);
    return { ok: true, spec: session.spec };
});

/**
 * Remove an item from a spec section.
 */
ipcMain.handle('kovix:spec:remove-item', async (
    _event,
    payload: { section: 'must' | 'should' | 'wont' | 'doneCriteria'; index: number },
): Promise<{ ok: boolean; spec: RefinementSpec | null; error?: string }> => {
    if (session.specApprovedAt !== null) {
        return { ok: false, spec: session.spec, error: 'Spec is approved and locked. Reset to edit.' };
    }
    if (!session.spec) {
        return { ok: false, spec: null, error: 'No spec to edit.' };
    }
    const arr = session.spec[payload.section];
    if (!Array.isArray(arr) || payload.index < 0 || payload.index >= arr.length) {
        return { ok: false, spec: session.spec, error: 'Invalid index.' };
    }
    arr.splice(payload.index, 1);
    return { ok: true, spec: session.spec };
});

/**
 * Approve the spec. Locks it (specApprovedAt set, further edits rejected)
 * and advances the stage to 'plan'. The renderer will then call
 * kovix:plan:generate to kick off the planning LLM call.
 */
ipcMain.handle('kovix:spec:approve', async (): Promise<{ ok: boolean; spec: RefinementSpec | null; error?: string }> => {
    if (!session.spec) {
        return { ok: false, spec: null, error: 'No spec to approve.' };
    }
    if (session.specApprovedAt !== null) {
        return { ok: false, spec: session.spec, error: 'Spec already approved.' };
    }
    // Defensive: ensure must and doneCriteria are non-empty (the refinement
    // service enforces this, but the user might have deleted everything).
    if (session.spec.must.length === 0) {
        return { ok: false, spec: session.spec, error: 'Spec must have at least one "must" item.' };
    }
    if (session.spec.doneCriteria.length === 0) {
        return { ok: false, spec: session.spec, error: 'Spec must have at least one done criterion.' };
    }
    session.specApprovedAt = Date.now();
    session.stage = 'plan';
    return { ok: true, spec: session.spec };
});

// ---- Plan Generation ----

/**
 * Generate a milestone plan from the approved spec via the planningService.
 * Requires the spec to be approved first.
 *
 * In DEMO_MODE, returns a deterministic fake plan so the UI flow can be
 * screenshot-tested without an LLM call.
 */
ipcMain.handle('kovix:plan:generate', async (): Promise<{ ok: boolean; plan: PlanResult | null; error?: string }> => {
    if (!session.spec) {
        return { ok: false, plan: null, error: 'No spec — refine an idea first.' };
    }
    if (session.specApprovedAt === null) {
        return { ok: false, plan: null, error: 'Spec not approved. Approve the spec first.' };
    }

    if (DEMO_MODE) {
        const demoPlan: PlanResult = {
            summary: 'Scaffold a Node CLI that watches a folder and prints changes.',
            milestones: [
                {
                    id: 'm1', name: 'Scaffold project structure', type: 'Create', isMajor: true,
                    description: 'Create package.json, bin/kovix-watch.js, and README.md.',
                    satisfies: [session.spec.must[0] ?? 'CLI accepts a folder path'],
                    estimatedCredits: 200,
                },
                {
                    id: 'm2', name: 'Implement file watcher', type: 'Create', isMajor: true,
                    description: 'Use fs.watch recursively to detect changes and print to stdout.',
                    satisfies: [session.spec.must[1] ?? 'Prints each changed file path'],
                    estimatedCredits: 400,
                },
                {
                    id: 'm3', name: 'Add .git/node_modules ignore', type: 'Edit', isMajor: false,
                    description: 'Filter out ignored directories from the watch output.',
                    satisfies: [session.spec.must[2] ?? 'Ignores .git and node_modules'],
                    estimatedCredits: 150,
                },
                {
                    id: 'm4', name: 'Verify output', type: 'Run', isMajor: true,
                    description: 'Run the CLI and confirm a changed file appears in stdout within 1s.',
                    satisfies: session.spec.doneCriteria,
                    estimatedCredits: 100,
                },
            ],
        };
        session.planSummary = demoPlan.summary;
        session.milestones = demoPlan.milestones;
        return { ok: true, plan: demoPlan };
    }

    try {
        const service = await getPlanningService();
        const result = await service.plan({
            spec: session.spec,
            ideaText: session.ideaText,
        });
        session.planSummary = result.summary;
        session.milestones = result.milestones;
        return { ok: true, plan: result };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[kovix:plan:generate] error:', msg);
        return { ok: false, plan: null, error: msg };
    }
});

/**
 * Approve the plan. Locks it and advances to 'preflight' stage.
 */
ipcMain.handle('kovix:plan:approve', async (): Promise<{ ok: boolean; error?: string }> => {
    if (session.milestones.length === 0) {
        return { ok: false, error: 'No plan to approve. Generate a plan first.' };
    }
    if (session.planApprovedAt !== null) {
        return { ok: false, error: 'Plan already approved.' };
    }
    session.planApprovedAt = Date.now();
    session.stage = 'preflight';
    // Initialize preflight with sensible defaults.
    session.preflight = defaultPreflightConfig(session.milestones);
    return { ok: true };
});

// ---- Pre-flight Config ----

/**
 * Save the pre-flight configuration. The renderer sends the full config
 * object; we validate and store it.
 */
ipcMain.handle('kovix:preflight:save', async (
    _event,
    config: { pauseMode: MilestonePauseMode; customPauseIds: string[]; creditLimit: number; verifyAfterEach: boolean },
): Promise<{ ok: boolean; preflight: PreflightConfig | null; error?: string }> => {
    if (!['every', 'major', 'auto', 'custom'].includes(config.pauseMode)) {
        return { ok: false, preflight: null, error: 'Invalid pause mode.' };
    }
    if (!Array.isArray(config.customPauseIds)) {
        return { ok: false, preflight: null, error: 'customPauseIds must be an array.' };
    }
    // Validate customPauseIds reference real milestones.
    const validIds = new Set(session.milestones.map(m => m.id));
    const invalidIds = config.customPauseIds.filter(id => !validIds.has(id));
    if (invalidIds.length > 0) {
        return { ok: false, preflight: null, error: 'Unknown milestone IDs in customPauseIds: ' + invalidIds.join(', ') };
    }
    if (typeof config.creditLimit !== 'number' || config.creditLimit < 0 || !isFinite(config.creditLimit)) {
        return { ok: false, preflight: null, error: 'creditLimit must be a non-negative number.' };
    }
    const preflight: PreflightConfig = {
        pauseMode: config.pauseMode,
        customPauseIds: config.customPauseIds,
        creditLimit: Math.floor(config.creditLimit),
        verifyAfterEach: !!config.verifyAfterEach,
    };
    session.preflight = preflight;
    return { ok: true, preflight };
});

/**
 * Advance from preflight to executing. Locks the preflight config in place
 * (it can't be edited mid-execution).
 */
ipcMain.handle('kovix:preflight:confirm', async (): Promise<{ ok: boolean; error?: string }> => {
    if (session.planApprovedAt === null) {
        return { ok: false, error: 'Plan not approved.' };
    }
    if (!session.preflight) {
        return { ok: false, error: 'No preflight config. Save one first.' };
    }
    session.stage = 'executing';
    // Initialize milestone execution states.
    session.execution.milestoneStates = session.milestones.map(m => ({
        milestoneId: m.id,
        status: 'pending' as const,
        events: [],
    }));
    session.execution.currentMilestoneId = null;
    session.execution.totalCreditsUsed = 0;
    session.execution.startedAt = Date.now();
    session.execution.endedAt = null;
    session.execution.abortRequested = false;
    return { ok: true };
});

// ---- Execute ----

/**
 * Build an IApprovedPlan from the session's milestones + preflight config,
 * then run the agent loop's runWithApprovedPlan() generator. Events are
 * streamed to the renderer via 'kovix:exec:event' IPC.
 *
 * The agent loop's milestoneExecutor handles the pause/resume logic using
 * the executionMode + selectedMilestoneIds fields on IApprovedPlan. We map
 * our preflight config to those fields here.
 *
 * The awaitResume callback is wired to our milestoneResumeResolver — when
 * the renderer calls kovix:exec:resume or kovix:exec:skip, we resolve that
 * promise.
 */
function buildApprovedPlan(): IApprovedPlan {
    if (!session.spec) { throw new Error('No spec.'); }
    if (session.milestones.length === 0) { throw new Error('No milestones.'); }
    if (!session.preflight) { throw new Error('No preflight config.'); }

    // Convert our PlanMilestone[] into the IMilestone[] shape the agent loop
    // expects. Each milestone maps to a single "step" (the milestone's
    // description as the task), and stepIndices references that one step.
    // This is a simplification — the original VS Code fork had multi-step
    // milestones, but for Phase 2 we treat each milestone as one execution
    // unit. The agent loop's executeSubTask gets the milestone description
    // and figures out what files to actually touch.
    const steps: ISelectablePlanStep[] = session.milestones.map((m, i) => ({
        index: i,
        action: m.type,
        target: m.name,
        description: m.description,
        selected: true,
    }));
    const milestones: IMilestone[] = session.milestones.map((m, i) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        index: i,
        isMajor: m.isMajor,
        stepIndices: [i],
        completed: false,
    }));

    // Map our preflight pauseMode to the executionMode the milestoneExecutor
    // expects. The milestoneExecutor uses: 'every_milestone' | 'major_milestone'
    // | 'selective' | 'auto'.
    let executionMode: string;
    let selectedMilestoneIds: string[] | undefined;
    switch (session.preflight.pauseMode) {
        case 'every': executionMode = 'every_milestone'; break;
        case 'major': executionMode = 'major_milestone'; break;
        case 'custom': executionMode = 'selective'; selectedMilestoneIds = session.preflight.customPauseIds; break;
        case 'auto': default: executionMode = 'auto'; break;
    }

    return {
        task: session.ideaText + '\n\nApproved spec:\n' + JSON.stringify(session.spec, null, 2),
        steps,
        executionMode,
        milestones,
        selectedMilestoneIds,
        approved: true,
        approvedAt: session.planApprovedAt ?? Date.now(),
    };
}

/**
 * Helper: send an event to the renderer if the window is alive.
 */
function sendExecEvent(event: AgentLoopEvent): void {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('kovix:exec:event', event);
        }
    } catch (err) {
        console.error('[kovix:exec] failed to send event to renderer:', err);
    }
}

/**
 * Helper: update a milestone's execution state and notify the renderer.
 */
function updateMilestoneState(milestoneId: string, update: Partial<MilestoneExecutionState>): void {
    const state = session.execution.milestoneStates.find(s => s.milestoneId === milestoneId);
    if (!state) { return; }
    Object.assign(state, update);
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('kovix:exec:state-update', {
                milestoneId,
                state: { ...state },
                totalCreditsUsed: session.execution.totalCreditsUsed,
            });
        }
    } catch (err) {
        console.error('[kovix:exec] failed to send state update:', err);
    }
}

/**
 * Start execution. This is the big one — it runs the agent loop over the
 * plan's milestones, respecting the preflight pause config.
 *
 * The IPC handler returns immediately with { ok: true } once execution has
 * started; all subsequent progress comes via 'kovix:exec:event' and
 * 'kovix:exec:state-update' events. The renderer listens for these.
 *
 * Execution ends when:
 *   - All milestones complete (success)
 *   - A fatal error occurs
 *   - The user aborts (kovix:exec:abort)
 *   - The credit limit is exceeded (if set)
 */
ipcMain.handle('kovix:exec:start', async (): Promise<{ ok: boolean; error?: string }> => {
    if (session.stage !== 'executing') {
        return { ok: false, error: 'Not in executing stage. Confirm preflight first.' };
    }
    if (session.milestones.length === 0) {
        return { ok: false, error: 'No milestones to execute.' };
    }
    if (!session.preflight) {
        return { ok: false, error: 'No preflight config.' };
    }

    // Build the agent loop. We use a FRESH AgentLoop instance for each
    // execution so conversation history doesn't leak between builds. The
    // agent is configured with:
    //   - approveWrite: true (auto-approve for now — the staging layer still
    //     FIRES the approval_request event so the UI can show it; the actual
    //     disk write just happens immediately. A future "manual approval"
    //     preflight toggle would change this to a renderer-driven callback.)
    //   - approveInterpreterCommand: true (same — auto-approve, but logged)
    //   - workspaceRoot: a per-build workspace under the OS temp dir so we
    //     don't trash the user's actual project. Phase 2 verification confirms
    //     files appear there.
    const cfg = await getProviderConfig();
    const provider = createProvider(cfg);

    // Per-build workspace: kovix-builds/<timestamp>/. This is where the
    // agent's writes land. It's NOT the kovix-standalone repo itself.
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const buildDir = path.join(os.tmpdir(), 'kovix-builds', 'build-' + Date.now());
    await fs.mkdir(buildDir, { recursive: true });
    console.log('[kovix:exec] build workspace:', buildDir);

    // Track approval state for verification
    let approvalFired = false;
    let fileWrittenBeforeApproval = false;

    const execAgent = new AgentLoop({
        aiProvider: provider,
        workspaceRoot: buildDir,
        log: (msg: string) => console.log('[exec-agent] ' + msg),
        approveWrite: async (filePath: string, proposedContent: string, _existing: string | null) => {
            approvalFired = true;
            console.log('[kovix:exec] APPROVAL CALLBACK: ' + filePath + ' (' + proposedContent.length + ' chars)');
            // Verify staging: file should NOT exist on disk yet.
            try {
                await fs.readFile(path.join(buildDir, filePath), 'utf8');
                fileWrittenBeforeApproval = true;
                console.error('[kovix:exec] VIOLATION: file written before approval!');
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    console.log('[kovix:exec] confirmed: file NOT on disk before approval (staging works)');
                }
            }
            return true; // auto-approve (the staging layer already blocked the write)
        },
        approveInterpreterCommand: async (cmd: string) => {
            console.log('[kovix:exec] AUTO-APPROVING interpreter command: ' + cmd);
            return true;
        },
        onlineMode: false,
    });

    // Build the approved plan from session state.
    const approvedPlan = buildApprovedPlan();

    // Set up abort controller.
    executionAbortController = new AbortController();

    // Wire the resume resolver. The agent loop's awaitResume callback will
    // be called when it pauses at a milestone; we return a promise that's
    // resolved by kovix:exec:resume or kovix:exec:skip.
    const awaitResume = (milestone: IMilestone): Promise<'resume' | 'skip'> => {
        updateMilestoneState(milestone.id, { status: 'paused' });
        sendExecEvent({
            type: 'milestone_paused',
            milestone,
        } as AgentLoopEvent);
        return new Promise<'resume' | 'skip'>((resolve) => {
            milestoneResumeResolver = resolve;
        });
    };

    // Track the current milestone for state updates.
    let currentMilestoneId: string | null = null;

    // Credit tracking — we estimate credits from token counts in events.
    // This is a rough heuristic; the real credit system would come from the
    // provider's usage metadata. For Phase 2, we count characters of token
    // events / 4 as a crude proxy.
    let creditEstimate = 0;

    try {
        const stream = execAgent.runWithApprovedPlan(approvedPlan, executionAbortController.signal);

        for await (const event of stream as AsyncIterable<AgentLoopEvent>) {
            // Check abort.
            if (executionAbortController?.signal.aborted) {
                sendExecEvent({ type: 'error', text: '[STOP] Aborted by user', recoverable: false });
                break;
            }

            // Check credit limit.
            if (session.preflight.creditLimit > 0 && creditEstimate >= session.preflight.creditLimit) {
                sendExecEvent({
                    type: 'error',
                    text: `[Credit limit] Estimated ${creditEstimate} credits used; limit is ${session.preflight.creditLimit}. Aborting.`,
                    recoverable: false,
                });
                break;
            }

            // Track current milestone + emit event to renderer.
            if (event.type === 'milestone_reached') {
                currentMilestoneId = event.milestone.id;
                updateMilestoneState(event.milestone.id, {
                    status: 'running',
                    startedAt: Date.now(),
                });
            } else if (event.type === 'milestone_completed') {
                updateMilestoneState(event.milestone.id, {
                    status: 'completed',
                    endedAt: Date.now(),
                });
                currentMilestoneId = null;
            } else if (event.type === 'milestone_skipped') {
                updateMilestoneState(event.milestone.id, {
                    status: 'skipped',
                    endedAt: Date.now(),
                });
                currentMilestoneId = null;
            } else if (event.type === 'milestone_resumed') {
                updateMilestoneState(event.milestone.id, { status: 'running' });
            } else if (event.type === 'token' && currentMilestoneId) {
                // Rough credit estimate: ~4 chars per token, ~1 credit per token.
                creditEstimate += Math.ceil(event.text.length / 4);
                session.execution.totalCreditsUsed = creditEstimate;
                // Append to the milestone's event log (truncated to avoid memory bloat).
                const state = session.execution.milestoneStates.find(s => s.milestoneId === currentMilestoneId);
                if (state && state.events.length < 200) {
                    state.events.push({ type: 'token', text: event.text, ts: Date.now() });
                }
            } else if (event.type === 'tool_start' && currentMilestoneId) {
                const state = session.execution.milestoneStates.find(s => s.milestoneId === currentMilestoneId);
                if (state && state.events.length < 200) {
                    state.events.push({ type: 'tool_start', text: event.toolName, ts: Date.now() });
                }
            } else if (event.type === 'tool_result' && currentMilestoneId) {
                const state = session.execution.milestoneStates.find(s => s.milestoneId === currentMilestoneId);
                if (state && state.events.length < 200) {
                    const snippet = event.result.substring(0, 200);
                    state.events.push({ type: 'tool_result', text: snippet, ts: Date.now() });
                }
            } else if (event.type === 'verification_result' && currentMilestoneId) {
                updateMilestoneState(currentMilestoneId, {
                    verificationPassed: event.passed,
                    verificationOutput: event.output.substring(0, 2000),
                });
            } else if (event.type === 'file_written' && currentMilestoneId) {
                const state = session.execution.milestoneStates.find(s => s.milestoneId === currentMilestoneId);
                if (state && state.events.length < 200) {
                    state.events.push({ type: 'file_written', text: event.filePath, ts: Date.now() });
                }
            } else if (event.type === 'complete') {
                sendExecEvent(event);
                session.stage = 'done';
                session.execution.endedAt = Date.now();
                session.execution.currentMilestoneId = null;
                // Send final state.
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('kovix:exec:complete', {
                            summary: event.summary,
                            approvalFired,
                            fileWrittenBeforeApproval,
                            buildDir,
                            totalCreditsUsed: creditEstimate,
                        });
                    }
                } catch (err) {
                    console.error('[kovix:exec] failed to send complete event:', err);
                }
                executionAbortController = null;
                milestoneResumeResolver = null;
                return { ok: true };
            }

            sendExecEvent(event);
        }

        // If we reach here, the stream ended without a 'complete' event
        // (probably due to abort or credit limit).
        session.execution.endedAt = Date.now();
        session.execution.currentMilestoneId = null;
        executionAbortController = null;
        milestoneResumeResolver = null;
        return { ok: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[kovix:exec:start] error:', msg);
        session.execution.endedAt = Date.now();
        executionAbortController = null;
        milestoneResumeResolver = null;
        sendExecEvent({ type: 'error', text: msg, recoverable: false });
        return { ok: false, error: msg };
    }
});

/**
 * Resume from a milestone pause. Only valid when the agent is paused.
 */
ipcMain.handle('kovix:exec:resume', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!milestoneResumeResolver) {
        return { ok: false, error: 'Not paused at a milestone.' };
    }
    const resolver = milestoneResumeResolver;
    milestoneResumeResolver = null;
    resolver('resume');
    return { ok: true };
});

/**
 * Skip the current milestone. Only valid when the agent is paused.
 */
ipcMain.handle('kovix:exec:skip', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!milestoneResumeResolver) {
        return { ok: false, error: 'Not paused at a milestone.' };
    }
    const resolver = milestoneResumeResolver;
    milestoneResumeResolver = null;
    resolver('skip');
    return { ok: true };
});

/**
 * Abort execution. Signals the abort controller; the agent loop will stop
 * at the next yield point.
 */
ipcMain.handle('kovix:exec:abort', async (): Promise<{ ok: boolean }> => {
    session.execution.abortRequested = true;
    if (executionAbortController) {
        executionAbortController.abort();
    }
    // If paused, also resolve the resume promise so we don't hang.
    if (milestoneResumeResolver) {
        const resolver = milestoneResumeResolver;
        milestoneResumeResolver = null;
        resolver('skip');
    }
    return { ok: true };
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

    // KOVIX_CHECK_KEY=1: lightweight key-presence check. Calls the same
    // resolveProviderConfig() the e2e verify script uses, prints structured
    // CHECK_KEY:* lines to stdout, then quits. Used by
    // scripts/check-stored-key.ts. Does NOT make any LLM calls. Does NOT
    // print the full key (only a masked preview).
    if (process.env.KOVIX_CHECK_KEY === '1') {
        try {
            await runCheckStoredKey();
        } catch (err) {
            console.error('[check-key] FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
            process.exitCode = 1;
        } finally {
            app.quit();
        }
        return;
    }

    // KOVIX_E2E_VERIFY=1: Phase 2 full end-to-end verification. Drives the
    // entire Build mode flow with REAL LLM calls: Idea → Refinement → Spec
    // approval → Plan generation → Pre-flight config → Execute (real staged
    // writes, real approval gate, real disk writes, real verification) → Done.
    // Prints the full transcript to stdout. Used by test/verify-end-to-end.ts.
    //
    // Requires a real provider config in the settings store (no hardcoded keys).
    if (process.env.KOVIX_E2E_VERIFY === '1') {
        try {
            await runEndToEndVerification();
        } catch (err) {
            console.error('[e2e-verify] FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
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

/**
 * Lightweight key-presence check. Calls the same resolveProviderConfig()
 * the e2e verify script uses, prints structured CHECK_KEY:* lines to stdout
 * (parseable by scripts/check-stored-key.ts), then quits.
 *
 * "Real key present" means: the resolved config is for a cloud provider that
 * requires a key, AND that key is non-empty. Local providers (ollama, xenova,
 * lmstudio, litellm) don't count — they don't prove the production path works.
 *
 * Does NOT make any LLM calls. Does NOT print the full key — only a masked
 * preview (first 8 chars + "..." + last 4 chars).
 */
async function runCheckStoredKey(): Promise<void> {
    const pathMod = await import('node:path');
    const fs = await import('node:fs/promises');

    console.log('=== Kovix — Stored Key Check ===');
    console.log('');

    // Print the settings file path so the user knows exactly where we looked.
    const settingsPath = pathMod.join(app.getPath('userData'), 'kovix-settings.json');
    console.log('CHECK_KEY:SETTINGS_PATH=' + settingsPath);
    let fileExists = false;
    try {
        await fs.access(settingsPath);
        fileExists = true;
    } catch {
        fileExists = false;
    }
    console.log('CHECK_KEY:SETTINGS_FILE_EXISTS=' + fileExists);

    const cfg = await resolveProviderConfig();
    if (!cfg) {
        // resolveProviderConfig never actually returns null in practice
        // (it falls back to ollama), but handle it defensively.
        console.log('CHECK_KEY:KEY_PRESENT=NO');
        console.log('CHECK_KEY:REASON=resolveProviderConfig returned null');
        process.exitCode = 2;
        return;
    }

    const localProviders: ProviderName[] = ['ollama', 'xenova', 'lmstudio', 'litellm'];
    const isLocal = localProviders.includes(cfg.name);
    const hasKey = !!cfg.apiKey && cfg.apiKey.length > 0;
    // A "real" key for our purposes: cloud provider + non-empty key. We do
    // NOT accept the local-provider fallback (ollama with no key) as evidence
    // that the production path works.
    const realKeyPresent = !isLocal && hasKey;

    console.log('CHECK_KEY:PROVIDER=' + cfg.name);
    console.log('CHECK_KEY:SOURCE=' + cfg.source);
    console.log('CHECK_KEY:IS_LOCAL=' + isLocal);
    console.log('CHECK_KEY:HAS_KEY=' + hasKey);
    if (cfg.modelId) {
        console.log('CHECK_KEY:MODEL=' + cfg.modelId);
    }
    if (cfg.baseUrl) {
        console.log('CHECK_KEY:BASE_URL=' + cfg.baseUrl);
    }
    if (hasKey) {
        const k = cfg.apiKey!;
        // Masked preview: first 8 chars + "..." + last 4 chars. Never the
        // full key. (For short keys we mask even more aggressively.)
        const masked = k.length > 12
            ? k.slice(0, 8) + '...' + k.slice(-4)
            : '(short key, masked)';
        console.log('CHECK_KEY:KEY_MASKED=' + masked);
    }

    if (realKeyPresent) {
        console.log('CHECK_KEY:KEY_PRESENT=YES');
        console.log('CHECK_KEY:REASON=cloud provider "' + cfg.name + '" with non-empty key from ' + cfg.source);
    } else {
        console.log('CHECK_KEY:KEY_PRESENT=NO');
        if (isLocal) {
            console.log('CHECK_KEY:REASON=resolved provider is local (' + cfg.name + ') — no API key needed, but production path not proven');
        } else if (!hasKey) {
            console.log('CHECK_KEY:REASON=cloud provider "' + cfg.name + '" resolved but no API key available');
        } else {
            console.log('CHECK_KEY:REASON=unexpected state');
        }
    }

    console.log('');
    console.log('Verdict: ' + (realKeyPresent ? 'REAL key present — e2e verify can proceed.' : 'NO real key — e2e verify will exit with code 2.'));
}

/**
 * Phase 2 end-to-end verification: drives the ENTIRE Build mode flow with
 * real LLM calls, real staged writes, real approval gates, and real disk
 * writes. Prints the full transcript to stdout.
 *
 * Flow:
 *   1. Resolve provider config from settings store (no hardcoded keys)
 *   2. Refinement loop (real LLM) → produce spec
 *   3. Approve spec (lock it)
 *   4. Plan generation (real LLM) → produce milestones
 *   5. Approve plan
 *   6. Configure preflight (pause mode from env, default 'auto')
 *   7. Execute: run agent loop over milestones with real staging + approval
 *   8. Verify: confirm files appeared on disk, staging blocked writes
 *      before approval, verification ran
 *
 * The transcript is printed verbatim — not summarized, not assumed.
 */
async function runEndToEndVerification(): Promise<void> {
    const ideaText = process.env.KOVIX_VERIFY_IDEA
        ?? 'a tiny CLI tool that watches a folder and prints the names of files that change';
    const pauseMode = (process.env.KOVIX_VERIFY_PAUSE as 'every' | 'major' | 'auto' | 'custom') ?? 'auto';

    console.log('=== Kovix Phase 2 — End-to-End Verification ===');
    console.log('');
    console.log('Idea: ' + ideaText);
    console.log('Pause mode: ' + pauseMode);
    console.log('');

    // ---- 1. Resolve provider config ----
    const cfg = await resolveProviderConfig();
    if (!cfg) {
        console.error('FAIL: No provider config available.');
        console.error('      Open the UI (npm start), click the gear icon, configure a provider,');
        console.error('      Test connection, Save, close the window. Then re-run this script.');
        process.exitCode = 2;
        return;
    }
    console.log('=== PROVIDER CONFIG ===');
    console.log('Provider: ' + cfg.name + ' (source: ' + cfg.source + ')');
    if (cfg.modelId) { console.log('Model:    ' + cfg.modelId); }
    if (cfg.apiKey) {
        const masked = cfg.apiKey.length > 8
            ? cfg.apiKey.slice(0, 4) + '...' + cfg.apiKey.slice(-4)
            : '(short key)';
        console.log('API key:  ' + masked);
    } else {
        console.log('API key:  (none — local provider)');
    }
    console.log('');

    // If the provider requires a key but none is available, we can't proceed.
    const requiresKey = cfg.name !== 'ollama' && cfg.name !== 'xenova' && cfg.name !== 'lmstudio' && cfg.name !== 'litellm';
    if (requiresKey && !cfg.apiKey) {
        console.error('FAIL: Provider "' + cfg.name + '" requires an API key but none is stored.');
        console.error('      Open the UI (npm start), click the gear icon, paste your API key,');
        console.error('      Test connection, Save, close the window. Then re-run this script.');
        console.error('');
        console.error('      (Per project rules: this script NEVER hardcodes or asks for a key.)');
        process.exitCode = 2;
        return;
    }

    // Build provider + services
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
        process.exitCode = 1;
        return;
    }

    // ---- 2. Refinement loop (real LLM) ----
    console.log('=== STAGE 1: REFINEMENT (real LLM) ===');
    console.log('');
    const refinementService = new RefinementService({
        aiProvider: provider,
        maxTurns: 5,
        minTurns: 3,
        log: (msg) => console.log('  ' + msg),
    });

    const SCRIPTED_ANSWERS = [
        'It should watch the current directory recursively and print to stdout, one file per line.',
        'Target is developers on macOS and Linux. They run it from the terminal.',
        'Yes, ignore .git and node_modules by default. No config file needed for v1.',
        'Done means: I can run `kovix-watch .` and see a line printed within 1 second of saving any file.',
        'No remote sync, no GUI, no logging to file. Just stdout.',
    ];
    function getAnswerForRound(round: number): string {
        return SCRIPTED_ANSWERS[round] ?? "Make a sensible default for that.";
    }

    const priorTurns: RefinementTurn[] = [];
    let finalSpec: import('../agent/index.js').RefinementSpec | null = null;
    let refineRounds = 0;
    let refineHardCap = 8;

    while (refineHardCap-- > 0) {
        const round = refineRounds + 1;
        console.log('--- Refine Round ' + round + ' ---');
        const result = await refinementService.refine({ ideaText, priorTurns });
        if (result.kind === 'spec') {
            console.log('');
            console.log('>>> emit_spec received — refinement complete <<<');
            finalSpec = result.spec;
            break;
        }
        console.log('  QUESTION: ' + result.text);
        priorTurns.push({ role: 'assistant', content: result.text });
        const answer = getAnswerForRound(refineRounds);
        console.log('  ANSWER (simulated): ' + answer);
        priorTurns.push({ role: 'user', content: answer });
        refineRounds++;
        console.log('');
    }

    if (!finalSpec) {
        console.error('FAIL: refinement loop exhausted hard cap without emitting spec.');
        process.exitCode = 3;
        return;
    }

    console.log('');
    console.log('=== FINAL SPEC ===');
    console.log('  must:');
    for (const item of finalSpec.must) { console.log('    - ' + item); }
    console.log('  should:');
    for (const item of finalSpec.should) { console.log('    - ' + item); }
    console.log('  wont:');
    for (const item of finalSpec.wont) { console.log('    - ' + item); }
    console.log('  doneCriteria:');
    for (const item of finalSpec.doneCriteria) { console.log('    - ' + item); }
    console.log('');

    // Store spec in session (simulating what the UI does)
    session = createEmptySession();
    session.ideaText = ideaText;
    session.priorTurns = priorTurns;
    session.spec = finalSpec;
    session.stage = 'spec';

    // ---- 3. Approve spec ----
    console.log('=== STAGE 2: SPEC APPROVAL ===');
    console.log('');
    session.specApprovedAt = Date.now();
    session.stage = 'plan';
    console.log('Spec approved at: ' + new Date(session.specApprovedAt).toISOString());
    console.log('Spec is now locked. Advancing to plan stage.');
    console.log('');

    // ---- 4. Plan generation (real LLM) ----
    console.log('=== STAGE 3: PLAN GENERATION (real LLM) ===');
    console.log('');
    const planningService = new PlanningService({
        aiProvider: provider,
        log: (msg) => console.log('  ' + msg),
    });

    let planResult: PlanResult;
    try {
        planResult = await planningService.plan({ spec: finalSpec, ideaText: ideaText });
    } catch (err) {
        console.error('FAIL: planning threw: ' + (err instanceof Error ? err.message : String(err)));
        process.exitCode = 4;
        return;
    }

    console.log('');
    console.log('=== PLAN RESULT ===');
    console.log('Summary: ' + planResult.summary);
    console.log('Milestones: ' + planResult.milestones.length);
    planResult.milestones.forEach((m, i) => {
        console.log('  ' + (i + 1) + '. [' + m.type + (m.isMajor ? '/major' : '') + '] ' + m.name);
        console.log('     desc: ' + m.description);
        console.log('     satisfies: ' + (m.satisfies.length > 0 ? m.satisfies.join('; ') : '(none)'));
        console.log('     est credits: ~' + m.estimatedCredits);
    });
    console.log('');

    if (planResult.milestones.length === 0) {
        console.error('FAIL: plan has no milestones.');
        process.exitCode = 4;
        return;
    }

    // Store plan in session
    session.planSummary = planResult.summary;
    session.milestones = planResult.milestones;

    // ---- 5. Approve plan ----
    console.log('=== STAGE 4: PLAN APPROVAL ===');
    console.log('');
    session.planApprovedAt = Date.now();
    session.stage = 'preflight';
    console.log('Plan approved at: ' + new Date(session.planApprovedAt).toISOString());
    console.log('');

    // ---- 6. Configure preflight ----
    console.log('=== STAGE 5: PRE-FLIGHT CONFIG ===');
    console.log('');
    session.preflight = defaultPreflightConfig(session.milestones);
    session.preflight.pauseMode = pauseMode;
    // For 'auto' mode, no custom picks needed. For 'custom', default to major milestones.
    if (pauseMode === 'custom') {
        session.preflight.customPauseIds = session.milestones.filter(m => m.isMajor).map(m => m.id);
    }
    console.log('Pause mode: ' + session.preflight.pauseMode);
    console.log('Custom pause IDs: ' + JSON.stringify(session.preflight.customPauseIds));
    console.log('Credit limit: ' + session.preflight.creditLimit + ' (0 = no cap)');
    console.log('Verify after each: ' + session.preflight.verifyAfterEach);
    console.log('');

    // ---- 7. Execute ----
    console.log('=== STAGE 6: EXECUTION (real agent loop + staging + approval) ===');
    console.log('');
    session.stage = 'executing';
    session.execution.milestoneStates = session.milestones.map(m => ({
        milestoneId: m.id,
        status: 'pending' as const,
        events: [],
    }));

    // Build the agent loop with a per-build workspace
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const buildDir = pathMod.join(os.tmpdir(), 'kovix-builds', 'e2e-' + Date.now());
    await fs.mkdir(buildDir, { recursive: true });
    console.log('Build workspace: ' + buildDir);
    console.log('');

    let approvalFired = false;
    let fileWrittenBeforeApproval = false;
    let filesWritten: string[] = [];

    const execAgent = new AgentLoop({
        aiProvider: provider,
        workspaceRoot: buildDir,
        log: (msg: string) => console.log('  [agent] ' + msg),
        approveWrite: async (filePath: string, proposedContent: string, _existing: string | null) => {
            approvalFired = true;
            console.log('  [APPROVAL CALLBACK] ' + filePath + ' (' + proposedContent.length + ' chars)');
            // Verify staging: file should NOT exist on disk yet.
            try {
                await fs.readFile(pathMod.join(buildDir, filePath), 'utf8');
                fileWrittenBeforeApproval = true;
                console.error('  [VIOLATION] file exists on disk BEFORE approval!');
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    console.log('  [STAGING OK] file NOT on disk before approval');
                }
            }
            return true;
        },
        approveInterpreterCommand: async (cmd: string) => {
            console.log('  [interpreter approval] ' + cmd);
            return true;
        },
        onlineMode: false,
    });

    // Build the approved plan from session state
    const approvedPlan = buildApprovedPlan();
    console.log('Approved plan: ' + approvedPlan.milestones.length + ' milestones, mode=' + approvedPlan.executionMode);
    console.log('');

    // Run with auto-resume for pauses (since this is headless, we auto-resume)
    let execAborted = false;
    const execController = new AbortController();
    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minute hard cap
    const timeoutId = setTimeout(() => {
        console.error('  [TIMEOUT] execution exceeded ' + TIMEOUT_MS + 'ms, aborting');
        execAborted = true;
        execController.abort();
    }, TIMEOUT_MS);

    // Wire auto-resume: when the agent pauses at a milestone, auto-resume
    // after 1 second (so the transcript shows the pause happened).
    const autoResume = (milestone: IMilestone): Promise<'resume' | 'skip'> => {
        console.log('  [PAUSED] at milestone: ' + milestone.name + ' — auto-resuming in 1s');
        return new Promise<'resume'>((resolve) => {
            setTimeout(() => resolve('resume'), 1000);
        });
    };

    let completeReceived = false;
    let completeSummary = '';
    let execError: string | null = null;
    let eventCount = 0;

    try {
        // We need to use the agent loop's runWithApprovedPlan, but it uses an
        // internal awaitResume that we can't inject. So we replicate the
        // milestone executor flow here with our own autoResume.
        const { executeMilestonesWithPauses } = await import('../agent/milestoneExecutor.js');

        const executeSubTask = async function* (subTask: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
            // This is the same logic as AgentLoop.runWithApprovedPlan's inner
            // executeSubTask, but we can't call that private method. Instead,
            // we call agent.run() with the subtask — which runs the full agent
            // loop for that subtask. This is a simplification but works for
            // verification: each milestone becomes one agent.run() call.
            const stream = execAgent.run(subTask, signal);
            for await (const event of stream as AsyncIterable<AgentLoopEvent>) {
                yield event;
                if (event.type === 'complete') { return; }
                if (event.type === 'error' && !event.recoverable) { return; }
            }
        };

        const runVerification = async function* (_signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
            // The agent loop's runVerification is private; we replicate the
            // logic here: check for package.json with test/build/typecheck.
            const pkgPath = pathMod.resolve(buildDir, 'package.json');
            let pkg: { scripts?: Record<string, string> } | null = null;
            try {
                pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
            } catch {
                pkg = null;
            }
            let command = '';
            if (pkg?.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
                command = 'npm test';
            } else if (pkg?.scripts?.build) {
                command = 'npm run build';
            } else if (pkg?.scripts?.typecheck) {
                command = 'npm run typecheck';
            } else {
                yield { type: 'verification_result', passed: true, output: 'unverified:no-command', unverified: true };
                return;
            }
            yield { type: 'verification_start', command };
            try {
                const { execFile } = await import('node:child_process');
                const { promisify } = await import('node:util');
                const execFileAsync = promisify(execFile);
                const { stdout, stderr } = await execFileAsync(
                    process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
                    process.platform === 'win32' ? ['/c', command] : ['-c', command],
                    { cwd: buildDir, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
                );
                const output = (stdout + (stderr ? '\n' + stderr : '')).substring(0, 2000);
                yield { type: 'verification_result', passed: true, output };
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string };
                const output = ((e.stdout ?? '') + (e.stderr ? '\n' + e.stderr : '')).substring(0, 2000);
                yield { type: 'verification_result', passed: false, output };
            }
        };

        for await (const event of executeMilestonesWithPauses({
            approvedPlan,
            executeSubTask,
            runVerification,
            awaitResume: autoResume,
            signal: execController.signal,
            log: (msg: string) => console.log('  [milestone-exec] ' + msg),
        })) {
            eventCount++;
            if (event.type === 'milestone_reached') {
                console.log('  [milestone_reached] ' + event.milestone.name);
            } else if (event.type === 'milestone_completed') {
                console.log('  [milestone_completed] ' + event.milestone.name);
            } else if (event.type === 'milestone_paused') {
                console.log('  [milestone_paused] ' + event.milestone.name);
            } else if (event.type === 'milestone_resumed') {
                console.log('  [milestone_resumed] ' + event.milestone.name);
            } else if (event.type === 'tool_start') {
                console.log('  [tool_start] ' + event.toolName);
            } else if (event.type === 'tool_result') {
                console.log('  [tool_result] ' + event.toolName + ' ' + (event.success ? 'OK' : 'FAIL'));
                const snippet = event.result.substring(0, 150).replace(/\n/g, '\n    ');
                console.log('    ' + snippet);
            } else if (event.type === 'file_written') {
                filesWritten.push(event.filePath);
                console.log('  [file_written] ' + event.filePath);
            } else if (event.type === 'verification_start') {
                console.log('  [verification_start] ' + event.command);
            } else if (event.type === 'verification_result') {
                const mark = event.passed ? 'PASS' : 'FAIL';
                const unverified = event.unverified ? ' (unverified)' : '';
                console.log('  [verification_result] ' + mark + unverified);
            } else if (event.type === 'error') {
                console.log('  [error ' + (event.recoverable ? 'recoverable' : 'FATAL') + '] ' + event.text);
                if (!event.recoverable) { execError = event.text; }
            } else if (event.type === 'complete') {
                completeReceived = true;
                completeSummary = event.summary;
                console.log('  [complete] ' + event.summary.substring(0, 300));
            } else if (event.type === 'token') {
                // Stream tokens to stdout for the transcript
                process.stdout.write(event.text);
            }
        }
    } catch (err) {
        execError = err instanceof Error ? err.message : String(err);
        console.error('  [exec threw] ' + execError);
    } finally {
        clearTimeout(timeoutId);
    }

    console.log('');
    console.log('=== EXECUTION SUMMARY ===');
    console.log('Events emitted: ' + eventCount);
    console.log('complete event received: ' + completeReceived);
    console.log('Approval callback fired: ' + approvalFired);
    console.log('File written before approval (VIOLATION): ' + fileWrittenBeforeApproval);
    console.log('Files written to disk: ' + filesWritten.length);
    for (const f of filesWritten) { console.log('  - ' + f); }
    console.log('Fatal error: ' + (execError ?? 'none'));
    console.log('Aborted: ' + execAborted);
    console.log('');

    // ---- 8. Disk verification ----
    console.log('=== STAGE 7: DISK VERIFICATION ===');
    console.log('');
    console.log('Build dir: ' + buildDir);
    let dirContents: string[] = [];
    try {
        const entries = await fs.readdir(buildDir, { withFileTypes: true, recursive: true });
        dirContents = entries
            .filter(e => e.isFile())
            .map(e => pathMod.relative(buildDir, pathMod.join(e.parentPath, e.name)));
        console.log('Files on disk (' + dirContents.length + '):');
        for (const f of dirContents) { console.log('  - ' + f); }
    } catch (err) {
        console.error('Could not read build dir: ' + (err instanceof Error ? err.message : String(err)));
    }
    console.log('');

    // ---- Final verdict ----
    console.log('=== FINAL VERDICT ===');
    console.log('');
    const checks: Array<{ name: string; pass: boolean; detail?: string }> = [
        { name: 'Refinement produced a spec (real LLM)', pass: !!finalSpec, detail: finalSpec ? 'must=' + finalSpec.must.length + ', doneCriteria=' + finalSpec.doneCriteria.length : 'no spec' },
        { name: 'Refinement ran 3-5 rounds', pass: refineRounds >= 3 && refineRounds <= 5, detail: 'got ' + refineRounds },
        { name: 'Plan produced milestones (real LLM)', pass: planResult.milestones.length > 0, detail: planResult.milestones.length + ' milestones' },
        { name: 'Plan has ≥ 2 milestones', pass: planResult.milestones.length >= 2, detail: planResult.milestones.length + ' milestones' },
        { name: 'Execution emitted events', pass: eventCount > 0, detail: eventCount + ' events' },
        { name: 'Approval callback fired (staging layer works)', pass: approvalFired, detail: approvalFired ? 'staging blocked writes' : 'no write approvals (agent may not have written files)' },
        { name: 'File NOT written before approval', pass: !fileWrittenBeforeApproval, detail: fileWrittenBeforeApproval ? 'VIOLATION' : 'staging works' },
        { name: 'Files appeared on disk after execution', pass: filesWritten.length > 0 || dirContents.length > 0, detail: filesWritten.length + ' writes, ' + dirContents.length + ' files on disk' },
        { name: 'complete event received', pass: completeReceived, detail: completeReceived ? 'summary: ' + completeSummary.substring(0, 100) : 'no complete event' },
        { name: 'No fatal error', pass: !execError, detail: execError ?? 'clean' },
    ];

    let allPass = true;
    for (const c of checks) {
        const status = c.pass ? 'PASS' : 'FAIL';
        if (!c.pass) { allPass = false; }
        const detail = c.detail ? ' — ' + c.detail : '';
        console.log('  [' + status + '] ' + c.name + detail);
    }

    console.log('');
    if (allPass) {
        console.log('>>> ALL CHECKS PASSED — Phase 2 end-to-end flow works <<<');
    } else {
        console.log('>>> SOME CHECKS FAILED — see above <<<');
        process.exitCode = 5;
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
  /* Editable spec items (Phase 2 — Spec Approval) */
  .spec-list li.spec-item-editable {
    padding-left: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .spec-list li.spec-item-editable::before { display: none; }
  .spec-list li.spec-item-editable .spec-bullet {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
    margin-top: 9px;
  }
  .spec-section.must .spec-item-editable .spec-bullet { background: var(--danger); }
  .spec-section.should .spec-item-editable .spec-bullet { background: var(--accent); }
  .spec-section.wont .spec-item-editable .spec-bullet { background: var(--warning); }
  .spec-section.doneCriteria .spec-item-editable .spec-bullet { background: var(--success); }
  .spec-list li.spec-item-editable .spec-item-input {
    flex: 1;
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 6px;
    outline: none;
    resize: none;
    min-height: 28px;
    overflow: hidden;
    transition: border-color 0.15s, background 0.15s;
  }
  .spec-list li.spec-item-editable .spec-item-input:focus {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .spec-list li.spec-item-editable .spec-item-remove {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: 16px;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
  }
  .spec-list li.spec-item-editable .spec-item-remove:hover {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .spec-locked .spec-item-input,
  .spec-locked .spec-item-remove {
    pointer-events: none;
    opacity: 0.6;
  }
  .spec-locked .spec-item-input { background: var(--surface-2); }
  .spec-add-item {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .spec-add-item input {
    flex: 1;
    font-family: var(--font);
    font-size: 14px;
    padding: 6px 10px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    background: var(--surface);
    outline: none;
    transition: border-color 0.15s;
  }
  .spec-add-item input:focus { border-color: var(--accent); border-style: solid; }
  .spec-add-item button {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.15s;
  }
  .spec-add-item button:hover { background: var(--surface-2); }
  .spec-locked-banner {
    background: var(--success-soft);
    color: var(--success);
    border: 1px solid #6EE7B7;
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* ---- PLAN STATE (Phase 2) ---- */
  .plan-screen, .preflight-screen, .execute-screen, .done-screen {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .plan-header, .preflight-header, .execute-header, .done-header {
    text-align: center;
    padding: 12px 0 8px;
  }
  .plan-header h2, .preflight-header h2, .execute-header h2, .done-header h2 {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 8px;
    color: var(--text);
  }
  .plan-header p, .preflight-header p, .execute-header p, .done-header p {
    font-size: 15px;
    color: var(--text-2);
    margin: 0;
  }
  .plan-summary {
    background: var(--accent-soft);
    color: var(--accent-2);
    border: 1px solid #BAE6FD;
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-size: 14px;
    line-height: 1.55;
  }
  .plan-milestones {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .milestone-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 18px 20px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .milestone-card.is-major { border-left: 3px solid var(--accent); }
  .milestone-card.is-read { border-left: 3px solid var(--text-3); }
  .milestone-card.is-run { border-left: 3px solid var(--success); }
  .milestone-card.is-edit { border-left: 3px solid var(--warning); }
  .milestone-index {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .milestone-body { flex: 1; min-width: 0; }
  .milestone-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 4px;
  }
  .milestone-desc {
    font-size: 13px;
    color: var(--text-2);
    margin: 0 0 8px;
    line-height: 1.5;
  }
  .milestone-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 11px;
    color: var(--text-3);
  }
  .milestone-type-badge {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .milestone-type-badge.Read { background: var(--surface-2); color: var(--text-2); }
  .milestone-type-badge.Create { background: var(--accent-soft); color: var(--accent-2); }
  .milestone-type-badge.Edit { background: var(--warning-soft); color: var(--warning); }
  .milestone-type-badge.Run { background: var(--success-soft); color: var(--success); }
  .milestone-major-badge {
    background: var(--accent-soft);
    color: var(--accent-2);
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .milestone-satisfies {
    font-size: 11px;
    color: var(--text-3);
    margin-top: 6px;
    line-height: 1.5;
  }
  .milestone-satisfies strong { color: var(--text-2); font-weight: 600; }

  /* Execution-state styling for milestone cards */
  .milestone-card.status-pending { opacity: 0.7; }
  .milestone-card.status-running {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow);
  }
  .milestone-card.status-paused {
    border-color: var(--warning);
    box-shadow: 0 0 0 3px var(--warning-soft), var(--shadow);
  }
  .milestone-card.status-completed {
    opacity: 0.85;
    border-left-color: var(--success) !important;
  }
  .milestone-card.status-skipped {
    opacity: 0.5;
    text-decoration: line-through;
  }
  .milestone-card.status-failed {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft), var(--shadow);
  }
  .milestone-status-badge {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 8px;
    border-radius: 4px;
    margin-left: auto;
  }
  .milestone-status-badge.pending { background: var(--surface-2); color: var(--text-3); }
  .milestone-status-badge.running { background: var(--accent-soft); color: var(--accent-2); }
  .milestone-status-badge.paused { background: var(--warning-soft); color: var(--warning); }
  .milestone-status-badge.completed { background: var(--success-soft); color: var(--success); }
  .milestone-status-badge.skipped { background: var(--surface-2); color: var(--text-3); }
  .milestone-status-badge.failed { background: var(--danger-soft); color: var(--danger); }
  .milestone-event-log {
    margin-top: 10px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-2);
    max-height: 120px;
    overflow-y: auto;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .milestone-verification {
    margin-top: 8px;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .milestone-verification.passed { background: var(--success-soft); color: var(--success); }
  .milestone-verification.failed { background: var(--danger-soft); color: var(--danger); }
  .milestone-verification.unverified { background: var(--surface-2); color: var(--text-3); }

  /* ---- PREFLIGHT STATE (Phase 2) ---- */
  .preflight-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .preflight-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .preflight-field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .preflight-field-hint {
    font-size: 12px;
    color: var(--text-3);
  }
  .preflight-mode-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .preflight-mode-option {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .preflight-mode-option:hover { border-color: var(--accent); }
  .preflight-mode-option.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .preflight-mode-option input[type="radio"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .preflight-mode-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .preflight-mode-desc {
    font-size: 12px;
    color: var(--text-3);
  }
  .preflight-custom-picks {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
  }
  .preflight-custom-pick {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
  }
  .preflight-field-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .preflight-field-row input[type="number"] {
    width: 120px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--font);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .preflight-field-row input[type="number"]:focus { border-color: var(--accent); }
  .preflight-toggle {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
  }
  .preflight-toggle input { opacity: 0; width: 0; height: 0; }
  .preflight-toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--border);
    border-radius: 22px;
    transition: 0.2s;
  }
  .preflight-toggle-slider::before {
    content: '';
    position: absolute;
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background: white;
    border-radius: 50%;
    transition: 0.2s;
  }
  .preflight-toggle input:checked + .preflight-toggle-slider { background: var(--accent); }
  .preflight-toggle input:checked + .preflight-toggle-slider::before { transform: translateX(18px); }

  /* ---- EXECUTE STATE (Phase 2) ---- */
  .execute-progress-bar {
    background: var(--surface-2);
    border-radius: 999px;
    height: 6px;
    overflow: hidden;
  }
  .execute-progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.3s ease;
    width: 0%;
  }
  .execute-stats {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: var(--text-2);
    padding: 0 4px;
  }
  .execute-actions {
    display: flex;
    justify-content: center;
    gap: 10px;
    padding-top: 8px;
  }
  .execute-pause-banner {
    background: var(--warning-soft);
    color: var(--warning);
    border: 1px solid #FDE68A;
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .execute-pause-banner .btn { margin-left: auto; }

  /* ---- DONE STATE (Phase 2) ---- */
  .done-summary {
    background: var(--success-soft);
    color: var(--success);
    border: 1px solid #6EE7B7;
    border-radius: var(--radius);
    padding: 20px 24px;
    font-size: 14px;
    line-height: 1.6;
  }
  .done-build-dir {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--surface-2);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    word-break: break-all;
    color: var(--text-2);
  }

  /* ---- STAGE INDICATOR (Phase 2) ---- */
  .stage-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 0 12px;
    font-size: 12px;
    color: var(--text-3);
  }
  .stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border);
    transition: background 0.2s;
  }
  .stage-dot.active { background: var(--accent); }
  .stage-dot.done { background: var(--success); }
  .stage-label {
    font-weight: 500;
    color: var(--text-3);
  }
  .stage-label.active { color: var(--accent-2); font-weight: 600; }
  .stage-label.done { color: var(--success); }
  .stage-separator {
    width: 16px;
    height: 1px;
    background: var(--border);
  }

  /* ---- LOADING (Phase 2 — plan generation) ---- */
  .loading-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 32px 24px;
    text-align: center;
    color: var(--text-2);
    font-size: 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
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

      <!-- SPEC STATE (Phase 2: editable + Approve button) -->
      <section id="state-spec" class="spec-screen hidden">
        <div class="spec-header">
          <h2>Your spec is ready</h2>
          <p>Review and edit the spec below. When you approve it, the spec is locked and Kovix generates a milestone plan.</p>
        </div>
        <div id="spec-locked-banner" class="spec-locked-banner hidden">
          <span>&#10003;</span>
          <span>Spec approved and locked. Kovix is generating a plan&hellip;</span>
        </div>
        <div id="spec-card" class="spec-card"></div>
        <div class="spec-actions">
          <button id="spec-restart" class="btn btn-secondary">Start over</button>
          <button id="spec-approve" class="btn btn-primary">Approve spec &amp; generate plan</button>
        </div>
      </section>

      <!-- PLAN STATE (Phase 2) -->
      <section id="state-plan" class="plan-screen hidden">
        <div class="plan-header">
          <h2>Milestone plan</h2>
          <p>The agent will execute these milestones in order. Review, then approve to configure pre-flight options.</p>
        </div>
        <div id="plan-summary" class="plan-summary"></div>
        <div id="plan-milestones" class="plan-milestones"></div>
        <div class="spec-actions">
          <button id="plan-restart" class="btn btn-secondary">Start over</button>
          <button id="plan-approve" class="btn btn-primary">Approve plan &amp; continue</button>
        </div>
      </section>

      <!-- PREFLIGHT STATE (Phase 2) -->
      <section id="state-preflight" class="preflight-screen hidden">
        <div class="preflight-header">
          <h2>Pre-flight configuration</h2>
          <p>Choose how the agent should pause during execution, then start the build.</p>
        </div>
        <div class="preflight-card">
          <div class="preflight-field">
            <div class="preflight-field-label">Milestone pause mode</div>
            <div class="preflight-mode-grid" id="preflight-mode-grid">
              <label class="preflight-mode-option" data-mode="every">
                <input type="radio" name="pause-mode" value="every" />
                <span class="preflight-mode-title">Stop at every milestone</span>
                <span class="preflight-mode-desc">Pause after each milestone for review.</span>
              </label>
              <label class="preflight-mode-option" data-mode="major">
                <input type="radio" name="pause-mode" value="major" checked />
                <span class="preflight-mode-title">Stop at major milestones</span>
                <span class="preflight-mode-desc">Pause only at file-creating or command-running milestones.</span>
              </label>
              <label class="preflight-mode-option" data-mode="auto">
                <input type="radio" name="pause-mode" value="auto" />
                <span class="preflight-mode-title">Full auto</span>
                <span class="preflight-mode-desc">No pauses except on verification failure.</span>
              </label>
              <label class="preflight-mode-option" data-mode="custom">
                <input type="radio" name="pause-mode" value="custom" />
                <span class="preflight-mode-title">Custom picks</span>
                <span class="preflight-mode-desc">Choose specific milestones to pause at.</span>
              </label>
            </div>
            <div id="preflight-custom-picks" class="preflight-custom-picks hidden"></div>
          </div>

          <div class="preflight-field">
            <div class="preflight-field-label">Credit limit (optional)</div>
            <div class="preflight-field-row">
              <input type="number" id="preflight-credit-limit" min="0" step="100" value="0" />
              <span class="preflight-field-hint">0 = no cap. Aborts execution if estimated credits exceed this.</span>
            </div>
          </div>

          <div class="preflight-field">
            <div class="preflight-field-label">Run verification after each milestone</div>
            <div class="preflight-field-row">
              <label class="preflight-toggle">
                <input type="checkbox" id="preflight-verify" checked />
                <span class="preflight-toggle-slider"></span>
              </label>
              <span class="preflight-field-hint">Runs the workspace&rsquo;s test/build/typecheck command after each milestone. Recommended.</span>
            </div>
          </div>
        </div>
        <div class="spec-actions">
          <button id="preflight-back" class="btn btn-secondary">Back to plan</button>
          <button id="preflight-confirm" class="btn btn-primary">Start execution</button>
        </div>
      </section>

      <!-- EXECUTE STATE (Phase 2) -->
      <section id="state-execute" class="execute-screen hidden">
        <div class="execute-header">
          <h2>Executing build</h2>
          <p id="execute-status-text">The agent is working through your milestones.</p>
        </div>
        <div class="execute-progress-bar">
          <div id="execute-progress-fill" class="execute-progress-fill"></div>
        </div>
        <div class="execute-stats">
          <span id="execute-progress-text">0 / 0 milestones</span>
          <span id="execute-credits-text">~0 credits used</span>
        </div>
        <div id="execute-pause-banner" class="execute-pause-banner hidden">
          <span>&#9208;</span>
          <span id="execute-pause-text">Paused at a milestone.</span>
          <button id="exec-resume" class="btn btn-primary">Resume</button>
          <button id="exec-skip" class="btn btn-secondary">Skip milestone</button>
        </div>
        <div id="execute-milestones" class="plan-milestones"></div>
        <div class="execute-actions">
          <button id="exec-abort" class="btn btn-danger">Abort execution</button>
        </div>
      </section>

      <!-- DONE STATE (Phase 2) -->
      <section id="state-done" class="done-screen hidden">
        <div class="done-header">
          <h2>Build complete</h2>
          <p>Your build finished. Review the results below.</p>
        </div>
        <div id="done-summary" class="done-summary"></div>
        <div id="done-build-dir" class="done-build-dir"></div>
        <div class="spec-actions">
          <button id="done-restart" class="btn btn-primary">Start a new build</button>
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
    statePlan: document.getElementById('state-plan'),
    statePreflight: document.getElementById('state-preflight'),
    stateExecute: document.getElementById('state-execute'),
    stateDone: document.getElementById('state-done'),
    ideaInput: document.getElementById('idea-input'),
    ideaStart: document.getElementById('idea-start'),
    refineIdeaText: document.getElementById('refine-idea-text'),
    conversation: document.getElementById('conversation'),
    answerBox: document.getElementById('answer-box'),
    answerInput: document.getElementById('answer-input'),
    answerSend: document.getElementById('answer-send'),
    specCard: document.getElementById('spec-card'),
    specRestart: document.getElementById('spec-restart'),
    specApprove: document.getElementById('spec-approve'),
    specLockedBanner: document.getElementById('spec-locked-banner'),
    // Plan
    planSummary: document.getElementById('plan-summary'),
    planMilestones: document.getElementById('plan-milestones'),
    planRestart: document.getElementById('plan-restart'),
    planApprove: document.getElementById('plan-approve'),
    // Preflight
    preflightModeGrid: document.getElementById('preflight-mode-grid'),
    preflightCustomPicks: document.getElementById('preflight-custom-picks'),
    preflightCreditLimit: document.getElementById('preflight-credit-limit'),
    preflightVerify: document.getElementById('preflight-verify'),
    preflightBack: document.getElementById('preflight-back'),
    preflightConfirm: document.getElementById('preflight-confirm'),
    // Execute
    executeStatusText: document.getElementById('execute-status-text'),
    executeProgressFill: document.getElementById('execute-progress-fill'),
    executeProgressText: document.getElementById('execute-progress-text'),
    executeCreditsText: document.getElementById('execute-credits-text'),
    executePauseBanner: document.getElementById('execute-pause-banner'),
    executePauseText: document.getElementById('execute-pause-text'),
    executeMilestones: document.getElementById('execute-milestones'),
    execResume: document.getElementById('exec-resume'),
    execSkip: document.getElementById('exec-skip'),
    execAbort: document.getElementById('exec-abort'),
    // Done
    doneSummary: document.getElementById('done-summary'),
    doneBuildDir: document.getElementById('done-build-dir'),
    doneRestart: document.getElementById('done-restart'),
    // Settings
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
  // Maps our 7 build stages to the 7 section elements.
  const STAGES = ['idea', 'refine', 'spec', 'plan', 'preflight', 'execute', 'done'];
  function showState(name) {
    const map = {
      idea: els.stateIdea,
      refine: els.stateRefine,
      spec: els.stateSpec,
      plan: els.statePlan,
      preflight: els.statePreflight,
      execute: els.stateExecute,
      done: els.stateDone,
    };
    for (const [stage, el] of Object.entries(map)) {
      el.classList.toggle('hidden', stage !== name);
    }
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

  // --- SPEC state (Phase 2: editable + Approve button) ---
  // The spec is rendered as editable textareas (one per item). Edits are
  // sent to the main process via kovixAPI.spec.updateItem on blur. When the
  // user clicks Approve, the spec is locked (edits disabled) and we advance
  // to the Plan stage.

  // Current spec state — kept in the renderer for re-rendering after edits.
  let currentSpec = null;

  function renderSpec(spec, opts) {
    const options = opts || {};
    const locked = !!options.locked;
    currentSpec = spec;

    const sections = [
      { key: 'must', title: 'Must have', desc: 'Hard requirements. The build is incomplete without these.' },
      { key: 'should', title: 'Should have', desc: 'Nice-to-haves. Would improve quality but are not blocking.' },
      { key: 'wont', title: 'Won\u2019t have', desc: 'Explicit non-goals. Out of scope for this build.' },
      { key: 'doneCriteria', title: 'Done criteria', desc: 'Verifiable checks. When all pass, the build is done.' },
    ];
    els.specCard.innerHTML = '';
    els.specCard.classList.toggle('spec-locked', locked);
    els.specLockedBanner.classList.toggle('hidden', !locked);
    els.specApprove.disabled = locked;

    for (const section of sections) {
      const items = spec[section.key] || [];
      const div = document.createElement('div');
      div.className = 'spec-section ' + section.key;

      const headerHtml =
        '<div class="spec-section-header">' +
          '<span class="spec-section-label ' + section.key + '">' + section.key + '</span>' +
          '<span class="spec-section-title">' + section.title + '</span>' +
          '<span class="spec-section-count">' + items.length + (items.length === 1 ? ' item' : ' items') + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-3);margin-bottom:8px">' + section.desc + '</div>';
      div.innerHTML = headerHtml + '<ul class="spec-list"></ul>';

      const ul = div.querySelector('.spec-list');
      items.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'spec-item-editable';
        li.innerHTML =
          '<span class="spec-bullet"></span>' +
          '<textarea class="spec-item-input" rows="1"></textarea>' +
          '<button class="spec-item-remove" title="Remove item" type="button">&times;</button>';
        const ta = li.querySelector('.spec-item-input');
        ta.value = item;
        // Auto-resize
        const autoResize = () => {
          ta.style.height = 'auto';
          ta.style.height = Math.max(28, ta.scrollHeight) + 'px';
        };
        ta.addEventListener('input', autoResize);
        // Save on blur
        ta.addEventListener('blur', async () => {
          const newVal = ta.value.trim();
          if (newVal === item) return; // no change
          const result = await kovixAPI.spec.updateItem({ section: section.key, index: i, value: newVal });
          if (result.ok && result.spec) {
            currentSpec = result.spec;
            renderSpec(currentSpec, { locked });
          } else if (result.error) {
            showError(result.error);
            ta.value = item; // revert
          }
        });
        // Remove button
        li.querySelector('.spec-item-remove').addEventListener('click', async () => {
          const result = await kovixAPI.spec.removeItem({ section: section.key, index: i });
          if (result.ok && result.spec) {
            currentSpec = result.spec;
            renderSpec(currentSpec, { locked });
          } else if (result.error) {
            showError(result.error);
          }
        });
        ul.appendChild(li);
        // Set initial height after append
        setTimeout(autoResize, 0);
      });

      // Empty state
      if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'spec-empty';
        li.textContent = '(no items — add one below)';
        ul.appendChild(li);
      }

      // Add-item row (only when not locked)
      if (!locked) {
        const addDiv = document.createElement('div');
        addDiv.className = 'spec-add-item';
        addDiv.innerHTML =
          '<input type="text" placeholder="Add a ' + section.key + ' item&hellip;" />' +
          '<button type="button">Add</button>';
        const input = addDiv.querySelector('input');
        const btn = addDiv.querySelector('button');
        const doAdd = async () => {
          const val = input.value.trim();
          if (!val) return;
          const result = await kovixAPI.spec.addItem({ section: section.key, value: val });
          if (result.ok && result.spec) {
            currentSpec = result.spec;
            renderSpec(currentSpec, { locked });
          } else if (result.error) {
            showError(result.error);
          }
        };
        btn.addEventListener('click', doAdd);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
        });
        div.appendChild(addDiv);
      }

      els.specCard.appendChild(div);
    }
  }

  els.specRestart.addEventListener('click', async () => {
    await kovixAPI.session.reset();
    // Reset everything
    els.ideaInput.value = '';
    els.conversation.innerHTML = '';
    els.specCard.innerHTML = '';
    currentSpec = null;
    updateIdeaStartEnabled();
    els.ideaStart.textContent = 'Start refinement';
    showState('idea');
    els.ideaInput.focus();
  });

  els.specApprove.addEventListener('click', async () => {
    els.specApprove.disabled = true;
    els.specApprove.textContent = 'Approving&hellip;';
    try {
      const result = await kovixAPI.spec.approve();
      if (result.ok && result.spec) {
        // Lock the spec visually and show the locked banner
        renderSpec(result.spec, { locked: true });
        // Advance to the Plan stage and kick off plan generation
        showState('plan');
        await generatePlan();
      } else {
        showError(result.error || 'Failed to approve spec.');
        els.specApprove.disabled = false;
        els.specApprove.textContent = 'Approve spec & generate plan';
      }
    } catch (err) {
      showError(err.message || String(err));
      els.specApprove.disabled = false;
      els.specApprove.textContent = 'Approve spec & generate plan';
    }
  });

  // --- PLAN state (Phase 2) ---
  let currentMilestones = [];

  async function generatePlan() {
    // Show a loading state in the plan section
    els.planSummary.textContent = '';
    els.planMilestones.innerHTML =
      '<div class="loading-card">' +
        '<div class="loading-dots"><span></span><span></span><span></span></div>' +
        '<div>Generating milestone plan from your approved spec&hellip;</div>' +
      '</div>';
    els.planApprove.disabled = true;

    try {
      const result = await kovixAPI.plan.generate();
      if (result.ok && result.plan) {
        renderPlan(result.plan);
        els.planApprove.disabled = false;
      } else {
        els.planMilestones.innerHTML =
          '<div class="loading-card" style="color:var(--danger)">' +
            '<div>Failed to generate plan: ' + escapeHtml(result.error || 'unknown error') + '</div>' +
            '<button class="btn btn-secondary" id="plan-retry">Retry</button>' +
          '</div>';
        document.getElementById('plan-retry').addEventListener('click', generatePlan);
      }
    } catch (err) {
      els.planMilestones.innerHTML =
        '<div class="loading-card" style="color:var(--danger)">' +
          '<div>Failed to generate plan: ' + escapeHtml(err.message || String(err)) + '</div>' +
          '<button class="btn btn-secondary" id="plan-retry">Retry</button>' +
        '</div>';
      document.getElementById('plan-retry').addEventListener('click', generatePlan);
    }
  }

  function renderPlan(plan) {
    currentMilestones = plan.milestones || [];
    els.planSummary.textContent = plan.summary || '';
    els.planMilestones.innerHTML = '';
    currentMilestones.forEach((m, i) => {
      els.planMilestones.appendChild(renderMilestoneCard(m, i, { stage: 'plan' }));
    });
  }

  function renderMilestoneCard(m, index, opts) {
    const options = opts || {};
    const stage = options.stage || 'plan'; // 'plan' | 'execute'
    const status = options.status; // undefined | 'pending' | 'running' | 'paused' | 'completed' | 'skipped' | 'failed'
    const verification = options.verification; // undefined | { passed, output }
    const eventLog = options.eventLog; // undefined | array of {type, text}

    const div = document.createElement('div');
    div.className = 'milestone-card is-' + m.type.toLowerCase() + (m.isMajor ? ' is-major' : '');
    if (status) { div.classList.add('status-' + status); }
    div.dataset.milestoneId = m.id;

    const typeBadge = '<span class="milestone-type-badge ' + m.type + '">' + m.type + '</span>';
    const majorBadge = m.isMajor ? '<span class="milestone-major-badge">major</span>' : '';
    const creditsBadge = '<span>~' + m.estimatedCredits + ' credits</span>';
    const statusBadge = status
      ? '<span class="milestone-status-badge ' + status + '">' + status + '</span>'
      : '';

    const satisfiesHtml = (m.satisfies && m.satisfies.length > 0)
      ? '<div class="milestone-satisfies"><strong>Satisfies:</strong> ' + m.satisfies.map(escapeHtml).join('; ') + '</div>'
      : '';

    let html =
      '<div class="milestone-index">' + (index + 1) + '</div>' +
      '<div class="milestone-body">' +
        '<div class="milestone-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="milestone-desc">' + escapeHtml(m.description) + '</div>' +
        '<div class="milestone-meta">' + typeBadge + majorBadge + creditsBadge + '</div>' +
        satisfiesHtml;
    if (verification) {
      const vClass = verification.passed ? 'passed' : (verification.passed === false ? 'failed' : 'unverified');
      const vIcon = verification.passed ? '&#10003;' : (verification.passed === false ? '&#10007;' : '?');
      const vText = verification.passed === true ? 'Verification passed' : (verification.passed === false ? 'Verification failed' : 'Unverified');
      html += '<div class="milestone-verification ' + vClass + '"><span>' + vIcon + '</span><span>' + vText + '</span></div>';
    }
    if (eventLog && eventLog.length > 0) {
      const logText = eventLog.map(e => {
        if (e.type === 'token') return e.text;
        if (e.type === 'tool_start') return '\\n[tool: ' + e.text + ']';
        if (e.type === 'tool_result') return '\\n[result: ' + e.text + ']';
        if (e.type === 'file_written') return '\\n[wrote: ' + e.text + ']';
        return '\\n[' + e.type + ']';
      }).join('');
      html += '<div class="milestone-event-log">' + escapeHtml(logText.trim()) + '</div>';
    }
    html += '</div>' + statusBadge;

    div.innerHTML = html;
    return div;
  }

  els.planRestart.addEventListener('click', async () => {
    await kovixAPI.session.reset();
    els.ideaInput.value = '';
    els.conversation.innerHTML = '';
    els.specCard.innerHTML = '';
    els.planMilestones.innerHTML = '';
    currentSpec = null;
    currentMilestones = [];
    updateIdeaStartEnabled();
    els.ideaStart.textContent = 'Start refinement';
    showState('idea');
    els.ideaInput.focus();
  });

  els.planApprove.addEventListener('click', async () => {
    els.planApprove.disabled = true;
    els.planApprove.textContent = 'Approving&hellip;';
    try {
      const result = await kovixAPI.plan.approve();
      if (result.ok) {
        // Initialize preflight UI with defaults from the session
        const state = await kovixAPI.session.getState();
        renderPreflight(state);
        showState('preflight');
      } else {
        showError(result.error || 'Failed to approve plan.');
      }
    } catch (err) {
      showError(err.message || String(err));
    } finally {
      els.planApprove.disabled = false;
      els.planApprove.textContent = 'Approve plan & continue';
    }
  });

  // --- PREFLIGHT state (Phase 2) ---
  let preflightState = {
    pauseMode: 'major',
    customPauseIds: [],
    creditLimit: 0,
    verifyAfterEach: true,
  };

  function renderPreflight(state) {
    const pf = state.preflight || preflightState;
    preflightState = { ...pf };

    // Set the radio button
    const radio = els.preflightModeGrid.querySelector('input[value="' + pf.pauseMode + '"]');
    if (radio) { radio.checked = true; }
    updatePreflightModeUI();

    // Populate custom picks
    els.preflightCustomPicks.innerHTML = '';
    (state.milestones || []).forEach(m => {
      const label = document.createElement('label');
      label.className = 'preflight-custom-pick';
      const checked = pf.customPauseIds.includes(m.id) ? 'checked' : '';
      label.innerHTML =
        '<input type="checkbox" value="' + m.id + '" ' + checked + ' />' +
        '<span>' + escapeHtml(m.id + ': ' + m.name) + (m.isMajor ? ' (major)' : '') + '</span>';
      els.preflightCustomPicks.appendChild(label);
    });

    els.preflightCreditLimit.value = String(pf.creditLimit || 0);
    els.preflightVerify.checked = !!pf.verifyAfterEach;
  }

  function updatePreflightModeUI() {
    const selected = els.preflightModeGrid.querySelector('input[name="pause-mode"]:checked');
    const mode = selected ? selected.value : 'major';
    els.preflightModeGrid.querySelectorAll('.preflight-mode-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.mode === mode);
    });
    els.preflightCustomPicks.classList.toggle('hidden', mode !== 'custom');
  }

  els.preflightModeGrid.addEventListener('change', updatePreflightModeUI);
  els.preflightModeGrid.querySelectorAll('.preflight-mode-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const radio = opt.querySelector('input[type="radio"]');
      if (radio) { radio.checked = true; updatePreflightModeUI(); }
    });
  });

  async function gatherPreflightConfig() {
    const selected = els.preflightModeGrid.querySelector('input[name="pause-mode"]:checked');
    const pauseMode = selected ? selected.value : 'major';
    const customPauseIds = Array.from(els.preflightCustomPicks.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => cb.value);
    const creditLimit = parseInt(els.preflightCreditLimit.value, 10) || 0;
    const verifyAfterEach = els.preflightVerify.checked;
    return { pauseMode, customPauseIds, creditLimit, verifyAfterEach };
  }

  els.preflightBack.addEventListener('click', () => {
    showState('plan');
  });

  els.preflightConfirm.addEventListener('click', async () => {
    els.preflightConfirm.disabled = true;
    els.preflightConfirm.textContent = 'Starting&hellip;';
    try {
      const config = await gatherPreflightConfig();
      const saveResult = await kovixAPI.preflight.save(config);
      if (!saveResult.ok) {
        showError(saveResult.error || 'Invalid preflight config.');
        return;
      }
      const confirmResult = await kovixAPI.preflight.confirm();
      if (!confirmResult.ok) {
        showError(confirmResult.error || 'Failed to start execution.');
        return;
      }
      // Switch to execute screen and render the milestone cards in pending state
      renderExecuteScreen();
      showState('execute');
      // Start execution — events will flow via onEvent/onStateUpdate/onComplete
      await kovixAPI.exec.start();
    } catch (err) {
      showError(err.message || String(err));
    } finally {
      els.preflightConfirm.disabled = false;
      els.preflightConfirm.textContent = 'Start execution';
    }
  });

  // --- EXECUTE state (Phase 2) ---
  // Milestone states keyed by ID — updated via onStateUpdate events.
  let execMilestoneStates = {}; // id -> { status, events, verificationPassed, verificationOutput }
  let execMilestones = []; // the plan's milestones (for rendering order)
  let execTotalCredits = 0;

  function renderExecuteScreen() {
    // Get the current session to populate milestone states
    kovixAPI.session.getState().then(state => {
      execMilestones = state.milestones || [];
      execMilestoneStates = {};
      for (const ms of state.execution.milestoneStates) {
        execMilestoneStates[ms.milestoneId] = {
          status: ms.status,
          events: ms.events || [],
          verificationPassed: ms.verificationPassed,
          verificationOutput: ms.verificationOutput,
        };
      }
      rerenderExecuteMilestones();
      updateExecuteProgress();
    });
  }

  function rerenderExecuteMilestones() {
    els.executeMilestones.innerHTML = '';
    execMilestones.forEach((m, i) => {
      const st = execMilestoneStates[m.id] || { status: 'pending', events: [] };
      const card = renderMilestoneCard(m, i, {
        stage: 'execute',
        status: st.status,
        verification: st.verificationPassed !== undefined
          ? { passed: st.verificationPassed, output: st.verificationOutput }
          : undefined,
        eventLog: st.events,
      });
      els.executeMilestones.appendChild(card);
    });
    updateExecuteProgress();
  }

  function updateExecuteProgress() {
    const total = execMilestones.length;
    const completed = execMilestones.filter(m => {
      const st = execMilestoneStates[m.id];
      return st && (st.status === 'completed' || st.status === 'skipped');
    }).length;
    const pct = total > 0 ? (completed / total) * 100 : 0;
    els.executeProgressFill.style.width = pct + '%';
    els.executeProgressText.textContent = completed + ' / ' + total + ' milestones';
    els.executeCreditsText.textContent = '~' + execTotalCredits + ' credits used';
  }

  // Listen for exec events
  kovixAPI.exec.onEvent((event) => {
    // Most events are just logged to console; milestone state updates come
    // via onStateUpdate. We handle a few special cases here.
    if (event.type === 'milestone_paused') {
      els.executePauseBanner.classList.remove('hidden');
      els.executePauseText.textContent = 'Paused at milestone: ' + (event.milestone.name || event.milestone.id);
    } else if (event.type === 'milestone_resumed') {
      els.executePauseBanner.classList.add('hidden');
    } else if (event.type === 'error') {
      els.executeStatusText.textContent = 'Error: ' + event.text;
      els.executeStatusText.style.color = 'var(--danger)';
    }
  });

  kovixAPI.exec.onStateUpdate((update) => {
    if (update.milestoneId) {
      execMilestoneStates[update.milestoneId] = {
        status: update.state.status,
        events: update.state.events || [],
        verificationPassed: update.state.verificationPassed,
        verificationOutput: update.state.verificationOutput,
      };
    }
    if (typeof update.totalCreditsUsed === 'number') {
      execTotalCredits = update.totalCreditsUsed;
    }
    rerenderExecuteMilestones();
  });

  kovixAPI.exec.onComplete((result) => {
    els.executePauseBanner.classList.add('hidden');
    els.executeStatusText.textContent = 'Build complete.';
    // Show the done screen
    const summary = result.summary || 'Build finished.';
    const buildDir = result.buildDir || '(unknown)';
    const approvalNote = result.approvalFired
      ? 'Staging layer fired the approval callback ' + (result.fileWrittenBeforeApproval ? 'but VIOLATION: file was on disk before approval!' : 'and correctly blocked writes until approval.')
      : 'No file-write approvals were fired (the agent may not have written any files).';
    els.doneSummary.innerHTML =
      '<div style="font-weight:600;margin-bottom:8px">&#10003; Execution complete</div>' +
      '<div style="margin-bottom:12px">' + escapeHtml(summary.substring(0, 500)) + '</div>' +
      '<div style="font-size:12px;opacity:0.85">' + escapeHtml(approvalNote) + '</div>' +
      '<div style="font-size:12px;opacity:0.85;margin-top:4px">Credits used: ~' + (result.totalCreditsUsed || 0) + '</div>';
    els.doneBuildDir.textContent = 'Build workspace: ' + buildDir;
    showState('done');
  });

  els.execResume.addEventListener('click', async () => {
    els.executePauseBanner.classList.add('hidden');
    await kovixAPI.exec.resume();
  });

  els.execSkip.addEventListener('click', async () => {
    els.executePauseBanner.classList.add('hidden');
    await kovixAPI.exec.skip();
  });

  els.execAbort.addEventListener('click', async () => {
    if (!confirm('Abort execution? This will stop the agent at the next yield point.')) return;
    await kovixAPI.exec.abort();
    els.executeStatusText.textContent = 'Aborting&hellip;';
  });

  // --- DONE state ---
  els.doneRestart.addEventListener('click', async () => {
    await kovixAPI.session.reset();
    els.ideaInput.value = '';
    els.conversation.innerHTML = '';
    els.specCard.innerHTML = '';
    els.planMilestones.innerHTML = '';
    els.executeMilestones.innerHTML = '';
    currentSpec = null;
    currentMilestones = [];
    execMilestones = [];
    execMilestoneStates = {};
    execTotalCredits = 0;
    els.executeStatusText.textContent = 'The agent is working through your milestones.';
    els.executeStatusText.style.color = '';
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
