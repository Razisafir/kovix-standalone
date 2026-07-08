/**
 * Preload - exposes the Kovix API to the renderer.
 *
 * Phase 1 adds the refinement API (refine.start / refine.continue) and a
 * provider-label getter for the top-right chip. The Phase 0 plan/execute API
 * is preserved for Phase 2+ (Spec Approval / Plan / Pre-flight / Execute
 * screens).
 *
 * contextIsolation is on — the renderer has no direct Node access. Everything
 * goes through this bridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kovixAPI', {
    // ---- Phase 1: Build mode refinement ----
    refine: {
        /**
         * Start a new refinement session with the given idea text.
         * Returns the first RefinementResult — either { kind: 'question', text }
         * or { kind: 'spec', spec } (rare on the first call, but possible if
         * the LLM finalizes immediately).
         */
        start: (ideaText: string) => ipcRenderer.invoke('kovix:refine:start', ideaText),
        /**
         * Continue an active refinement session with the user's answer.
         * Returns the next RefinementResult.
         */
        continue: (answer: string) => ipcRenderer.invoke('kovix:refine:continue', answer),
    },

    /**
     * Get a human-readable label for the currently-configured provider
     * (e.g. "Anthropic Claude", "OpenRouter", "Ollama (local)"). Used by
     * the top-right chip in the Build mode UI.
     */
    getProviderLabel: () => ipcRenderer.invoke('kovix:provider-label'),

    // ---- Phase 0 legacy: agent loop (kept for Phase 2+ Plan/Execute screens) ----
    plan: (task: string) => ipcRenderer.invoke('kovix:plan', task),
    execute: (task: string, onEvent: (event: unknown) => void) => {
        const listener = (_event: unknown, data: unknown) => onEvent(data);
        ipcRenderer.on('kovix:event', listener);
        return ipcRenderer.invoke('kovix:execute', task).finally(() => {
            ipcRenderer.removeListener('kovix:event', listener);
        });
    },
});
