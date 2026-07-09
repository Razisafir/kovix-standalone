/**
 * Preload - exposes the Kovix API to the renderer.
 *
 * Phase 1 adds the refinement API (refine.start / refine.continue) and a
 * provider-label getter for the top-right chip. The Phase 0 plan/execute API
 * is preserved for Phase 2+ (Spec Approval / Plan / Pre-flight / Execute
 * screens).
 *
 * Settings API (added with the provider settings screen): lets the renderer
 * load/save provider config, test connection, and clear the stored key.
 * The renderer NEVER sees the full API key — only a masked preview.
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

    /**
     * Register a callback that's invoked when the active provider changes
     * (e.g. after the user saves new settings). The callback receives the
     * new provider label string.
     */
    onProviderChanged: (callback: (label: string) => void) => {
        const listener = (_event: unknown, label: string) => callback(label);
        ipcRenderer.on('kovix:provider-changed', listener);
        // Return an unsubscribe function — good hygiene for hot-reload/dev.
        return () => ipcRenderer.removeListener('kovix:provider-changed', listener);
    },

    // ---- Settings (provider config) ----
    settings: {
        /**
         * Returns a list of all registered providers, with metadata for the
         * dropdown (label, whether key required, whether offline, etc).
         */
        listProviders: () => ipcRenderer.invoke('kovix:settings:list-providers'),
        /**
         * Get the current settings preview. The API key is ALWAYS masked —
         * the renderer never sees the full value.
         */
        getPreview: () => ipcRenderer.invoke('kovix:settings:get-preview'),
        /**
         * Test a provider config WITHOUT saving it. Makes a real minimal
         * API call. Returns { ok, message, durationMs, responsePreview? }.
         */
        testConnection: (config: { provider: string; apiKey?: string; modelId?: string; baseUrl?: string }) =>
            ipcRenderer.invoke('kovix:settings:test', config),
        /**
         * Save provider config (with API key) to persistent storage.
         * The key is encrypted via safeStorage before being written to disk.
         * Returns the new preview.
         */
        save: (config: { provider: string; apiKey?: string; modelId?: string; baseUrl?: string }) =>
            ipcRenderer.invoke('kovix:settings:save', config),
        /**
         * Clear the stored API key. Other settings (provider, model) are kept.
         */
        clearApiKey: () => ipcRenderer.invoke('kovix:settings:clear-key'),
        /**
         * Get the list of suggested model IDs for a provider. Used to
         * populate the model picker dropdown.
         */
        getModelsForProvider: (provider: string) => ipcRenderer.invoke('kovix:settings:get-models', provider),
    },

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
