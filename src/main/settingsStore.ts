/**
 * Settings store — persistent provider configuration with safe key storage.
 *
 * STORAGE STRATEGY
 * -----------------
 * The settings file lives at app.getPath('userData')/settings.json — this is
 * OUTSIDE the repo by Electron convention, so it's never accidentally committed.
 *
 * The API key is encrypted with Electron's safeStorage API when available
 * (Keychain on macOS, DPAPI on Windows, libsecret on Linux). The on-disk
 * format stores the encrypted key as a base64 string.
 *
 * If safeStorage.isEncryptionAvailable() is false (e.g. headless Linux without
 * libsecret), we fall back to storing the key as plaintext in the JSON file
 * BUT set file permissions to 0600 (owner read/write only) AND log a warning
 * to the console. The .gitignore also has a defensive entry for any
 * `kovix-settings*.json` files in the repo dir, just in case.
 *
 * LEAK PREVENTION
 * ---------------
 * - The API key is NEVER logged.
 * - The API key is NEVER sent to the renderer process except as a masked
 *   preview (first 4 chars + "..." + last 4 chars). The renderer never sees
 *   the full key.
 * - When `clearApiKey()` is called, the key is removed from memory and the
 *   file is rewritten without it.
 * - The settings file mode is set to 0600 on every write.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderName } from '../agent/llm/providerFactory.js';

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

/**
 * The full settings shape persisted to disk. The `apiKeyEnc` field is the
 * safeStorage-encrypted blob (base64). `apiKeyPlain` is only used when
 * safeStorage is unavailable.
 */
export interface PersistedSettings {
    /** Schema version — bump if the shape changes. */
    version: 1;
    /** Active provider name from the 14-provider registry. */
    provider: ProviderName | null;
    /** Model ID. Optional — falls back to provider default. */
    modelId?: string;
    /** Base URL override (for OpenAI-compatible providers). */
    baseUrl?: string;
    /** safeStorage-encrypted API key, base64-encoded. */
    apiKeyEnc?: string;
    /** Plaintext API key — ONLY used when safeStorage is unavailable. */
    apiKeyPlain?: string;
    /** When these settings were last saved (ISO timestamp). */
    savedAt?: string;
}

/**
 * What the renderer sees. The API key is ALWAYS masked — never the full value.
 */
export interface SettingsPreview {
    provider: ProviderName | null;
    modelId?: string;
    baseUrl?: string;
    /** Masked: "sk-a...wxyz" or null if no key set. */
    apiKeyMasked: string | null;
    /** Whether the key is stored encrypted (true) or as plaintext fallback (false). */
    apiKeyEncrypted: boolean;
    /** Whether any settings have been saved. */
    hasSettings: boolean;
}

// ----------------------------------------------------------------------
// File path
// ----------------------------------------------------------------------

function settingsFilePath(): string {
    return path.join(app.getPath('userData'), 'kovix-settings.json');
}

// ----------------------------------------------------------------------
// Load / save
// ----------------------------------------------------------------------

export async function loadSettings(): Promise<PersistedSettings | null> {
    const filePath = settingsFilePath();
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedSettings;
        if (parsed.version !== 1) {
            console.warn('[settings] Unknown version, ignoring file:', parsed.version);
            return null;
        }
        return parsed;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { return null; }
        console.error('[settings] Failed to load settings file:', err);
        return null;
    }
}

export async function saveSettings(settings: PersistedSettings): Promise<void> {
    const filePath = settingsFilePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const json = JSON.stringify(settings, null, 2);
    await fs.writeFile(filePath, json, { encoding: 'utf8', mode: 0o600 });
    // Defensive: chmod again in case the file already existed with looser perms.
    try { await fs.chmod(filePath, 0o600); } catch { /* best-effort */ }
}

export async function clearApiKey(): Promise<void> {
    const existing = await loadSettings();
    if (!existing) { return; }
    delete existing.apiKeyEnc;
    delete existing.apiKeyPlain;
    delete existing.savedAt;
    await saveSettings({ ...existing, savedAt: new Date().toISOString() });
}

// ----------------------------------------------------------------------
// API key encrypt / decrypt
// ----------------------------------------------------------------------

/**
 * Encrypt an API key using safeStorage. Returns base64 string.
 * Returns null if safeStorage is unavailable — caller should fall back to
 * plaintext and warn.
 */
export function encryptApiKey(plainKey: string): { enc: string | null; usedFallback: boolean } {
    if (safeStorage.isEncryptionAvailable()) {
        const buf = safeStorage.encryptString(plainKey);
        return { enc: buf.toString('base64'), usedFallback: false };
    }
    console.warn('[settings] safeStorage not available on this platform — storing API key as plaintext with 0600 file permissions.');
    return { enc: null, usedFallback: true };
}

export function decryptApiKey(settings: PersistedSettings): string | null {
    if (settings.apiKeyEnc) {
        if (!safeStorage.isEncryptionAvailable()) {
            console.error('[settings] API key is encrypted but safeStorage is not available — cannot decrypt.');
            return null;
        }
        try {
            const buf = Buffer.from(settings.apiKeyEnc, 'base64');
            return safeStorage.decryptString(buf);
        } catch (err) {
            console.error('[settings] Failed to decrypt API key:', err);
            return null;
        }
    }
    if (settings.apiKeyPlain) {
        return settings.apiKeyPlain;
    }
    return null;
}

// ----------------------------------------------------------------------
// Masked preview for renderer
// ----------------------------------------------------------------------

export function maskApiKey(key: string | null): string | null {
    if (!key) { return null; }
    if (key.length <= 8) { return '••••••••'; }
    return key.slice(0, 4) + '...' + key.slice(-4);
}

export async function getSettingsPreview(): Promise<SettingsPreview> {
    const settings = await loadSettings();
    if (!settings) {
        return {
            provider: null,
            apiKeyMasked: null,
            apiKeyEncrypted: false,
            hasSettings: false,
        };
    }
    const hasKey = !!(settings.apiKeyEnc || settings.apiKeyPlain);
    return {
        provider: settings.provider,
        modelId: settings.modelId,
        baseUrl: settings.baseUrl,
        // We deliberately do NOT decrypt the key here just to mask it —
        // that would touch the secret unnecessarily. The renderer only needs
        // to know "a key is set" (true/false). The masked string is a fixed
        // placeholder; the renderer never sees the real key length or value.
        apiKeyMasked: hasKey ? '••••••••' : null,
        apiKeyEncrypted: !!settings.apiKeyEnc,
        hasSettings: true,
    };
}

// ----------------------------------------------------------------------
// Resolve active provider config (called by main process)
// ----------------------------------------------------------------------

/**
 * Returns the active provider config from stored settings, with env vars
 * as fallback. The renderer never calls this — it's main-process only.
 *
 * Priority:
 *   1. Stored settings (if provider is set AND key is decryptable)
 *   2. Env vars (ANTHROPIC_API_KEY > OPENROUTER_API_KEY > NVIDIA_API_KEY > OLLAMA)
 *
 * Returns null if no config is available — caller should show a "configure
 * provider" prompt.
 */
export interface ResolvedProviderConfig {
    name: ProviderName;
    apiKey?: string;
    modelId?: string;
    baseUrl?: string;
    /** Where the config came from — for the topbar chip and logs. */
    source: 'settings' | 'env';
}

export async function resolveProviderConfig(): Promise<ResolvedProviderConfig | null> {
    // 1. Stored settings
    const settings = await loadSettings();
    if (settings && settings.provider) {
        const apiKey = decryptApiKey(settings);
        // If the provider requires a key and we can't decrypt it, fall through to env.
        const requiresKey = settings.provider !== 'ollama' && settings.provider !== 'xenova' && settings.provider !== 'lmstudio' && settings.provider !== 'litellm';
        if (!requiresKey || apiKey) {
            return {
                name: settings.provider,
                apiKey: apiKey ?? undefined,
                modelId: settings.modelId,
                baseUrl: settings.baseUrl,
                source: 'settings',
            };
        }
    }

    // 2. Env var fallback (kept for dev use — UI config takes precedence)
    if (process.env.ANTHROPIC_API_KEY) {
        return {
            name: 'anthropic',
            apiKey: process.env.ANTHROPIC_API_KEY,
            modelId: process.env.KOVIX_MODEL ?? 'claude-sonnet-4-20250514',
            source: 'env',
        };
    }
    if (process.env.OPENROUTER_API_KEY) {
        return {
            name: 'openrouter',
            apiKey: process.env.OPENROUTER_API_KEY,
            modelId: process.env.KOVIX_MODEL ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-oss-20b:free',
            source: 'env',
        };
    }
    if (process.env.NVIDIA_API_KEY) {
        return {
            name: 'nvidia',
            apiKey: process.env.NVIDIA_API_KEY,
            modelId: process.env.KOVIX_MODEL ?? 'meta/llama-3.3-70b-instruct',
            source: 'env',
        };
    }
    // Default: Ollama local (no key)
    return {
        name: 'ollama',
        modelId: process.env.KOVIX_MODEL ?? process.env.OLLAMA_MODEL,
        baseUrl: process.env.OLLAMA_BASE_URL,
        source: 'env',
    };
}

// ----------------------------------------------------------------------
// Defaults per provider — used by the model picker UI
// ----------------------------------------------------------------------

/**
 * Default model IDs for each provider, ordered from most to least preferred.
 * The first entry is the default when the user picks a provider without
 * selecting a model. For Anthropic we list the user-specified production
 * defaults; for other providers we use the same defaults from the
 * Phase 0 / Task 9 factory.
 */
export const PROVIDER_MODELS: Partial<Record<ProviderName, string[]>> = {
    anthropic: [
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-haiku-4-5-20251001',
    ],
    openrouter: ['openai/gpt-oss-20b:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    nvidia: ['meta/llama-3.3-70b-instruct'],
    openai: ['gpt-4o', 'gpt-4o-mini'],
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    groq: ['llama-3.3-70b-versatile'],
    mistral: ['mistral-large-latest'],
    deepseek: ['deepseek-chat'],
    gemini: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    ollama: ['llama3.2', 'qwen2.5:7b'],
    lmstudio: [],
    litellm: [],
    xenova: [],
    custom: [],
};

/**
 * The "default default" model for a provider — the first entry in
 * PROVIDER_MODELS, or undefined if the provider has no opinion.
 */
export function defaultModelFor(provider: ProviderName): string | undefined {
    return PROVIDER_MODELS[provider]?.[0];
}
