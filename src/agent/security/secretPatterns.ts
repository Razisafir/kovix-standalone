/**
 * SEC-5 / K2-M4: Canonical secret-pattern registry.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/security/secretPatterns.ts
 * with NO logic changes — only the import paths were stripped (this file has no
 * imports). Single source of truth for every secret-redaction pattern in Kovix.
 *
 * Patterns are ordered roughly longest-match-first to minimise partial
 * redactions. Every pattern is GLOBAL (the `g` flag) so `String.replace`
 * redacts all occurrences in one pass. Callers that re-use the regex object
 * MUST reset `lastIndex = 0` between calls (the `redactSecrets()` helper
 * does this).
 */

export interface SecretPattern {
    /** Human-readable name for telemetry / audit logs. */
    name: string;
    /** Global regex. MUST include the `g` flag. */
    pattern: RegExp;
    /** Optional description for the audit docs. */
    description?: string;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
    { name: 'anthropic',             pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,                                       description: 'Anthropic Claude API key' },
    { name: 'openai',                pattern: /sk-[A-Za-z0-9]{20,}/g,                                            description: 'OpenAI API key (covers sk-proj-, sk-svcacct-, etc.)' },
    { name: 'nvidia_nim',            pattern: /nvapi-[A-Za-z0-9_-]{20,}/g,                                       description: 'NVIDIA NIM API key' },
    { name: 'groq',                  pattern: /gsk_[A-Za-z0-9]{20,}/g,                                           description: 'Groq API key' },
    { name: 'google_ai',             pattern: /AIza[0-9A-Za-z_-]{35,}/g,                                         description: 'Google AI Studio API key' },
    { name: 'github_pat',            pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,                                     description: 'GitHub PAT' },
    { name: 'github_legacy_token',   pattern: /\bghp_[A-Za-z0-9]{36}\b/g,                                        description: 'GitHub classic PAT' },
    { name: 'gitlab_pat',            pattern: /glpat-[A-Za-z0-9_-]{20,}/g,                                       description: 'GitLab PAT' },
    { name: 'slack_token',           pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g,                                   description: 'Slack token' },
    { name: 'authorization_basic',   pattern: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{16,}/gi,                  description: 'HTTP Basic auth header' },
    { name: 'authorization_bearer',  pattern: /Bearer\s+[A-Za-z0-9_.-]{20,}/g,                                   description: 'HTTP Bearer token' },
    { name: 'qs_password',           pattern: /[?&]password=\S+/gi,                                              description: 'password= query parameter' },
    { name: 'qs_token',              pattern: /[?&]token=\S+/gi,                                                 description: 'token= query parameter' },
    { name: 'qs_key',                pattern: /[?&]key=\S+/gi,                                                   description: 'key= query parameter' },
    { name: 'qs_api_key',            pattern: /[?&]api_key=\S+/gi,                                               description: 'api_key= query parameter' },
    { name: 'qs_access_token',       pattern: /[?&]access_token=\S+/gi,                                          description: 'access_token= query parameter' },
    { name: 'hex_32plus',            pattern: /\b[0-9a-fA-F]{32,}\b/g,                                           description: '32+ hex chars (MD5/SHA prefix, opaque token)' },
    { name: 'upper_env_secret',      pattern: /\b[A-Z][A-Z0-9_]{6,}(?:SECRET|TOKEN|KEY|PASSWORD|PASS|CRED|CREDENTIALS)[A-Z0-9_]*=\S+/g, description: 'UPPER_CASE env var holding a secret' },
];

export function resetSecretPatterns(): void {
    for (const sp of SECRET_PATTERNS) {
        sp.pattern.lastIndex = 0;
    }
}

export function redactSecrets(input: string): string {
    if (!input || typeof input !== 'string') {
        return input;
    }
    resetSecretPatterns();
    let result = input;
    for (const sp of SECRET_PATTERNS) {
        result = result.replace(sp.pattern, `[REDACTED:${sp.name}]`);
    }
    return result;
}

export function listSecretPatternNames(): string[] {
    return SECRET_PATTERNS.map(sp => sp.name);
}
