/**
 * Provider factory — single entry point for instantiating any LLM provider
 * by name. Used by the verify script, the Electron main process, and
 * (eventually) the UI's provider picker.
 *
 * The factory keeps the rest of the codebase from having to know about
 * individual provider constructors. To add a new provider, register it
 * in PROVIDER_REGISTRY below.
 */

import type { IConstructAIProvider } from './types.js';
import { CloudProvider, type CloudProviderConfig, type LLMProvider } from './cloudProvider.js';
import { OllamaProvider, type OllamaProviderConfig } from './ollamaProvider.js';
import {
    OpenAIProvider,
    OpenRouterProvider,
    NvidiaNimProvider,
    TogetherProvider,
    GroqProvider,
    MistralProvider,
    DeepSeekProvider,
    GeminiProvider,
    LmStudioProvider,
    LiteLLMProvider,
    XenovaProvider,
    type CloudStubConfig,
} from './stubProviders.js';

/**
 * All providers Kovix knows about, keyed by the string the UI/CLI uses to
 * reference them. The LLMProvider union in cloudProvider.ts is the source
 * of truth for cloud provider names; this registry adds the local ones
 * (ollama, xenova) so the factory has a complete map.
 */
export type ProviderName =
    | LLMProvider
    | 'ollama'
    | 'xenova'
    | 'anthropic'; // LLMProvider already includes 'anthropic', but we list it here explicitly for clarity

/**
 * Config shape for createProvider(). The caller provides a `name` plus
 * provider-specific config. Unknown fields are ignored.
 */
export interface CreateProviderOptions {
    /** Which provider to instantiate. */
    name: ProviderName;
    /** API key for cloud providers. Required for all cloud providers; ignored for ollama/xenova. */
    apiKey?: string;
    /** Model ID. Optional — each provider has a sensible default. */
    modelId?: string;
    /** Base URL override. Optional — each provider has a sensible default. */
    baseUrl?: string;
}

interface ProviderRegistryEntry {
    /** Human-readable label for the UI. */
    label: string;
    /** Whether this provider is verified to work end-to-end. */
    verified: boolean;
    /** Whether this provider needs an API key. */
    requiresApiKey: boolean;
    /** Whether this provider works offline (no internet). */
    offline: boolean;
    /** Factory function. */
    create: (opts: CreateProviderOptions) => IConstructAIProvider;
}

const PROVIDER_REGISTRY: Record<ProviderName, ProviderRegistryEntry> = {
    // --- VERIFIED PROVIDERS ---
    anthropic: {
        label: 'Anthropic Claude',
        verified: true,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new CloudProvider({
            apiKey: opts.apiKey ?? '',
            modelId: opts.modelId ?? 'claude-sonnet-4-20250514',
        } satisfies CloudProviderConfig),
    },
    ollama: {
        label: 'Ollama (local)',
        verified: true,
        requiresApiKey: false,
        offline: true,
        create: (opts) => new OllamaProvider({
            baseUrl: opts.baseUrl,
            modelId: opts.modelId,
        } satisfies OllamaProviderConfig),
    },

    // --- UNVERIFIED STUBS (interface-ready) ---
    openai: {
        label: 'OpenAI',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new OpenAIProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    openrouter: {
        label: 'OpenRouter',
        verified: true, // verified end-to-end via free models (nvidia/nemotron-3-super-120b-a12b:free, openai/gpt-oss-20b:free)
        requiresApiKey: true,
        offline: false,
        create: (opts) => new OpenRouterProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    nvidia: {
        label: 'NVIDIA NIM',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new NvidiaNimProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    together: {
        label: 'Together AI',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new TogetherProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    groq: {
        label: 'Groq',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new GroqProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    mistral: {
        label: 'Mistral',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new MistralProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    deepseek: {
        label: 'DeepSeek',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new DeepSeekProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    gemini: {
        label: 'Google Gemini (OpenAI-compat)',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new GeminiProvider({ apiKey: opts.apiKey ?? '', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    lmstudio: {
        label: 'LM Studio (local)',
        verified: false,
        requiresApiKey: false,
        offline: true,
        create: (opts) => new LmStudioProvider({ apiKey: opts.apiKey ?? 'lm-studio', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    litellm: {
        label: 'LiteLLM proxy (local)',
        verified: false,
        requiresApiKey: false,
        offline: true,
        create: (opts) => new LiteLLMProvider({ apiKey: opts.apiKey ?? 'litellm', modelId: opts.modelId } satisfies CloudStubConfig),
    },
    xenova: {
        label: 'Xenova (in-process ONNX)',
        verified: false,
        requiresApiKey: false,
        offline: true,
        create: (_opts) => new XenovaProvider({}),
    },
    custom: {
        label: 'Custom OpenAI-compatible',
        verified: false,
        requiresApiKey: true,
        offline: false,
        create: (opts) => new CloudProvider({
            apiKey: opts.apiKey ?? '',
            modelId: opts.modelId,
            baseUrl: opts.baseUrl,
            provider: 'custom',
        } satisfies CloudProviderConfig),
    },
};

/**
 * List all registered providers, with metadata for UI display.
 */
export function listProviders(): Array<{ name: ProviderName; label: string; verified: boolean; requiresApiKey: boolean; offline: boolean }> {
    return Object.entries(PROVIDER_REGISTRY).map(([name, entry]) => ({
        name: name as ProviderName,
        label: entry.label,
        verified: entry.verified,
        requiresApiKey: entry.requiresApiKey,
        offline: entry.offline,
    }));
}

/**
 * Create a provider instance by name. Throws if the provider name is unknown
 * or if a required API key is missing.
 */
export function createProvider(opts: CreateProviderOptions): IConstructAIProvider {
    const entry = PROVIDER_REGISTRY[opts.name];
    if (!entry) {
        throw new Error(`Unknown provider: ${opts.name}. Known providers: ${Object.keys(PROVIDER_REGISTRY).join(', ')}`);
    }
    if (entry.requiresApiKey && !opts.apiKey) {
        throw new Error(`Provider "${opts.name}" requires an API key. Pass apiKey in the options.`);
    }
    return entry.create(opts);
}
