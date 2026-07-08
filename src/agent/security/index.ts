/**
 * Re-export barrel for the security layer.
 */
export {
    SECRET_PATTERNS,
    redactSecrets,
    resetSecretPatterns,
    listSecretPatternNames,
    type SecretPattern,
} from './secretPatterns.js';

export {
    sanitise,
    sanitiseMultiple,
    PromptSanitiser,
} from './promptSanitiser.js';

export {
    assertWithinWorkspace,
    validateToolName,
} from './workspaceGuard.js';

export {
    SHELL_METACHAR_BLOCKLIST,
    DEFAULT_COMMAND_ALLOWLIST,
    INTERPRETER_COMMANDS,
    isInterpreterCommand,
    TERMINAL_RATE_LIMIT,
    sanitiseForAuditLog,
    detectShellMetacharInArgs,
    isCommandInAllowlist,
    TerminalRateLimiter,
    isBlockedCommand,
    type ITerminalExecResult,
} from './terminalSecurity.js';
