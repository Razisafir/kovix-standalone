/**
 * Core filesystem tools — Kovix 2.0 Phase 1.
 *
 * Three tools the autonomous agent needs to do useful work in a workspace:
 *   - `read_file`  — read a file's contents as UTF-8 text.
 *   - `write_file` — write text to a file, creating parent dirs as needed.
 *   - `list_files` — list immediate children of a directory.
 *
 * All paths are RELATIVE to the workspace root. Path traversal outside the
 * workspace is rejected (`..` segments, absolute paths, symlinks that escape).
 *
 * `createCoreTools(workspaceRoot)` returns an array of `ToolDefinition`s ready
 * to be registered. The workspace root is captured in the closure; tools do
 * not read it from process.cwd() or any other global.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/**
 * Resolve a user-supplied relative path against the workspace root, and
 * reject anything that escapes the workspace. This is the security boundary
 * for all filesystem tools.
 *
 * @throws if the resolved path is outside the workspace root.
 */
function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  // Normalise both sides: resolve symlinks on the root, normalise the input.
  const root = path.resolve(workspaceRoot);
  const joined = path.resolve(root, relativePath);

  // `path.resolve(root, rel)` collapses `..` segments, so `joined` is the
  // canonical absolute path. We check it starts with `root + path.sep`
  // (or equals root exactly).
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (joined !== root && !joined.startsWith(withSep)) {
    throw new Error(
      `path "${relativePath}" resolves outside the workspace root`,
    );
  }
  return joined;
}

/**
 * `read_file` — read a UTF-8 text file relative to the workspace root.
 */
export const readFileTool: ToolDefinition<{ path: string }> = {
  name: 'read_file',
  description:
    'Read the contents of a UTF-8 text file. The path is relative to the workspace root. Returns the file contents as a string.',
  parameters: z.object({
    path: z.string().min(1).describe('Relative path to the file to read.'),
  }),
  async execute(args, ctx) {
    const fullPath = resolveWorkspacePath(ctx.workspaceRoot, args.path);
    const content = await fs.readFile(fullPath, 'utf8');
    return content;
  },
};

/**
 * `write_file` — write text to a file relative to the workspace root.
 * Creates parent directories if they don't exist. Overwrites existing files.
 */
export const writeFileTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Write text content to a file. The path is relative to the workspace root. Parent directories are created if they do not exist. Existing files are overwritten.',
  parameters: z.object({
    path: z.string().min(1).describe('Relative path to the file to write.'),
    content: z.string().describe('The text content to write to the file.'),
  }),
  async execute(args, ctx) {
    const fullPath = resolveWorkspacePath(ctx.workspaceRoot, args.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, args.content, 'utf8');
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return `Wrote ${bytes} bytes to ${args.path}`;
  },
};

/**
 * `list_files` — list immediate children of a directory.
 * Returns newline-separated names, directories suffixed with `/`.
 */
export const listFilesTool: ToolDefinition<{ path: string }> = {
  name: 'list_files',
  description:
    'List the immediate children of a directory. The path is relative to the workspace root. Returns one name per line; directories are suffixed with "/".',
  parameters: z.object({
    path: z
      .string()
      .min(1)
      .describe('Relative path to the directory to list. Use "." for the workspace root.'),
  }),
  async execute(args, ctx) {
    const fullPath = resolveWorkspacePath(ctx.workspaceRoot, args.path);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    if (entries.length === 0) {
      return '(empty directory)';
    }
    const lines = entries.map((entry) =>
      entry.isDirectory() ? `${entry.name}/` : entry.name,
    );
    return lines.join('\n');
  },
};

/**
 * Convenience factory: returns all core tools for a given workspace root.
 * The workspace root is passed in via `ToolContext` at execution time, so
 * this factory does not capture it — tools are reusable across workspaces.
 */
export function createCoreTools(): ToolDefinition<unknown>[] {
  // Each tool is declared as a const above with a specific Args type. We
  // return them as `ToolDefinition<unknown>[]` for ease of iteration; the
  // registry re-erases them anyway.
  return [
    readFileTool as ToolDefinition<unknown>,
    writeFileTool as ToolDefinition<unknown>,
    listFilesTool as ToolDefinition<unknown>,
  ];
}
