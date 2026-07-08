/**
 * Terminal execution security helpers.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/terminal/terminalExecutor.ts
 * (interface + pure-logic helpers only — the actual executor lives in tools/runCommand.ts).
 *
 * NO logic changes. Only stripped the VS Code `createDecorator` import + the
 * ITerminalExecutor interface (we'll define a leaner one inline in the tool).
 */

export interface ITerminalExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * SEC-3: Shell metacharacters that could chain commands.
 */
export const SHELL_METACHAR_BLOCKLIST = [
    ';', '&&', '||', '|', '`', '$(', ')', '{', '}', '>>', '>', '<', '2>',
];

const SHELL_METACHAR_REGEX = /;|&&|\|\||\||`|\$\(|\{|}|\d*>|</;

/**
 * SEC-7 (H4 fix): Default allowlist for restricted mode.
 * Interpreters (node, python, npm, etc.) intentionally removed — they can
 * execute arbitrary code via crafted arguments and bypass the metachar detector.
 */
export const DEFAULT_COMMAND_ALLOWLIST: string[] = [
    'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc',
    'echo', 'pwd', 'whoami', 'which', 'where', 'env', 'printenv',
    'mkdir', 'touch', 'cp', 'mv',
    'sed', 'awk', 'sort', 'uniq', 'diff', 'patch',
    'git',
    'docker', 'podman', 'kubectl',
    'jest', 'vitest', 'mocha', 'eslint', 'prettier',
];

export const INTERPRETER_COMMANDS: ReadonlySet<string> = new Set([
    'node', 'python', 'python3', 'pip', 'pip3',
    'npx', 'npm', 'yarn', 'pnpm',
    'cargo', 'rustc', 'go', 'dotnet',
    'java', 'javac', 'mvn', 'gradle',
    'make', 'cmake', 'gcc', 'g++', 'clang',
    'tsc', 'sh', 'bash', 'zsh', 'fish',
    'curl', 'wget',
    'docker', 'podman', 'kubectl',
]);

export function isInterpreterCommand(command: string): boolean {
    const baseCommand = command.trim().split(/\s+/)[0];
    const commandName = baseCommand.split('/').pop() ?? baseCommand;
    return INTERPRETER_COMMANDS.has(commandName);
}

export const TERMINAL_RATE_LIMIT = {
    maxCommands: 10,
    windowMs: 30_000,
};

const SECRET_LOG_PATTERNS = [
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /nvapi-[A-Za-z0-9_-]{20,}/g,
    /gsk_[A-Za-z0-9]{20,}/g,
    /ghp_[A-Za-z0-9]{20,}/g,
    /gho_[A-Za-z0-9]{20,}/g,
    /ghs_[A-Za-z0-9]{20,}/g,
    /glpat-[A-Za-z0-9_-]{20,}/g,
    /xox[bpoa]-[A-Za-z0-9-]{10,}/g,
    /Bearer\s+[A-Za-z0-9_.-]{20,}/g,
    /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{16,}/gi,
    /(?:password|passwd|pwd)=[^\s'"]+/gi,
    /(?:token|apikey|api_key|secret|credential|access_key|secret_key)=[^\s'"]+/gi,
    /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)=[^\s'"]+/g,
    /\b[a-f0-9]{32,}\b/gi,
    /\b[A-Za-z0-9_-]{40,}\b/g,
];

export function sanitiseForAuditLog(text: string): string {
    let result = text;
    for (const pattern of SECRET_LOG_PATTERNS) {
        result = result.replace(pattern, '[REDACTED]');
    }
    return result;
}

export function detectShellMetacharInArgs(args: string): string | null {
    const match = args.match(SHELL_METACHAR_REGEX);
    return match ? match[0] : null;
}

export function isCommandInAllowlist(command: string, allowlist?: string[]): boolean {
    const list = allowlist ?? DEFAULT_COMMAND_ALLOWLIST;
    const baseCommand = command.trim().split(/\s+/)[0];
    const commandName = baseCommand.split('/').pop() ?? baseCommand;
    return list.some(allowed => commandName === allowed);
}

/**
 * SEC-3: Rate limiter for terminal command execution.
 * Tracks command timestamps per session.
 */
export class TerminalRateLimiter {
    private commandTimestamps: number[] = [];

    canExecute(): boolean {
        const now = Date.now();
        const windowStart = now - TERMINAL_RATE_LIMIT.windowMs;
        this.commandTimestamps = this.commandTimestamps.filter(ts => ts > windowStart);
        return this.commandTimestamps.length < TERMINAL_RATE_LIMIT.maxCommands;
    }

    recordExecution(): void {
        this.commandTimestamps.push(Date.now());
    }

    remainingCommands(): number {
        const now = Date.now();
        const windowStart = now - TERMINAL_RATE_LIMIT.windowMs;
        this.commandTimestamps = this.commandTimestamps.filter(ts => ts > windowStart);
        return Math.max(0, TERMINAL_RATE_LIMIT.maxCommands - this.commandTimestamps.length);
    }
}

/**
 * Dangerous-command blocklist. Same patterns as the original
 * TerminalNodeService.isBlocked().
 */
const DANGEROUS_PATTERNS: RegExp[] = [
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root\s+)(\/|[A-Z]:\\)/i,
    /\bsudo\s+/i,
    /\bcurl\b.*\|\s*(ba)?sh/i,
    /\bwget\b.*\|\s*(ba)?sh/i,
    /\bmkfs\b/i,
    /\bdd\s+.*of=\/dev\//i,
    /\bchmod\s+(777|666)\s+\//i,
    /\b:()\s*\{.*;\s*\}/, // fork bomb
    />\/etc\//i,
];

export function isBlockedCommand(command: string): boolean {
    return DANGEROUS_PATTERNS.some(p => p.test(command));
}
