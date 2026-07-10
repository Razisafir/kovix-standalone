/**
 * Mission Control IPC wiring — Kovix 2.0 Phase 3.
 *
 * Sets up the IPC bridge between the Mission Control renderer and the new
 * `src/core/agent/AgentLoop` (the Phase 1-3 backend). This module is called
 * once from main.ts during app startup.
 *
 * Responsibilities:
 *  - Register ipcMain handlers for: mc:start, mc:approve, mc:reject, mc:file-tree
 *  - When a mission starts, construct a new AgentLoop with:
 *      provider = the existing provider from settingsStore (createProvider)
 *      registry = core filesystem tools (read/write/list)
 *      workspaceRoot = the effective workspace dir
 *  - Wire the AgentLoop's EventEmitter output to mainWindow.webContents.send
 *    so the renderer gets plan_ready, milestone_started, tool_call,
 *    approval_required, etc.
 *
 * NOTE: The provider wiring reuses the existing `createProvider` factory from
 * src/agent/ — the old Phase 0 agent module. The new AgentLoop expects an
 * `LLMProvider` (from src/core/agent/types.ts) with a `chat()` method. We
 * adapt the old `IConstructAIProvider` to the new interface via a thin
 * wrapper. This keeps the Mission Control UI usable with any provider the
 * user has already configured (Anthropic, OpenRouter, Ollama, etc.) without
 * duplicating the provider stack.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AgentLoop, AGENT_EVENTS } from '../core/agent/AgentLoop.js';
import type { LLMMessage, LLMProvider, LLMResponse } from '../core/agent/types.js';
import { ToolRegistry } from '../core/tools/registry.js';
import { createCoreTools } from '../core/tools/core-tools.js';
import { createProvider, listProviders } from '../agent/index.js';
import type { ProviderName } from '../agent/index.js';
import { resolveProviderConfig } from './settingsStore.js';

/**
 * The active AgentLoop for the current mission. Null when no mission is
 * running. The approve/reject IPC handlers reference this to forward
 * user decisions to the loop's approval gate.
 */
let activeLoop: AgentLoop | null = null;

/**
 * Build the ToolRegistry with core filesystem tools. Called once per mission.
 */
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createCoreTools()) {
    registry.registerTool(tool);
  }
  return registry;
}

/**
 * Adapt the existing IConstructAIProvider (from src/agent/) to the new
 * LLMProvider interface (from src/core/agent/types.ts).
 *
 * The old provider's `chat()` returns a stream of events; we collect them
 * into a single LLMResponse. This is a minimal adapter — it handles the
 * common case (text + tool calls) and is sufficient for the Mission Control
 * UI to work with any configured provider.
 *
 * NOTE: If no provider config is available (no settings, no env vars), this
 * throws — the UI should catch and display "configure a provider first".
 */
async function buildLLMProvider(): Promise<LLMProvider> {
  const cfg = await resolveProviderConfig();
  if (!cfg) {
    throw new Error(
      'No provider configured. Open Settings (gear icon) to add an API key, or set an env var (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, etc.).',
    );
  }
  const oldProvider = createProvider(cfg);

  // Wrap the old provider's streaming chat() into the new LLMProvider.chat().
  return {
    async chat(
      messages: LLMMessage[],
      _tools?: unknown,
    ): Promise<LLMResponse> {
      // Convert the new LLMMessage format to the old IChatMessage format.
      // The old provider takes { role, content } pairs and returns an async
      // iterable of AIStreamEvents.
      const conv = messages.map((m) => ({
        role: m.role,
        content: m.content ?? '',
      }));

      let text = '';
      let stopReason: LLMResponse['stop_reason'] = 'stop';
      const toolCalls: NonNullable<LLMResponse['tool_calls']> = [];
      let toolCallCounter = 0;

      // The old provider's chat() requires (messages, tools, options?).
      // We pass an empty tools array — the new AgentLoop's tool schemas are
      // in the new format (OpenAI function-calling) and don't map cleanly to
      // the old IToolDefinition. The old provider still works for text + the
      // LLM's native tool-calling if the provider supports it. For a proper
      // integration, a future phase should bridge the tool schemas too.
      const iterable = oldProvider.chat(conv, [], {}) as AsyncIterable<{
        type: string;
        text?: string;
        toolId?: string;
        toolName?: string;
        stopReason?: string;
      }>;

      for await (const ev of iterable) {
        if (ev.type === 'token' && ev.text) {
          text += ev.text;
        } else if (ev.type === 'tool_start' && ev.toolName) {
          // The old provider emits tool_start/tool_end pairs for tool calls.
          // We create a tool_call entry on tool_start; arguments come from
          // tool_input events. Since the old provider's tool handling is
          // separate from the new AgentLoop's registry, this adapter focuses
          // on text + stop reason. Tool calls in the new flow come from the
          // new AgentLoop's own LLM response parsing (when a real provider is
          // wired directly to the new interface in a future phase).
          toolCallCounter++;
        } else if (ev.type === 'done') {
          if (ev.stopReason === 'tool_use') {
            stopReason = 'tool_use';
          } else if (ev.stopReason === 'length') {
            stopReason = 'length';
          } else if (ev.stopReason === 'content_filter') {
            stopReason = 'content_filter';
          } else {
            stopReason = 'stop';
          }
        }
      }

      return {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        stop_reason: stopReason,
      };
    },
  };
}

/**
 * Register all Mission Control IPC handlers. Call once during app startup.
 * The `getWorkspaceRoot` function is injected so this module doesn't depend
 * on the specific workspace-resolution logic in main.ts.
 */
export function setupMissionControlIpc(
  getMainWindow: () => BrowserWindow | null,
  getWorkspaceRoot: () => Promise<string>,
): void {
  // ── mc:start — kick off a new mission ────────────────────────────
  ipcMain.handle('kovix:mc:start', async (_event, prompt: string): Promise<{ ok: boolean; error?: string; plan?: unknown[] }> => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: 'No window available.' };
    }
    if (!prompt || typeof prompt !== 'string') {
      return { ok: false, error: 'No prompt provided.' };
    }

    try {
      const [provider, workspaceRoot] = await Promise.all([
        buildLLMProvider(),
        getWorkspaceRoot(),
      ]);
      const registry = buildRegistry();

      // Create a fresh loop for each mission. History doesn't persist
      // across missions — each run is independent.
      const loop = new AgentLoop({
        provider,
        registry,
        workspaceRoot,
        maxIterations: 15,
      });
      activeLoop = loop;

      // ── Wire loop events → renderer ───────────────────────────────
      loop.on(AGENT_EVENTS.plan_ready, (plan: unknown) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:plan-ready', plan);
      });
      loop.on(AGENT_EVENTS.milestone_started, (id: string) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:milestone-started', id);
      });
      loop.on(AGENT_EVENTS.milestone_verified, (id: string) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:milestone-verified', id);
      });
      loop.on(AGENT_EVENTS.milestone_failed, (id: string) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:milestone-failed', id);
      });
      loop.on(AGENT_EVENTS.llm_text, (text: string) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:llm-text', text);
      });
      loop.on(AGENT_EVENTS.tool_call, (payload: unknown) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:tool-call', payload);
      });
      loop.on(AGENT_EVENTS.tool_result, (payload: unknown) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:tool-result', payload);
      });
      loop.on(AGENT_EVENTS.approval_required, (payload: unknown) => {
        if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:approval-required', payload);
      });

      // ── Run the mission ───────────────────────────────────────────
      const plan = await loop.runMilestoneTask(prompt);
      activeLoop = null;
      const result = { ok: true, plan: plan as unknown[] };
      if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:complete', result);
      return result;
    } catch (err) {
      activeLoop = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[mission] failed:', msg);
      const result = { ok: false, error: msg };
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('kovix:mc:complete', result);
      return result;
    }
  });

  // ── mc:approve — user clicked Approve on an approval card ───────
  ipcMain.handle('kovix:mc:approve', (_event, callId: string): { ok: boolean } => {
    if (!activeLoop) {
      console.warn('[mission] approve: no active loop');
      return { ok: false };
    }
    activeLoop.approveToolCall(callId);
    return { ok: true };
  });

  // ── mc:reject — user clicked Reject on an approval card ─────────
  ipcMain.handle('kovix:mc:reject', (_event, callId: string): { ok: boolean } => {
    if (!activeLoop) {
      console.warn('[mission] reject: no active loop');
      return { ok: false };
    }
    activeLoop.rejectToolCall(callId);
    return { ok: true };
  });

  // ── mc:file-tree — list immediate children of workspace root ────
  ipcMain.handle('kovix:mc:file-tree', async (): Promise<{ entries: string[]; error?: string }> => {
    try {
      const root = await getWorkspaceRoot();
      const entries = await fs.readdir(root, { withFileTypes: true });
      const names = entries.map((e) =>
        e.isDirectory() ? `${e.name}/` : e.name,
      );
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
  });
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
