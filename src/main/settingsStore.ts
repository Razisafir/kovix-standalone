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
// OpenRouter free-models fetcher
// ----------------------------------------------------------------------
//
// OpenRouter exposes a PUBLIC catalog at https://openrouter.ai/api/v1/models
// (no auth required for GET). Each model object includes a `pricing` object
// with string-valued fields like `pricing.prompt = "0"` and
// `pricing.completion = "0"` for free-tier models.
//
// We fetch the catalog, filter to models where BOTH prompt and completion
// pricing are exactly "0", cache the result for 1 hour, and surface it in
// the Settings picker so the user can pick from every free model
// OpenRouter currently offers — without having to type IDs manually.
//
// If the network call fails (offline, OpenRouter down, malformed response),
// we fall back to FREE_OPENROUTER_MODELS_FALLBACK below, a curated snapshot
// of popular free models as of late 2025.

/** Curated snapshot of popular OpenRouter free-tier models.
 *  Used as a fallback when the live catalog fetch fails. */
export const FREE_OPENROUTER_MODELS_FALLBACK: readonly string[] = [
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-20b:free',
    'deepseek/deepseek-r1:free',
    'deepseek/deepseek-r1-0528:free',
    'deepseek/deepseek-chat:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'qwen/qwq-32b:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'qwen/qwen-2.5-coder-32b-instruct:free',
    'qwen/qwen-2.5-7b-instruct:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'google/gemini-flash-1.5:free',
    'google/gemma-3-12b-it:free',
    'google/gemma-3-4b-it:free',
    'google/gemma-2-9b-it:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia/nemotron-4-340b-instruct:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'mistralai/mistral-nemo:free',
    'mistralai/mistral-7b-instruct:free',
    'microsoft/phi-4-reasoning-plus:free',
    'microsoft/phi-4:free',
    'microsoft/phi-3-medium-128k-instruct:free',
    'microsoft/phi-3-mini-128k-instruct:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'cognitivecomputations/dolphin3.0-mistral-24b:free',
    'moonshotai/kimi-k2:free',
    'moonshotai/kimi-dev-72b:free',
    'thudm/glm-4-32b:free',
    'thudm/glm-z1-32b:free',
    'liquid/lfm-40b:free',
    'liquid/lfm-7b:free',
    'liquid/lfm-3b:free',
    'rekaai/reka-flash-3:free',
    'perplexity/r1-1776:free',
    'tngtech/deepseek-r1t-chimera:free',
    'featherless/qwerky-72b:free',
    'bytedance-research/ui-tars-72b:free',
    'open-r1/olympiccoder-32b:free',
    'open-r1/olympiccoder-7b:free',
    'huggingfaceh4/zephyr-7b-beta:free',
    'openchat/openchat-7b:free',
    'gryphe/mythomist-7b:free',
    'undi95/toppy-m-7b:free',
];

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
    /**
     * User-chosen workspace directory. When set, the execution agent writes
     * build files into a subdirectory of this path (not the OS temp dir).
     * Optional — when absent, the default (~/Documents/kovix-projects) is
     * used. Additive field; no version bump needed (old files still parse).
     */
    workspaceDir?: string;
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
 *
 * For OpenRouter we seed with the most popular free models — but at runtime
 * `kovix:settings:get-models` IPC handler merges this with the live catalog
 * returned by `fetchOpenRouterFreeModels()`, so the user always sees every
 * free model OpenRouter currently offers.
 */
export const PROVIDER_MODELS: Partial<Record<ProviderName, string[]>> = {
    anthropic: [
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-haiku-4-5-20251001',
    ],
    openrouter: Array.from(FREE_OPENROUTER_MODELS_FALLBACK),
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

// ----------------------------------------------------------------------
// Live OpenRouter free-models fetcher (1-hour cache, static fallback)
// ----------------------------------------------------------------------

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour
const OPENROUTER_FETCH_TIMEOUT_MS = 10_000;

/** Subset of the OpenRouter /models response shape that we care about. */
interface OpenRouterModelEntry {
    id: string;
    pricing?: {
        prompt?: string;
        completion?: string;
    };
}
interface OpenRouterModelsResponse {
    data?: OpenRouterModelEntry[];
}

let openRouterFreeCache: { ids: string[]; fetchedAt: number } | null = null;
let openRouterFetchInFlight: Promise<string[]> | null = null;

/**
 * Returns the list of free OpenRouter model IDs.
 *
 * A model is "free" when BOTH `pricing.prompt === "0"` AND
 * `pricing.completion === "0"` (OpenRouter's convention for $0-priced
 * models). The result is fetched live from
 * https://openrouter.ai/api/v1/models, cached for 1 hour, and merged
 * with the curated `FREE_OPENROUTER_MODELS_FALLBACK` list. Concurrent
 * callers share the same in-flight promise.
 *
 * @param forceRefresh — bypass the cache (e.g. user clicked "Refresh"
 *   in the Settings modal). Default false.
 */
export async function fetchOpenRouterFreeModels(forceRefresh = false): Promise<string[]> {
    const now = Date.now();
    if (!forceRefresh && openRouterFreeCache && (now - openRouterFreeCache.fetchedAt) < OPENROUTER_MODELS_TTL_MS) {
        return openRouterFreeCache.ids;
    }

    // Deduplicate concurrent callers — they all wait on the same in-flight fetch.
    if (openRouterFetchInFlight) {
        try {
            return await openRouterFetchInFlight;
        } catch {
            // If the in-flight fetch rejected, fall through and try again.
        }
    }

    openRouterFetchInFlight = (async (): Promise<string[]> => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), OPENROUTER_FETCH_TIMEOUT_MS);
            try {
                const res = await fetch(OPENROUTER_MODELS_URL, {
                    signal: controller.signal,
                    headers: { 'accept': 'application/json' },
                });
                if (!res.ok) {
                    throw new Error('OpenRouter /models returned HTTP ' + res.status);
                }
                const json = (await res.json()) as OpenRouterModelsResponse;
                const entries = Array.isArray(json?.data) ? json.data : [];
                // Filter: pricing.prompt === "0" AND pricing.completion === "0".
                // OpenRouter uses string-valued numeric fields; "0" means free.
                const freeIds: string[] = [];
                for (const entry of entries) {
                    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
                    const p = entry.pricing;
                    if (!p) continue;
                    if (p.prompt === '0' && p.completion === '0') {
                        freeIds.push(entry.id);
                    }
                }
                if (freeIds.length === 0) {
                    throw new Error('OpenRouter /models returned no free models (pricing.prompt=0 AND pricing.completion=0)');
                }
                // Merge live + fallback, dedup, sort alphabetically for stable UI.
                const merged = Array.from(new Set([...freeIds, ...FREE_OPENROUTER_MODELS_FALLBACK])).sort();
                openRouterFreeCache = { ids: merged, fetchedAt: now };
                return merged;
            } finally {
                clearTimeout(timeout);
            }
        } catch (err) {
            console.warn('[settings] Failed to fetch OpenRouter free models catalog — using fallback list. Reason:', err instanceof Error ? err.message : String(err));
            // Cache the fallback for the full TTL window so we don't hammer
            // OpenRouter on every UI interaction when the network is down.
            const merged = Array.from(new Set(FREE_OPENROUTER_MODELS_FALLBACK)).sort();
            openRouterFreeCache = { ids: merged, fetchedAt: now };
            return merged;
        } finally {
            openRouterFetchInFlight = null;
        }
    })();

    return openRouterFetchInFlight;
}

/** Synchronous accessor — returns the cached list if available, else the
 *  static fallback. For code paths that can't await. */
export function getCachedOpenRouterFreeModels(): string[] {
    if (openRouterFreeCache) {
        return openRouterFreeCache.ids;
    }
    return Array.from(FREE_OPENROUTER_MODELS_FALLBACK);
}
