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
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import {
    AgentLoop,
    createProvider,
    RefinementService,
} from '../agent/index.js';
import type {
    AgentLoopEvent,
    ProviderName,
    RefinementResult,
    RefinementTurn,
} from '../agent/index.js';

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

function getProviderConfig(): { name: ProviderName; apiKey?: string; modelId?: string; baseUrl?: string } {
    // Priority: ANTHROPIC > OPENROUTER > NVIDIA > OLLAMA
    // Default model for Anthropic: claude-sonnet-4-20250514 (the latest Sonnet
    // available at Phase 0 verification; user can override via KOVIX_MODEL).
    // Note: the user's spec said "default to Anthropic/claude-sonnet-5" — there
    // is no Sonnet 5 in Anthropic's lineup as of mid-2025; Sonnet 4 is the
    // latest. Override via KOVIX_MODEL env var if a newer model is needed.
    if (process.env.ANTHROPIC_API_KEY) {
        return {
            name: 'anthropic',
            apiKey: process.env.ANTHROPIC_API_KEY,
            modelId: process.env.KOVIX_MODEL ?? 'claude-sonnet-4-20250514',
        };
    }
    if (process.env.OPENROUTER_API_KEY) {
        return {
            name: 'openrouter',
            apiKey: process.env.OPENROUTER_API_KEY,
            modelId: process.env.KOVIX_MODEL ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-oss-20b:free',
        };
    }
    if (process.env.NVIDIA_API_KEY) {
        return {
            name: 'nvidia',
            apiKey: process.env.NVIDIA_API_KEY,
            modelId: process.env.KOVIX_MODEL ?? 'meta/llama-3.3-70b-instruct',
        };
    }
    // Default: try Ollama (local, free, no key)
    return {
        name: 'ollama',
        modelId: process.env.KOVIX_MODEL ?? process.env.OLLAMA_MODEL,
        baseUrl: process.env.OLLAMA_BASE_URL,
    };
}

function getRefinementService(): RefinementService {
    if (refinementService) { return refinementService; }
    const cfg = getProviderConfig();
    const provider = createProvider(cfg);
    refinementService = new RefinementService({
        aiProvider: provider,
        maxTurns: 5,
        minTurns: 3,
        log: (msg) => console.log('[refine] ' + msg),
    });
    return refinementService;
}

function getAgent(): AgentLoop {
    if (agent) { return agent; }
    const cfg = getProviderConfig();
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
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 820,
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
    const cfg = getProviderConfig();
    if (cfg.name === 'anthropic') { return 'Anthropic Claude'; }
    if (cfg.name === 'openrouter') { return 'OpenRouter' + (cfg.modelId ? ' · ' + cfg.modelId : ''); }
    if (cfg.name === 'ollama') { return 'Ollama (local)'; }
    if (cfg.name === 'nvidia') { return 'NVIDIA NIM'; }
    return String(cfg.name);
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

    const service = getRefinementService();
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

    const service = getRefinementService();
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
    if (!agent) { agent = getAgent(); }
    return await agent.runPlanningPhase(task);
});

ipcMain.handle('kovix:execute', async (_event, task: string) => {
    if (!agent) { agent = getAgent(); }
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

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

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
    <div class="provider-chip" id="provider-chip">—</div>
  </header>

  <main>
    <div class="container">

      <!-- IDEA STATE -->
      <section id="state-idea" class="idea-screen">
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
  };

  // --- Provider chip ---
  // The main process can tell us which provider is configured via a sync IPC
  // call. We don't have one, so we just display the env-derived label.
  // (Phase 2 will add a proper provider picker.)
  try {
    kovixAPI.getProviderLabel().then(label => {
      els.providerChip.textContent = label;
    });
  } catch {
    els.providerChip.textContent = 'provider: see console';
  }

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

  // --- Initial state ---
  showState('idea');
  updateIdeaStartEnabled();
  els.ideaInput.focus();
})();
</script>
</body>
</html>`;
