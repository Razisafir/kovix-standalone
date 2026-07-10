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

    // ---- Workspace directory (where build files land) ----
    workspace: {
        /** Get the current workspace directory (or the default if not set). */
        get: () => ipcRenderer.invoke('kovix:workspace:get'),
        /** Open the OS directory picker and persist the user's choice. Returns the chosen path or null. */
        pick: () => ipcRenderer.invoke('kovix:workspace:pick'),
        /** Open a folder in the OS file explorer. Pass a path to open a specific folder, or omit to open the workspace root. */
        open: (dir?: string) => ipcRenderer.invoke('kovix:workspace:open', dir),
        /** Register a callback invoked when the workspace dir changes (e.g. after the user picks a new folder). */
        onChanged: (callback: (dir: string) => void) => {
            const listener = (_event: unknown, dir: string) => callback(dir);
            ipcRenderer.on('kovix:workspace-changed', listener);
            return () => ipcRenderer.removeListener('kovix:workspace-changed', listener);
        },
    },

    // ---- Phase 2: Spec Approval / Plan / Pre-flight / Execute ----
    session: {
        /** Get the current build session state (stage, spec, plan, preflight, execution). */
        getState: () => ipcRenderer.invoke('kovix:session:get-state'),
        /** Reset the session back to the Idea stage. */
        reset: () => ipcRenderer.invoke('kovix:session:reset'),
    },
    spec: {
        /** Update an item in a spec section (before approval only). */
        updateItem: (payload: { section: 'must' | 'should' | 'wont' | 'doneCriteria'; index: number; value: string }) =>
            ipcRenderer.invoke('kovix:spec:update-item', payload),
        /** Add a new item to a spec section (before approval only). */
        addItem: (payload: { section: 'must' | 'should' | 'wont' | 'doneCriteria'; value: string }) =>
            ipcRenderer.invoke('kovix:spec:add-item', payload),
        /** Remove an item from a spec section (before approval only). */
        removeItem: (payload: { section: 'must' | 'should' | 'wont' | 'doneCriteria'; index: number }) =>
            ipcRenderer.invoke('kovix:spec:remove-item', payload),
        /** Approve the spec — locks it and advances to the Plan stage. */
        approve: () => ipcRenderer.invoke('kovix:spec:approve'),
        /** Go back to the Refine (conversation) stage. Clears the generated spec, keeps the conversation. */
        back: () => ipcRenderer.invoke('kovix:spec:back'),
    },
    plan: {
        /** Generate a milestone plan from the approved spec via the LLM. */
        generate: () => ipcRenderer.invoke('kovix:plan:generate'),
        /** Approve the plan — locks it and advances to the Pre-flight stage. */
        approve: () => ipcRenderer.invoke('kovix:plan:approve'),
        /** Go back to the Spec stage. Un-approves the spec (makes it editable) and clears the plan. */
        back: () => ipcRenderer.invoke('kovix:plan:back'),
    },
    preflight: {
        /** Save the pre-flight config. Validates inputs. */
        save: (config: { pauseMode: 'every' | 'major' | 'auto' | 'custom'; customPauseIds: string[]; creditLimit: number; verifyAfterEach: boolean }) =>
            ipcRenderer.invoke('kovix:preflight:save', config),
        /** Confirm preflight — advances to the Execute stage. */
        confirm: () => ipcRenderer.invoke('kovix:preflight:confirm'),
    },
    exec: {
        /** Start execution. Returns immediately; events come via onEvent/onStateUpdate/onComplete. */
        start: () => ipcRenderer.invoke('kovix:exec:start'),
        /**
         * Start the lead agent. Same return contract as exec.start, but
         * iterates milestones via LeadAgentService (sequential fresh-worker
         * dispatch) instead of AgentLoop.runWithApprovedPlan (one shared
         * loop). Lead/worker events flow via onLeadEvent.
         */
        startLead: () => ipcRenderer.invoke('kovix:exec:start-lead'),
        /** Resume from a milestone pause. */
        resume: () => ipcRenderer.invoke('kovix:exec:resume'),
        /** Skip the current milestone (only valid when paused). */
        skip: () => ipcRenderer.invoke('kovix:exec:skip'),
        /** Resume a lead-agent pause. */
        leadResume: () => ipcRenderer.invoke('kovix:exec:lead-resume'),
        /** Skip the current lead-agent paused milestone. */
        leadSkip: () => ipcRenderer.invoke('kovix:exec:lead-skip'),
        /** Abort execution. Works for both legacy and lead paths. */
        abort: () => ipcRenderer.invoke('kovix:exec:abort'),
        /** Register a callback for streaming exec events. Returns unsubscribe. */
        onEvent: (callback: (event: unknown) => void) => {
            const listener = (_event: unknown, data: unknown) => callback(data);
            ipcRenderer.on('kovix:exec:event', listener);
            return () => ipcRenderer.removeListener('kovix:exec:event', listener);
        },
        /** Register a callback for milestone state updates. Returns unsubscribe. */
        onStateUpdate: (callback: (update: unknown) => void) => {
            const listener = (_event: unknown, data: unknown) => callback(data);
            ipcRenderer.on('kovix:exec:state-update', listener);
            return () => ipcRenderer.removeListener('kovix:exec:state-update', listener);
        },
        /** Register a callback for execution completion. Returns unsubscribe. */
        onComplete: (callback: (result: unknown) => void) => {
            const listener = (_event: unknown, data: unknown) => callback(data);
            ipcRenderer.on('kovix:exec:complete', listener);
            return () => ipcRenderer.removeListener('kovix:exec:complete', listener);
        },
        /**
         * Register a callback for lead-agent events (lead_reviewing,
         * worker_started, worker_completed, lead_blocked, etc.). The
         * renderer uses these to render the lead/worker visual structure
         * on the Execute screen.
         */
        onLeadEvent: (callback: (event: unknown) => void) => {
            const listener = (_event: unknown, data: unknown) => callback(data);
            ipcRenderer.on('kovix:exec:lead-event', listener);
            return () => ipcRenderer.removeListener('kovix:exec:lead-event', listener);
        },
    },

    // ---- Phase 0 legacy: agent loop (kept for backward compat with verify.ts) ----
    // NOTE: renamed from `plan` to `legacyPlan` because Phase 2 added a `plan`
    // object above (with .generate/.approve). verify.ts uses the --provider flag
    // directly and doesn't go through this preload, so this is safe to rename.
    legacyPlan: (task: string) => ipcRenderer.invoke('kovix:plan', task),
    legacyExecute: (task: string, onEvent: (event: unknown) => void) => {
        const listener = (_event: unknown, data: unknown) => onEvent(data);
        ipcRenderer.on('kovix:event', listener);
        return ipcRenderer.invoke('kovix:execute', task).finally(() => {
            ipcRenderer.removeListener('kovix:event', listener);
        });
    },

    // ---- Phase 3: Mission Control (3-pane UI + approval gate) ----
    mission: {
        /**
         * Start a mission: runs runMilestoneTask(prompt) in the main process.
         * Events stream back via the on* callbacks below. Returns the final
         * plan + ok flag when the mission completes.
         */
        start: (prompt: string) => ipcRenderer.invoke('kovix:mc:start', prompt),
        /** Approve a pending destructive tool call. Unblocks the agent loop. */
        approve: (callId: string) => ipcRenderer.invoke('kovix:mc:approve', callId),
        /** Reject a pending destructive tool call. The LLM sees an error and adapts. */
        reject: (callId: string) => ipcRenderer.invoke('kovix:mc:reject', callId),
        /** Get the workspace file tree (flat list of immediate children of root). */
        getFileTree: () => ipcRenderer.invoke('kovix:mc:file-tree'),
        // ── Push events from main → renderer ──
        onPlanReady: (callback: (plan: Array<{ id: string; title: string; description: string; status: string }>) => void) => {
            const listener = (_e: unknown, data: unknown) => callback(data as Array<{ id: string; title: string; description: string; status: string }>);
            ipcRenderer.on('kovix:mc:plan-ready', listener);
            return () => ipcRenderer.removeListener('kovix:mc:plan-ready', listener);
        },
        onMilestoneStarted: (callback: (id: string) => void) => {
            const listener = (_e: unknown, data: string) => callback(data);
            ipcRenderer.on('kovix:mc:milestone-started', listener);
            return () => ipcRenderer.removeListener('kovix:mc:milestone-started', listener);
        },
        onMilestoneVerified: (callback: (id: string) => void) => {
            const listener = (_e: unknown, data: string) => callback(data);
            ipcRenderer.on('kovix:mc:milestone-verified', listener);
            return () => ipcRenderer.removeListener('kovix:mc:milestone-verified', listener);
        },
        onMilestoneFailed: (callback: (id: string) => void) => {
            const listener = (_e: unknown, data: string) => callback(data);
            ipcRenderer.on('kovix:mc:milestone-failed', listener);
            return () => ipcRenderer.removeListener('kovix:mc:milestone-failed', listener);
        },
        onLLMText: (callback: (text: string) => void) => {
            const listener = (_e: unknown, data: string) => callback(data);
            ipcRenderer.on('kovix:mc:llm-text', listener);
            return () => ipcRenderer.removeListener('kovix:mc:llm-text', listener);
        },
        onToolCall: (callback: (payload: { callId: string; name: string; args: unknown }) => void) => {
            const listener = (_e: unknown, data: unknown) => callback(data as { callId: string; name: string; args: unknown });
            ipcRenderer.on('kovix:mc:tool-call', listener);
            return () => ipcRenderer.removeListener('kovix:mc:tool-call', listener);
        },
        onToolResult: (callback: (payload: { callId: string; result: { ok: boolean; output: string } }) => void) => {
            const listener = (_e: unknown, data: unknown) => callback(data as { callId: string; result: { ok: boolean; output: string } });
            ipcRenderer.on('kovix:mc:tool-result', listener);
            return () => ipcRenderer.removeListener('kovix:mc:tool-result', listener);
        },
        onApprovalRequired: (callback: (payload: { callId: string; name: string; args: unknown }) => void) => {
            const listener = (_e: unknown, data: unknown) => callback(data as { callId: string; name: string; args: unknown });
            ipcRenderer.on('kovix:mc:approval-required', listener);
            return () => ipcRenderer.removeListener('kovix:mc:approval-required', listener);
        },
        onFileTree: (callback: (entries: string[]) => void) => {
            const listener = (_e: unknown, data: string[]) => callback(data);
            ipcRenderer.on('kovix:mc:file-tree', listener);
            return () => ipcRenderer.removeListener('kovix:mc:file-tree', listener);
        },
        onComplete: (callback: (result: { ok: boolean; error?: string; plan?: unknown[] }) => void) => {
            const listener = (_e: unknown, data: unknown) => callback(data as { ok: boolean; error?: string; plan?: unknown[] });
            ipcRenderer.on('kovix:mc:complete', listener);
            return () => ipcRenderer.removeListener('kovix:mc:complete', listener);
        },
    },
});
