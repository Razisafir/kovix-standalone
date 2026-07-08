/**
 * Kovix standalone - Electron main process.
 *
 * Minimal shell: a plain BrowserWindow with a Node-side agent bridge.
 * No VS Code, no gulp, no extension host, no Monaco. The renderer will
 * be built in the next phase (Build mode UI: idea/refinement/spec/plan
 * screens). For now this just proves the Electron shell boots and can
 * talk to the agent core over IPC.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { AgentLoop, CloudProvider } from '../agent/index.js';
import type { AgentLoopEvent } from '../agent/index.js';

let mainWindow: BrowserWindow | null = null;
let agent: AgentLoop | null = null;

function createAgent(): AgentLoop {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) {
        console.warn('[kovix] ANTHROPIC_API_KEY not set - agent will not be able to call the LLM.');
    }
    const provider = new CloudProvider({
        apiKey,
        modelId: process.env.KOVIX_MODEL ?? 'claude-sonnet-4-20250514',
    });
    return new AgentLoop({
        aiProvider: provider,
        workspaceRoot: process.cwd(),
        log: (msg: string) => console.log('[agent] ' + msg),
        approveWrite: async (filePath: string, proposed: string, _existing: string | null) => {
            // In the real UI this would render a diff view in the renderer
            // and wait for the user to click Approve/Reject. For Phase 0
            // we just log and approve (so the dev shell can be smoke-tested
            // end-to-end without a UI).
            console.log('[kovix] AUTO-APPROVING write to ' + filePath + ' (' + proposed.length + ' chars)');
            return true;
        },
        approveInterpreterCommand: async (cmd: string) => {
            console.log('[kovix] AUTO-APPROVING interpreter command: ' + cmd);
            return true;
        },
        onlineMode: false,
    });
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'Kovix',
    });

    // Phase 0: load a placeholder page. The real UI (Build mode flow)
    // is the next phase.
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html>
<head>
<title>Kovix</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 40px; background: #1e1e1e; color: #ddd; }
h1 { color: #4fc3f7; }
pre { background: #2a2a2a; padding: 16px; border-radius: 4px; overflow: auto; }
.code { font-family: 'SF Mono', Menlo, monospace; }
button { background: #4fc3f7; color: #1e1e1e; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
button:hover { background: #29b6f6; }
input { background: #2a2a2a; color: #ddd; border: 1px solid #444; padding: 8px; border-radius: 4px; width: 70%%; }
</style>
</head>
<body>
<h1>Kovix - Standalone (Phase 0)</h1>
<p>Agent core extracted. UI not yet built. This is a smoke-test shell.</p>
<p>Try a task:</p>
<div>
  <input id="task" placeholder="create a file called hello.txt with the text test in it" />
  <button id="run">Run</button>
</div>
<pre id="output" class="code">Output will appear here...</pre>
<script>
const { kovixAPI } = window;
const taskInput = document.getElementById('task');
const runBtn = document.getElementById('run');
const output = document.getElementById('output');

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task) return;
  output.textContent = 'Running: ' + task + '\\n';
  try {
    const plan = await kovixAPI.plan(task);
    output.textContent += '\\n--- PLAN ---\\n' + plan.steps.map(s => (s.index+1) + '. [' + s.action + '] ' + s.target).join('\\n') + '\\n';

    output.textContent += '\\n--- EXECUTING ---\\n';
    await kovixAPI.execute(task, (event) => {
      output.textContent += '[' + event.type + '] ' + (event.text || event.toolName || event.filePath || event.detail || '') + '\\n';
      output.scrollTop = output.scrollHeight;
    });
    output.textContent += '\\n--- DONE ---\\n';
  } catch (err) {
    output.textContent += '\\nERROR: ' + err.message + '\\n';
  }
});
</script>
</body>
</html>`));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// IPC handlers
ipcMain.handle('kovix:plan', async (_event, task: string) => {
    if (!agent) { agent = createAgent(); }
    return await agent.runPlanningPhase(task);
});

ipcMain.handle('kovix:execute', async (_event, task: string) => {
    if (!agent) { agent = createAgent(); }
    const events: AgentLoopEvent[] = [];
    try {
        for await (const event of agent.run(task) as AsyncIterable<AgentLoopEvent>) {
            events.push(event);
            // Forward to renderer if window is open
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('kovix:event', event);
            }
        }
    } catch (err) {
        console.error('[kovix:execute] error:', err);
    }
    return events;
});

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
