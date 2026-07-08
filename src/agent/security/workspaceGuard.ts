/**
 * SEC-4: Workspace boundary validation to prevent path traversal.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/security/workspaceGuard.ts
 *
 * CHANGE FROM VS CODE FORK:
 *   - The original accepted either a string workspaceRoot OR a VS Code
 *     IWorkspaceContextService. We only accept a string (the configured
 *     working directory). The IWorkspaceContextService branch is gone.
 *   - The original imported VS Code's browser-safe path shim
 *     (vs/base/common/path.js). We import node:path directly, which has
 *     identical semantics for the operations used here.
 */

import * as path from 'node:path';

/**
 * Assert that a path is within the workspace boundary.
 * Throws an error if the resolved absolute path escapes the workspace root.
 */
export function assertWithinWorkspace(
    filePath: string,
    workspaceRoot?: string,
): void {
    const normalized = path.normalize(filePath);
    if (normalized.includes('..')) {
        throw new Error(`Path traversal not allowed: "${filePath}"`);
    }

    if (workspaceRoot) {
        const root = path.resolve(workspaceRoot);

        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(root, filePath);

        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
            throw new Error(`Security: path "${resolved}" is outside workspace "${root}"`);
        }
    } else {
        // No workspace root provided - reject absolute paths as a safety measure
        if (path.isAbsolute(filePath)) {
            throw new Error(`Absolute paths require a workspace context: "${filePath}"`);
        }
    }
}

/**
 * Validate that a tool name is in the allowed set.
 */
export function validateToolName(name: string): boolean {
    const ALLOWED_TOOLS = new Set([
        'read_file', 'write_file', 'edit_file', 'list_directory',
        'create_directory', 'search_files', 'run_command',
        'search_codebase', 'web_search',
    ]);
    return ALLOWED_TOOLS.has(name);
}
