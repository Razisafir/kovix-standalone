/**
 * Preload - exposes a minimal `kovixAPI` to the renderer.
 *
 * The renderer (placeholder HTML for Phase 0) calls these to talk to the
 * agent core in the main process. contextIsolation is on, so the renderer
 * has no direct Node access - it goes through this bridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kovixAPI', {
    plan: (task: string) => ipcRenderer.invoke('kovix:plan', task),
    execute: (task: string, onEvent: (event: unknown) => void) => {
        const listener = (_event: unknown, data: unknown) => onEvent(data);
        ipcRenderer.on('kovix:event', listener);
        return ipcRenderer.invoke('kovix:execute', task).finally(() => {
            ipcRenderer.removeListener('kovix:event', listener);
        });
    },
});
