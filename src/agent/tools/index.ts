/**
 * Tool implementations for the agent.
 *
 * REWRITES FROM VS CODE FORK:
 *   In the original, tools were a giant `switch` statement inside
 *   AgentLoopService.executeTool() that called `this.mcpProcess.readFile()`,
 *   `this.pendingChanges.stageFile()`, `this.terminalExecutor.execute()`,
 *   `this.commandService.executeCommand('kovix.executeTool', ...)`, etc.
 *   The `mcpProcess` was a VS Code IFileService-backed wrapper that also
 *   spawned an external MCP filesystem server over JSON-RPC.
 *
 *   Here, each tool is a standalone async function that takes plain inputs
 *   and returns a string (the LLM-facing result). They use Node's `fs.promises`
 *   and `child_process.execFile` directly. No MCP server, no IPC, no DI.
 *
 *   Tools that modify files (write_file, edit_file) go through PendingChanges
 *   (the staging layer) — never write to disk directly. This preserves the
 *   core "stage before write" product principle.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    assertWithinWorkspace,
    isBlockedCommand,
    isInterpreterCommand,
    isCommandInAllowlist,
    TerminalRateLimiter,
    sanitiseForAuditLog,
    detectShellMetacharInArgs,
    PromptSanitiser,
    redactSecrets,
} from '../security/index.js';
import type { PendingChanges } from '../staging/pendingChanges.js';
import type { IToolDefinition } from '../llm/types.js';

const execFileAsync = promisify(execFile);

// ----------------------------------------------------------------------
// Tool definitions (LLM-facing schema)
// ----------------------------------------------------------------------

export const TOOL_DEFINITIONS: IToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Read the contents of a file. Returns the file content as a string.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file relative to workspace root' },
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: "Write content to a file. Creates the file and parent directories if they don't exist. The write is STAGED — it will not hit disk until the user approves it in the diff review.",
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file relative to workspace root' },
                content: { type: 'string', description: 'Full content to write to the file' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'list_directory',
        description: 'List the contents of a directory. Returns file and directory names, one per line.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the directory relative to workspace root (default: ".")' },
            },
            required: [],
        },
    },
    {
        name: 'create_directory',
        description: 'Create a directory, including any necessary parent directories.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the directory relative to workspace root' },
            },
            required: ['path'],
        },
    },
    {
        name: 'edit_file',
        description: 'Apply an edit to an existing file. Pass the FULL new content of the file (not a diff). The edit is STAGED — it will not hit disk until the user approves it in the diff review.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file relative to workspace root' },
                diff: { type: 'string', description: 'Full new content of the file (or a unified diff)' },
            },
            required: ['path', 'diff'],
        },
    },
    {
        name: 'run_command',
        description: 'Run a shell command in the workspace. Returns stdout, stderr, and exit code. Commands on the interpreter allowlist (node, python, npx, npm, curl, etc.) require interactive user approval before running.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
            },
            required: ['command'],
        },
    },
    {
        name: 'search_codebase',
        description: 'Search the codebase for a text pattern. Returns matching file paths and line numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text or regex pattern to search for' },
                maxResults: { type: 'number', description: 'Maximum number of matches to return (default: 20)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'web_search',
        description: 'Search the web for information. Only available when online mode is enabled.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                num: { type: 'number', description: 'Number of results (default: 10)' },
            },
            required: ['query'],
        },
    },
];

// ----------------------------------------------------------------------
// Tool execution context
// ----------------------------------------------------------------------

export interface ToolContext {
    workspaceRoot: string;
    pendingChanges: PendingChanges;
    rateLimiter: TerminalRateLimiter;
    /** Optional: callback fired when an interpreter command is about to run.
     * Return true to approve, false to reject. If omitted, interpreter
     * commands are blocked. */
    approveInterpreterCommand?: (command: string, cwd?: string) => Promise<boolean>;
    /** Optional: logger. */
    log?: (message: string) => void;
    /** Whether web_search is enabled. Default false (offline-first). */
    onlineMode?: boolean;
}

export interface ToolResult {
    output: string;
    success: boolean;
}

// ----------------------------------------------------------------------
// Individual tool implementations
// ----------------------------------------------------------------------

export async function readFileTool(args: { path: string }, ctx: ToolContext): Promise<ToolResult> {
    if (!args.path) {
        return { output: 'Error: path is required', success: false };
    }
    try {
        assertWithinWorkspace(args.path, ctx.workspaceRoot);
        const abs = path.resolve(ctx.workspaceRoot, args.path);
        const content = await fs.readFile(abs, 'utf8');
        // SEC-6: Sanitise file content before injecting into LLM context
        return { output: PromptSanitiser.sanitise(content), success: true };
    } catch (err) {
        return { output: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, success: false };
    }
}

export async function writeFileTool(args: { path: string; content: string }, ctx: ToolContext, readOnly: boolean): Promise<ToolResult> {
    if (readOnly) {
        return { output: 'Error: write_file not available during planning phase', success: false };
    }
    if (!args.path || args.content === undefined) {
        return { output: 'Error: path and content are required', success: false };
    }
    try {
        assertWithinWorkspace(args.path, ctx.workspaceRoot);
        await ctx.pendingChanges.stageFile(args.path, args.content);
        return { output: `File change staged: ${args.path}. Review and accept/reject in diff view.`, success: true };
    } catch (err) {
        return { output: `Error staging file: ${err instanceof Error ? err.message : String(err)}`, success: false };
    }
}

export async function listDirectoryTool(args: { path?: string }, ctx: ToolContext): Promise<ToolResult> {
    const relPath = args.path ?? '.';
    try {
        if (relPath !== '.') {
            assertWithinWorkspace(relPath, ctx.workspaceRoot);
        }
        const abs = path.resolve(ctx.workspaceRoot, relPath);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const names = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).sort();
        return { output: PromptSanitiser.sanitise(names.join('\n')), success: true };
    } catch (err) {
        return { output: `Error listing directory: ${err instanceof Error ? err.message : String(err)}`, success: false };
    }
}

export async function createDirectoryTool(args: { path: string }, ctx: ToolContext, readOnly: boolean): Promise<ToolResult> {
    if (readOnly) {
        return { output: 'Error: create_directory not available during planning phase', success: false };
    }
    if (!args.path) {
        return { output: 'Error: path is required', success: false };
    }
    try {
        assertWithinWorkspace(args.path, ctx.workspaceRoot);
        const abs = path.resolve(ctx.workspaceRoot, args.path);
        await fs.mkdir(abs, { recursive: true });
        return { output: `Directory created: ${args.path}`, success: true };
    } catch (err) {
        return { output: `Error creating directory: ${err instanceof Error ? err.message : String(err)}`, success: false };
    }
}

export async function editFileTool(args: { path: string; diff: string }, ctx: ToolContext, readOnly: boolean): Promise<ToolResult> {
    if (readOnly) {
        return { output: 'Error: edit_file not available during planning phase', success: false };
    }
    if (!args.path || !args.diff) {
        return { output: 'Error: path and diff are required', success: false };
    }
    try {
        assertWithinWorkspace(args.path, ctx.workspaceRoot);
        await ctx.pendingChanges.stageEdit(args.path, args.diff);
        return { output: `Edit staged: ${args.path}. Review and accept/reject in diff view.`, success: true };
    } catch (err) {
        return { output: `Error staging edit: ${err instanceof Error ? err.message : String(err)}`, success: false };
    }
}

export async function runCommandTool(args: { command: string; cwd?: string }, ctx: ToolContext, readOnly: boolean): Promise<ToolResult> {
    if (readOnly) {
        return { output: 'Error: run_command not available during planning phase', success: false };
    }
    if (!args.command) {
        return { output: 'Error: command is required', success: false };
    }

    const command = args.command;
    const cwd = args.cwd;

    // Security: blocklist
    if (isBlockedCommand(command)) {
        ctx.log?.(`[Terminal] Blocked dangerous command: ${sanitiseForAuditLog(command).substring(0, 80)}`);
        return { output: 'Error: Command blocked by security policy', success: false };
    }

    // Security: rate limit
    if (!ctx.rateLimiter.canExecute()) {
        return { output: 'Error: Terminal rate limit exceeded — too many commands', success: false };
    }

    // Security: interpreter command approval gate
    if (isInterpreterCommand(command)) {
        if (!ctx.approveInterpreterCommand) {
            return { output: 'Error: Interpreter command requires approval but no approval callback is registered.', success: false };
        }
        const approved = await ctx.approveInterpreterCommand(command, cwd);
        if (!approved) {
            ctx.log?.(`[Terminal] User declined interpreter command: ${command}`);
            return {
                output: 'Error: user declined to run this command. Re-plan without invoking an interpreter, or ask the user to run it manually.',
                success: false,
            };
        }
        ctx.log?.(`[Terminal] User approved interpreter command: ${command}`);
    }

    ctx.rateLimiter.recordExecution();
    ctx.log?.(`[Terminal] Executing: ${sanitiseForAuditLog(command).substring(0, 100)}`);

    try {
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
        const workingDir = cwd ? path.resolve(ctx.workspaceRoot, cwd) : ctx.workspaceRoot;

        const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
            cwd: workingDir,
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024,
        });

        let output = '';
        if (stdout) { output += stdout; }
        if (stderr) { output += (output ? '\n' : '') + stderr; }
        // SEC-6 + SEC-7: sanitise + redact before returning to LLM
        return { output: PromptSanitiser.sanitise(redactSecrets(output || '(no output)')), success: true };
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string };
        let output = '';
        if (e.stdout) { output += e.stdout; }
        if (e.stderr) { output += (output ? '\n' : '') + e.stderr; }
        const exitCode = typeof e.code === 'number' ? e.code : 1;
        output += `\nExit code: ${exitCode}`;
        return { output: PromptSanitiser.sanitise(redactSecrets(output)), success: false };
    }
}

export async function searchCodebaseTool(args: { query: string; maxResults?: number }, ctx: ToolContext): Promise<ToolResult> {
    if (!args.query) {
        return { output: 'Error: query is required', success: false };
    }
    const maxResults = args.maxResults ?? 20;
    try {
        // Simple grep-based search. The VS Code fork used a Qdrant vector store
        // for semantic search; that's overkill for the standalone build.
        // We'll add vector search back if/when the user wants it.
        const results = await grepWorkspace(ctx.workspaceRoot, args.query, maxResults);
        if (results.length === 0) {
            return { output: `No matches found for "${args.query}"`, success: true };
        }
        const formatted = results.map(r => `${r.file}:${r.line}: ${r.text}`).join('\n');
        return { output: PromptSanitiser.sanitise(formatted), success: true };
    } catch (err) {
        return { output: `Error searching codebase: ${err instanceof Error ? err.message : String(err)}`, success: false };
    }
}

export async function webSearchTool(args: { query: string; num?: number }, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.onlineMode) {
        return { output: 'Error: Web search unavailable. Enable online mode in settings.', success: false };
    }
    if (!args.query) {
        return { output: 'Error: query is required', success: false };
    }
    // Stub — the VS Code fork delegated to an MCP server for this.
    // For the standalone build, the agent can use `run_command` with curl
    // to hit a search API, or we'll wire up a real search provider later.
    return {
        output: `Error: Web search not yet wired up in standalone build. Use run_command with curl to hit a search API directly.`,
        success: false,
    };
}

// ----------------------------------------------------------------------
// Tool dispatcher
// ----------------------------------------------------------------------

export async function executeTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
    readOnly: boolean,
): Promise<ToolResult> {
    const args = input as { path?: string; content?: string; diff?: string; command?: string; cwd?: string; query?: string; maxResults?: number; num?: number };
    switch (name) {
        case 'read_file':        return readFileTool({ path: args.path ?? '' }, ctx);
        case 'write_file':       return writeFileTool({ path: args.path ?? '', content: args.content ?? '' }, ctx, readOnly);
        case 'list_directory':   return listDirectoryTool({ path: args.path }, ctx);
        case 'create_directory': return createDirectoryTool({ path: args.path ?? '' }, ctx, readOnly);
        case 'edit_file':        return editFileTool({ path: args.path ?? '', diff: args.diff ?? '' }, ctx, readOnly);
        case 'run_command':      return runCommandTool({ command: args.command ?? '', cwd: args.cwd }, ctx, readOnly);
        case 'search_codebase':  return searchCodebaseTool({ query: args.query ?? '', maxResults: args.maxResults }, ctx);
        case 'web_search':       return webSearchTool({ query: args.query ?? '', num: args.num }, ctx);
        default:
            return { output: `Error: Unknown tool: ${name}`, success: false };
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

interface GrepMatch {
    file: string;
    line: number;
    text: string;
}

async function grepWorkspace(root: string, pattern: string, maxResults: number): Promise<GrepMatch[]> {
    // Use the system `grep -rn` if available; fall back to a JS implementation.
    // For Phase 0, we'll just try grep and bail if it's not there.
    try {
        const { stdout } = await execFileAsync('grep', ['-rn', '--include=*.*', pattern, root], {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30_000,
        });
        const lines = stdout.split('\n').filter(Boolean).slice(0, maxResults);
        return lines.map(line => {
            const match = line.match(/^([^:]+):(\d+):(.*)$/);
            if (match) {
                return { file: match[1], line: parseInt(match[2], 10), text: match[3] };
            }
            return { file: '', line: 0, text: line };
        });
    } catch {
        return [];
    }
}

// Re-export detectShellMetacharInArgs so callers can use it for arg validation
export { detectShellMetacharInArgs, isCommandInAllowlist };
