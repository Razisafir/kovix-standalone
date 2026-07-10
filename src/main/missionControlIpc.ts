/**
 * Mission Control IPC wiring — Kovix 2.0 Phase 5.
 *
 * Sets up the IPC bridge between the Mission Control renderer (the Phase 3
 * 3-pane UI in missionControlHtml.ts) and the Phase 4 backend
 * (`MilestoneTaskRunner` + `wrapProvider` from src/agent/).
 *
 * This module is the single seam where the Phase 3 UI meets the Phase 4
 * backend. Responsibilities:
 *  - Register ipcMain handlers for: mc:start, mc:approve, mc:reject, mc:file-tree
 *  - When a mission starts, construct a MilestoneTaskRunner with:
 *      llm            = wrapProvider(createProvider(cfg))   (Phase 4 adapter)
 *      workspaceRoot  = the effective workspace dir
 *      requireApproval = true   (so write_file/edit_file trigger the Approval Card)
 *  - Wire the runner's EventEmitter output to mainWindow.webContents.send
 *    so the renderer gets plan_ready, milestone_started, tool_call,
 *    approval_required, verification_result, etc.
 *
 * EVENT MAP (MilestoneTaskRunner event → renderer channel):
 *   plan_ready          → kovix:mc:plan-ready        (payload.milestones)
 *   milestone_started   → kovix:mc:milestone-started (milestone.id)
 *   milestone_verified  → kovix:mc:milestone-verified (milestone.id)
 *   milestone_failed    → kovix:mc:milestone-failed   (milestone.id)
 *   llm_text            → kovix:mc:llm-text            (text)
 *   tool_call           → kovix:mc:tool-call           (payload)
 *   tool_result         → kovix:mc:tool-result         (payload)
 *   approval_required   → kovix:mc:approval-required   (payload)
 *   verification_result → kovix:mc:verification-result (payload)  [Phase 4 bonus]
 *   complete            → kovix:mc:complete            (milestones)
 *   error               → kovix:mc:complete            ({ ok:false, error })
 *
 * The Phase 3 renderer already knows how to render plan/milestone/tool/
 * approval events; verification_result is forwarded too so a future UI
 * tweak can show the verifier's YES/NO inline.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { MilestoneTaskRunner } from '../agent/milestoneTaskRunner.js';
import { wrapProvider } from '../agent/llmProviderAdapter.js';
import { createProvider, listProviders } from '../agent/index.js';
import type { ProviderName } from '../agent/index.js';
import { resolveProviderConfig } from './settingsStore.js';

/**
 * The active MilestoneTaskRunner for the current mission. Null when no
 * mission is running. The approve/reject IPC handlers reference this to
 * forward user decisions to the runner's approval gate.
 */
let activeRunner: MilestoneTaskRunner | null = null;

/**
 * Build the LLMProvider for a mission.
 *
 * Uses `wrapProvider()` (Phase 4 adapter) to wrap the existing
 * `IConstructAIProvider` produced by `createProvider()`. The adapter
 * translates LLMMessage[] ↔ IChatMessage[], bridges tool schemas, and
 * drains the streaming AIStreamEvent into a single LLMResponse — so the
 * Mission Control UI works with any configured provider (Anthropic,
 * OpenRouter, Ollama, etc.) and actually exercises real tool-calling.
 *
 * Throws when no provider is configured — the UI catches and shows
 * "configure a provider first".
 */
async function buildLLMProvider() {
    const cfg = await resolveProviderConfig();
    if (!cfg) {
        throw new Error(
            'No provider configured. Open Settings (gear icon) to add an API key, or set an env var (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, etc.).',
        );
    }
    const oldProvider = createProvider(cfg);
    return wrapProvider(oldProvider, {
        log: (msg: string) => console.log(`[LLMProviderAdapter] ${msg}`),
    });
}

/**
 * Register all Mission Control IPC handlers. Call once during app startup.
 * The `getWorkspaceRoot` function is injected so this module doesn't
 * depend on the specific workspace-resolution logic in main.ts.
 */
export function setupMissionControlIpc(
    getMainWindow: () => BrowserWindow | null,
    getWorkspaceRoot: () => Promise<string>,
): void {
    // ── mc:start — kick off a new mission ────────────────────────────
    ipcMain.handle(
        'kovix:mc:start',
        async (_event, prompt: string): Promise<{ ok: boolean; error?: string; plan?: unknown[] }> => {
            const win = getMainWindow();
            if (!win || win.isDestroyed()) {
                return { ok: false, error: 'No window available.' };
            }
            if (!prompt || typeof prompt !== 'string') {
                return { ok: false, error: 'No prompt provided.' };
            }

            try {
                const [llm, workspaceRoot] = await Promise.all([
                    buildLLMProvider(),
                    getWorkspaceRoot(),
                ]);

                // Fresh runner per mission. requireApproval=true so the
                // Mission Control UI's Approval Card fires for write_file /
                // edit_file. autoApplyWrites=true so approved writes are
                // flushed to disk immediately (no separate "apply" step).
                const runner = new MilestoneTaskRunner({
                    llm,
                    workspaceRoot,
                    requireApproval: true,
                    autoApplyWrites: true,
                    maxIterations: 15,
                    log: (msg: string) => console.log(`[mission] ${msg}`),
                });
                activeRunner = runner;

                // ── Wire runner events → renderer ─────────────────────
                runner.on('plan_ready', (payload: { milestones: unknown[] }) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:plan-ready', payload.milestones);
                });
                runner.on('milestone_started', (payload: { milestone: { id: string } }) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:milestone-started', payload.milestone.id);
                });
                runner.on('milestone_verified', (payload: { milestone: { id: string } }) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:milestone-verified', payload.milestone.id);
                });
                runner.on('milestone_failed', (payload: { milestone: { id: string }; reason: string }) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:milestone-failed', payload.milestone.id);
                });
                runner.on('llm_text', (payload: { text: string }) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:llm-text', payload.text);
                });
                runner.on('tool_call', (payload: unknown) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:tool-call', payload);
                });
                runner.on('tool_result', (payload: unknown) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:tool-result', payload);
                });
                runner.on('approval_required', (payload: unknown) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:approval-required', payload);
                });
                runner.on('verification_result', (payload: unknown) => {
                    if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:verification-result', payload);
                });

                // ── Run the mission ───────────────────────────────────
                const milestones = await runner.runMilestoneTask(prompt);
                activeRunner = null;
                const result = { ok: true, plan: milestones as unknown[] };
                if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:complete', result);
                return result;
            } catch (err) {
                activeRunner = null;
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[mission] failed:', msg);
                const result = { ok: false, error: msg };
                const w = getMainWindow();
                if (w && !w.isDestroyed()) w.webContents.send('kovix:mc:complete', result);
                return result;
            }
        },
    );

    // ── mc:approve — user clicked Approve on an approval card ───────
    ipcMain.handle('kovix:mc:approve', (_event, callId: string): { ok: boolean } => {
        if (!activeRunner) {
            console.warn('[mission] approve: no active runner');
            return { ok: false };
        }
        activeRunner.approveToolCall(callId);
        return { ok: true };
    });

    // ── mc:reject — user clicked Reject on an approval card ─────────
    ipcMain.handle('kovix:mc:reject', (_event, callId: string): { ok: boolean } => {
        if (!activeRunner) {
            console.warn('[mission] reject: no active runner');
            return { ok: false };
        }
        activeRunner.rejectToolCall(callId);
        return { ok: true };
    });

    // ── mc:file-tree — list immediate children of workspace root ────
    ipcMain.handle(
        'kovix:mc:file-tree',
        async (): Promise<{ entries: string[]; error?: string }> => {
            try {
                const root = await getWorkspaceRoot();
                const entries = await fs.readdir(root, { withFileTypes: true });
                const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                // Sort: directories first, then alphabetical.
                names.sort((a, b) => {
                    const aDir = a.endsWith('/');
                    const bDir = b.endsWith('/');
                    if (aDir !== bDir) return aDir ? -1 : 1;
                    return a.localeCompare(b);
                });
                return { entries: names };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { entries: [], error: msg };
            }
        },
    );
}

/**
 * Exported for main.ts to log provider availability at startup.
 */
export async function getProviderSummary(): Promise<string> {
    const cfg = await resolveProviderConfig();
    if (!cfg) return 'No provider';
    return cfg.name + (cfg.modelId ? ` · ${cfg.modelId}` : '');
}

// Re-export for main.ts convenience.
export { listProviders, createProvider };
export type { ProviderName };
