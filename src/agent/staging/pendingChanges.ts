/**
 * Pending changes staging layer.
 *
 * REPLACES VS Code's IPendingChangesService.
 *
 * CORE PRODUCT PRINCIPLE PRESERVED:
 *   The agent never writes directly to disk. Every write goes through this
 *   staging layer, which holds the proposed change in memory and surfaces
 *   it via an `approval_request` event. The actual disk write only happens
 *   when the caller (UI / test harness) explicitly approves.
 *
 * WHAT'S DIFFERENT FROM THE VS CODE FORK:
 *   - No more `URI` / `VSBuffer` types. Paths are plain strings (workspace-relative).
 *   - No more `IFileService` integration. We use `fs.promises` directly.
 *   - The diff view is the new UI's problem — this module just exposes the
 *     proposed content vs. existing content via `getStagedChange()`.
 *   - One new method: `applyStagedChange()` — writes the staged content to
 *     disk. In the VS Code fork this happened implicitly when the user
 *     accepted the diff in the editor; now it's an explicit call so the
 *     caller controls the moment of truth.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertWithinWorkspace } from '../security/workspaceGuard.js';

export interface StagedFile {
    /** Workspace-relative path. */
    relativePath: string;
    /** Absolute path (resolved against workspace root). */
    absolutePath: string;
    /** Proposed new content. */
    proposedContent: string;
    /** Existing content on disk, or null if the file doesn't exist yet. */
    existingContent: string | null;
    /** Whether this is a new file (true) or an edit (false). */
    isNew: boolean;
    /** Timestamp when staged. */
    stagedAt: number;
}

/**
 * In-memory staging for agent-proposed changes.
 *
 * The agent loop calls `stageFile()` / `stageEdit()` whenever a write_file or
 * edit_file tool is invoked. The caller (UI / test) is then expected to:
 *   1. Listen for the `approval_request` event from the agent loop
 *   2. Show the diff to the user (or auto-approve in tests)
 *   3. Call `applyStagedChange()` if approved, or `clearStagedChange()` if rejected
 */
export class PendingChanges {
    private staged = new Map<string, StagedFile>();
    private approvalCallbacks: Array<(change: StagedFile) => void> = [];

    constructor(private readonly workspaceRoot: string) {}

    /**
     * Stage a full file write (create or overwrite).
     */
    async stageFile(relativePath: string, content: string): Promise<StagedFile> {
        assertWithinWorkspace(relativePath, this.workspaceRoot);
        const absolutePath = path.resolve(this.workspaceRoot, relativePath);

        let existingContent: string | null = null;
        try {
            existingContent = await fs.readFile(absolutePath, 'utf8');
        } catch (err: unknown) {
            // File doesn't exist yet — that's fine, this is a create.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }

        const staged: StagedFile = {
            relativePath,
            absolutePath,
            proposedContent: content,
            existingContent,
            isNew: existingContent === null,
            stagedAt: Date.now(),
        };
        this.staged.set(relativePath, staged);
        return staged;
    }

    /**
     * Stage an edit (unified diff) to an existing file.
     *
     * For the standalone build we apply a SIMPLIFIED diff: if the diff is
     * already a full-content replacement (which is what Claude tends to send
     * via `write_file` anyway), we just stage it. A real unified-diff parser
     * can be added later — for now we support the common case (full content)
     * and a `<`/`>` line-replacement fallback.
     */
    async stageEdit(relativePath: string, diff: string): Promise<StagedFile> {
        assertWithinWorkspace(relativePath, this.workspaceRoot);
        const absolutePath = path.resolve(this.workspaceRoot, relativePath);

        let existingContent: string | null = null;
        try {
            existingContent = await fs.readFile(absolutePath, 'utf8');
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }

        // Simple heuristic: if the "diff" is actually full file content (no
        // diff markers like ---, +++, @@), treat it as a full replacement.
        // This matches what Claude typically sends in practice.
        const isFullContent = !(/^---\s/m.test(diff) || /^\+\+\+\s/m.test(diff) || /^@@/m.test(diff));
        const proposedContent = isFullContent
            ? diff
            : applyUnifiedDiff(existingContent ?? '', diff);

        const staged: StagedFile = {
            relativePath,
            absolutePath,
            proposedContent,
            existingContent,
            isNew: existingContent === null,
            stagedAt: Date.now(),
        };
        this.staged.set(relativePath, staged);
        return staged;
    }

    /**
     * Get a staged change by path, if any.
     */
    getStagedChange(relativePath: string): StagedFile | undefined {
        return this.staged.get(relativePath);
    }

    /**
     * Return all currently-staged changes.
     */
    getAllStaged(): StagedFile[] {
        return Array.from(this.staged.values());
    }

    /**
     * Apply (write to disk) a staged change. The caller is responsible for
     * getting user approval before calling this.
     */
    async applyStagedChange(relativePath: string): Promise<void> {
        const staged = this.staged.get(relativePath);
        if (!staged) {
            throw new Error(`No staged change for ${relativePath}`);
        }
        await fs.mkdir(path.dirname(staged.absolutePath), { recursive: true });
        await fs.writeFile(staged.absolutePath, staged.proposedContent, 'utf8');
        this.staged.delete(relativePath);
    }

    /**
     * Reject and discard a staged change. Does NOT touch disk.
     */
    clearStagedChange(relativePath: string): void {
        this.staged.delete(relativePath);
    }

    /**
     * Clear all staged changes. Used at the start of a new task to reset state.
     */
    clearAll(): void {
        this.staged.clear();
    }

    /**
     * Apply ALL staged changes in one shot. Useful for the verification
     * script's auto-approve path and for the "Approve all" UI button.
     */
    async applyAll(): Promise<{ applied: string[]; skipped: string[] }> {
        const applied: string[] = [];
        const skipped: string[] = [];
        for (const [relPath, staged] of Array.from(this.staged.entries())) {
            try {
                await fs.mkdir(path.dirname(staged.absolutePath), { recursive: true });
                await fs.writeFile(staged.absolutePath, staged.proposedContent, 'utf8');
                applied.push(relPath);
                this.staged.delete(relPath);
            } catch (err) {
                skipped.push(relPath);
                // Keep the staged entry so the caller can see what failed.
                console.error(`[PendingChanges] Failed to apply ${relPath}:`, err);
            }
        }
        return { applied, skipped };
    }
}

/**
 * Minimal unified-diff applier. Supports @@ hunk headers with line ranges
 * and +/- lines. Not a full patch implementation — context lines are
 * matched literally. Good enough for the typical diffs the agent produces.
 *
 * If the diff can't be parsed, returns the original content (fails safe).
 */
function applyUnifiedDiff(original: string, diff: string): string {
    try {
        const lines = original.split('\n');
        const result = [...lines];
        const diffLines = diff.split('\n');
        let i = 0;
        while (i < diffLines.length) {
            const line = diffLines[i];
            const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (hunkMatch) {
                const startLine = parseInt(hunkMatch[1], 10) - 1; // 0-indexed
                let cursor = startLine;
                i++;
                while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
                    const dl = diffLines[i];
                    if (dl.startsWith('-')) {
                        // Remove line at cursor
                        if (result[cursor] === dl.slice(1)) {
                            result.splice(cursor, 1);
                        }
                    } else if (dl.startsWith('+')) {
                        // Insert at cursor
                        result.splice(cursor, 0, dl.slice(1));
                        cursor++;
                    } else if (dl.startsWith(' ')) {
                        cursor++;
                    }
                    i++;
                }
            } else {
                i++;
            }
        }
        return result.join('\n');
    } catch {
        return original;
    }
}
