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
 * selecting a model. These lists are FALLBACKS — the Settings UI prefers
 * the live list from `fetchProviderModels()` when one is available (e.g.
 * OpenRouter's public /models endpoint, Anthropic's /v1/models with a key,
 * Ollama's /api/tags when running locally, NVIDIA NIM's /v1/models with a
 * key). When the live fetch fails or returns nothing, the UI falls back to
 * the hardcoded list below.
 *
 * Refreshed 2025-Q4. Stale entries should still resolve to a working model
 * — most providers accept model aliases — but you'll want to refresh the
 * lists whenever a provider ships a new model generation.
 */
export const PROVIDER_MODELS: Partial<Record<ProviderName, string[]>> = {
    anthropic: [
        'claude-sonnet-5',
        'claude-opus-4-1-20250805',
        'claude-opus-4-20250514',
        'claude-haiku-4-5-20251001',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
    ],
    openrouter: ['openai/gpt-oss-20b:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    nvidia: [
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'meta/llama-3.3-70b-instruct',
        'meta/llama-3.1-70b-instruct',
        'meta/llama-3.1-405b-instruct',
        'meta/llama-3.1-8b-instruct',
        'mistralai/mixtral-8x7b-instruct-v0.1',
        'google/gemma-2-27b-it',
        'qwen/qwen2.5-coder-32b-instruct',
        'deepseek-ai/deepseek-r1',
    ],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
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
// Live model-list fetching
// ----------------------------------------------------------------------
//
// The hardcoded PROVIDER_MODELS above is a FALLBACK. The Settings UI prefers
// the live list when one is available:
//
//   - OpenRouter: GET https://openrouter.ai/api/v1/models (PUBLIC, no auth)
//                 → filtered to entries ending in `:free` (the task spec:
//                   "Do NOT show OpenRouter's full paid catalog").
//   - Anthropic:  GET https://api.anthropic.com/v1/models with x-api-key
//                 → requires a key. On failure (no key, network error, 401)
//                   the UI falls back to PROVIDER_MODELS.anthropic.
//   - NVIDIA NIM: GET https://integrate.api.nvidia.com/v1/models with Bearer
//                 → requires a key. On failure, falls back to PROVIDER_MODELS.nvidia.
//   - Ollama:     GET http://localhost:11434/api/tags
//                 → no auth. On failure (Ollama not running), falls back to
//                   PROVIDER_MODELS.ollama.
//   - Others:     no live fetch — return PROVIDER_MODELS[provider] ?? [].
//
// Results are cached in-memory per provider for 10 minutes so the user
// doesn't refetch on every dropdown toggle.

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const modelFetchCache = new Map<string, { models: string[]; fetchedAt: number; source: 'live' | 'fallback' }>();

/** Default timeout for the live fetch — we don't want the UI to hang on a dead endpoint. */
const FETCH_TIMEOUT_MS = 10_000;

export interface FetchedModels {
    /** Model IDs to populate the dropdown with. May be empty. */
    models: string[];
    /** Whether the list came from a live API call or the hardcoded fallback. */
    source: 'live' | 'fallback';
    /** Human-readable note for the UI (e.g. 'filtered to :free models', 'live fetch failed: ...'). */
    note?: string;
}

/**
 * Fetch the live model list for a provider, with graceful fallback to the
 * hardcoded PROVIDER_MODELS list on any failure (no key, network error,
 * non-OK response, parse error, timeout).
 *
 * Results are cached per (providerId + apiKey-suffix) for MODEL_CACHE_TTL_MS.
 * Pass `forceRefresh: true` to bypass the cache (used by the Test-connection
 * button).
 */
export async function fetchProviderModels(
    providerId: string,
    apiKey?: string,
    opts: { forceRefresh?: boolean; baseUrl?: string } = {},
): Promise<FetchedModels> {
    const cacheKey = cacheKeyFor(providerId, apiKey, opts.baseUrl);
    if (!opts.forceRefresh) {
        const cached = modelFetchCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
            return { models: cached.models, source: cached.source };
        }
    }

    let result: FetchedModels;
    try {
        switch (providerId) {
            case 'openrouter':
                result = await fetchOpenRouterFreeModels();
                break;
            case 'anthropic':
                result = await fetchAnthropicModels(apiKey);
                break;
            case 'nvidia':
                result = await fetchNvidiaModels(apiKey);
                break;
            case 'ollama':
                result = await fetchOllamaModels(opts.baseUrl);
                break;
            case 'openai':
                result = await fetchOpenAiCompatModels('https://api.openai.com/v1', apiKey, 'OpenAI');
                break;
            case 'together':
                result = await fetchOpenAiCompatModels('https://api.together.xyz/v1', apiKey, 'Together AI');
                break;
            case 'groq':
                result = await fetchOpenAiCompatModels('https://api.groq.com/openai/v1', apiKey, 'Groq');
                break;
            case 'mistral':
                result = await fetchOpenAiCompatModels('https://api.mistral.ai/v1', apiKey, 'Mistral');
                break;
            case 'deepseek':
                result = await fetchOpenAiCompatModels('https://api.deepseek.com/v1', apiKey, 'DeepSeek');
                break;
            case 'gemini':
                result = await fetchOpenAiCompatModels('https://generativelanguage.googleapis.com/v1beta/openai', apiKey, 'Gemini');
                break;
            case 'lmstudio':
                result = await fetchOpenAiCompatModels(opts.baseUrl ?? 'http://localhost:1234/v1', apiKey ?? 'lm-studio', 'LM Studio');
                break;
            case 'litellm':
                result = await fetchOpenAiCompatModels(opts.baseUrl ?? 'http://localhost:4000/v1', apiKey ?? 'litellm', 'LiteLLM');
                break;
            default:
                // xenova, custom, unknown — no live fetch.
                result = fallbackFor(providerId);
                break;
        }
    } catch (err) {
        result = {
            ...fallbackFor(providerId),
            note: 'live fetch failed: ' + (err instanceof Error ? err.message : String(err)),
        };
    }

    modelFetchCache.set(cacheKey, {
        models: result.models,
        fetchedAt: Date.now(),
        source: result.source,
    });
    return result;
}

function cacheKeyFor(providerId: string, apiKey?: string, baseUrl?: string): string {
    // We don't put the full key in the cache key — just the last 4 chars so
    // different keys get different cache entries without leaking the key.
    const keySuffix = apiKey && apiKey.length > 4 ? apiKey.slice(-4) : (apiKey ? 'short' : 'nokey');
    return providerId + '|' + keySuffix + '|' + (baseUrl ?? 'default');
}

function fallbackFor(providerId: string): FetchedModels {
    return {
        models: PROVIDER_MODELS[providerId as ProviderName] ?? [],
        source: 'fallback',
    };
}

/**
 * OpenRouter: GET https://openrouter.ai/api/v1/models (PUBLIC, no auth).
 * Filter to only free-tier models (IDs ending in `:free`).
 */
async function fetchOpenRouterFreeModels(): Promise<FetchedModels> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' },
        });
        if (!response.ok) {
            return {
                ...fallbackFor('openrouter'),
                note: 'OpenRouter /models returned ' + response.status + ' — using fallback list',
            };
        }
        const data = await response.json() as { data?: Array<{ id?: string }> };
        const all = (data.data ?? [])
            .map(m => m.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        // Filter to :free only — the task spec says "Do NOT show OpenRouter's
        // full paid catalog."
        const free = all.filter(id => id.endsWith(':free'));
        if (free.length === 0) {
            return {
                ...fallbackFor('openrouter'),
                note: 'live fetch returned 0 :free models — using fallback list',
            };
        }
        // Sort alphabetically for a stable dropdown.
        free.sort();
        return {
            models: free,
            source: 'live',
            note: 'live fetch — filtered to ' + free.length + ' :free models (out of ' + all.length + ' total)',
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Anthropic: GET https://api.anthropic.com/v1/models with x-api-key header.
 * Requires a key. On any failure, falls back to PROVIDER_MODELS.anthropic.
 */
async function fetchAnthropicModels(apiKey?: string): Promise<FetchedModels> {
    if (!apiKey) {
        return {
            ...fallbackFor('anthropic'),
            note: 'no API key — showing fallback list. A live fetch happens when a key is present.',
        };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
            signal: controller.signal,
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Accept': 'application/json',
            },
        });
        if (!response.ok) {
            return {
                ...fallbackFor('anthropic'),
                note: 'Anthropic /v1/models returned ' + response.status + ' — using fallback list',
            };
        }
        const data = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (data.data ?? [])
            .map(m => m.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) {
            return {
                ...fallbackFor('anthropic'),
                note: 'live fetch returned 0 models — using fallback list',
            };
        }
        // Anthropic returns models in created_at order (newest first usually).
        // Sort alphabetically for stable display.
        ids.sort();
        return {
            models: ids,
            source: 'live',
            note: 'live fetch — ' + ids.length + ' models from Anthropic API',
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * NVIDIA NIM: GET https://integrate.api.nvidia.com/v1/models with Bearer.
 * Requires a key. On any failure, falls back to PROVIDER_MODELS.nvidia.
 */
async function fetchNvidiaModels(apiKey?: string): Promise<FetchedModels> {
    if (!apiKey) {
        return {
            ...fallbackFor('nvidia'),
            note: 'no API key — showing fallback list. A live fetch happens when a key is present.',
        };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
            signal: controller.signal,
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Accept': 'application/json',
            },
        });
        if (!response.ok) {
            return {
                ...fallbackFor('nvidia'),
                note: 'NVIDIA NIM /v1/models returned ' + response.status + ' — using fallback list',
            };
        }
        const data = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (data.data ?? [])
            .map(m => m.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) {
            return {
                ...fallbackFor('nvidia'),
                note: 'live fetch returned 0 models — using fallback list',
            };
        }
        ids.sort();
        return {
            models: ids,
            source: 'live',
            note: 'live fetch — ' + ids.length + ' models from NVIDIA NIM API',
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Ollama: GET http://localhost:11434/api/tags. No auth. On any failure
 * (Ollama not running), falls back to PROVIDER_MODELS.ollama.
 */
async function fetchOllamaModels(baseUrlOverride?: string): Promise<FetchedModels> {
    const base = (baseUrlOverride ?? 'http://localhost:11434').replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000); // short — local should be fast
    try {
        const response = await fetch(base + '/api/tags', {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' },
        });
        if (!response.ok) {
            return {
                ...fallbackFor('ollama'),
                note: 'Ollama /api/tags returned ' + response.status + ' — using fallback list',
            };
        }
        const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
        const names = (data.models ?? [])
            .map(m => m.name ?? m.model)
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
        if (names.length === 0) {
            return {
                ...fallbackFor('ollama'),
                note: 'Ollama is running but has no models installed — use `ollama pull llama3.2`',
            };
        }
        names.sort();
        return {
            models: names,
            source: 'live',
            note: 'live fetch — ' + names.length + ' locally-installed Ollama models',
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Generic OpenAI-compatible /models fetcher (used for OpenAI, Together, Groq,
 * Mistral, DeepSeek, Gemini, LM Studio, LiteLLM). Requires a key for cloud
 * providers; for local providers (lm-studio, litellm) the key is a fixed
 * placeholder.
 */
async function fetchOpenAiCompatModels(baseUrl: string, apiKey: string | undefined, label: string): Promise<FetchedModels> {
    if (!apiKey) {
        return {
            ...fallbackFor(labelToProviderId(label)),
            note: 'no API key — showing fallback list',
        };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
            signal: controller.signal,
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Accept': 'application/json',
            },
        });
        if (!response.ok) {
            return {
                ...fallbackFor(labelToProviderId(label)),
                note: label + ' /models returned ' + response.status + ' — using fallback list',
            };
        }
        const data = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (data.data ?? [])
            .map(m => m.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) {
            return {
                ...fallbackFor(labelToProviderId(label)),
                note: 'live fetch returned 0 models — using fallback list',
            };
        }
        ids.sort();
        return {
            models: ids,
            source: 'live',
            note: 'live fetch — ' + ids.length + ' models from ' + label,
        };
    } finally {
        clearTimeout(timeout);
    }
}

function labelToProviderId(label: string): string {
    switch (label) {
        case 'OpenAI': return 'openai';
        case 'Together AI': return 'together';
        case 'Groq': return 'groq';
        case 'Mistral': return 'mistral';
        case 'DeepSeek': return 'deepseek';
        case 'Gemini': return 'gemini';
        case 'LM Studio': return 'lmstudio';
        case 'LiteLLM': return 'litellm';
        default: return 'custom';
    }
}

/**
 * Clear the in-memory cache. Used after settings are saved so the next
 * dropdown open reflects the new key.
 */
export function clearModelFetchCache(): void {
    modelFetchCache.clear();
}
