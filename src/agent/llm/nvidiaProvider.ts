/**
 * NvidiaNimProvider - concrete AI provider for the NVIDIA NIM API.
 *
 * NVIDIA NIM (https://build.nvidia.com) exposes an OpenAI-compatible
 * chat completions endpoint at:
 *
 *     https://integrate.api.nvidia.com/v1/chat/completions
 *
 * Authentication is a Bearer token in the `Authorization` header:
 *
 *     Authorization: Bearer $NVIDIA_API_KEY
 *
 * Get a key at https://build.nvidia.com (sign in → API keys → generate).
 * Keys typically start with `nvapi-`.
 *
 * Models are addressed by `{publisher}/{model}` slugs, e.g.:
 *   - nvidia/llama-3.1-nemotron-70b-instruct
 *   - meta/llama-3.3-70b-instruct
 *   - meta/llama-3.1-70b-instruct
 *   - mistralai/mistral-nemotron-nemo-12b-instruct
 *
 * WHY A DEDICATED CLASS (vs. the CloudStubProvider base)
 * -------------------------------------------------------
 * The stub base passes `provider: 'custom'` to CloudProvider, which means
 * CloudProvider's chatOpenAI() method does NOT apply the
 * `parallel_tool_calls = false` workaround that several OpenAI-compatible
 * providers (including NVIDIA NIM) require when tools are present. By
 * constructing CloudProvider with `provider: 'nvidia'` here, we get the
 * correct tool-calling behavior. The other OpenAI-compat providers in
 * stubProviders.ts remain stubs because their verify path is documented
 * to work via the OpenRouter proxy.
 *
 * VERIFICATION STATUS
 * -------------------
 * Interface-ready; NOT yet verified end-to-end from this sandbox because no
 * NVIDIA NIM API key is available. The HTTP path is the same one OpenRouter
 * uses (already verified) so we expect this to work. To verify locally:
 *
 *   1. Get a key at https://build.nvidia.com.
 *   2. Configure it in Kovix (Settings → Provider: NVIDIA NIM → paste key).
 *   3. Run: npx tsx test/verify-nvidia.ts
 *
 * See PROVIDERS.md for the full provider status table.
 */

import {
    IConstructAIProvider,
    AIProviderType,
    AIStreamEvent,
    IChatMessage,
    IChatOptions,
    IModelInfo,
    IToolDefinition,
    ProviderStatus,
} from './types.js';
import { CloudProvider, type CloudProviderConfig } from './cloudProvider.js';

/** NVIDIA NIM API base URL. Chat path is appended by CloudProvider as `/chat/completions`. */
export const NVIDIA_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** Default model — a widely-available, capable instruction-tuned model. */
export const NVIDIA_NIM_DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct';

/**
 * Curated fallback model list. Used by listModels() when the live
 * GET /v1/models call fails (e.g. no key, network error, rate limit).
 * Refreshed 2025-Q4 from https://build.nvidia.com/models.
 */
export const NVIDIA_NIM_FALLBACK_MODELS: string[] = [
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct-branch',
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-405b-instruct',
    'meta/llama-3.1-8b-instruct',
    'mistralai/mistral-nemotron-nemo-12b-instruct',
    'mistralai/mixtral-8x7b-instruct-v0.1',
    'google/gemma-2-9b-it',
    'google/gemma-2-27b-it',
    'microsoft/phi-3.5-mini-instruct',
    'qwen/qwen2.5-7b-instruct',
    'qwen/qwen2.5-coder-32b-instruct',
    'deepseek-ai/deepseek-r1',
    'ibm/granite-3.0-8b-instruct',
];

/**
 * Plain config object for the NVIDIA NIM provider.
 */
export interface NvidiaNimProviderConfig {
    /** API key from https://build.nvidia.com. Required. */
    apiKey: string;
    /**
     * Model ID. If omitted, defaults to NVIDIA_NIM_DEFAULT_MODEL.
     * Format: `{publisher}/{model}` (e.g. `meta/llama-3.3-70b-instruct`).
     */
    modelId?: string;
}

/**
 * NvidiaNimProvider — concrete AI provider for NVIDIA NIM.
 *
 * Delegates the actual HTTP call to CloudProvider (which has the full
 * OpenAI-compatible streaming + tool-call parser), but explicitly passes
 * `provider: 'nvidia'` so CloudProvider applies the right per-provider
 * quirks (parallel_tool_calls=false, etc).
 */
export class NvidiaNimProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';

    private _inner: CloudProvider;

    constructor(config: NvidiaNimProviderConfig) {
        if (!config.apiKey) {
            throw new Error('NvidiaNimProvider: apiKey is required. Get one at https://build.nvidia.com.');
        }
        const cloudConfig: CloudProviderConfig = {
            apiKey: config.apiKey,
            modelId: config.modelId ?? NVIDIA_NIM_DEFAULT_MODEL,
            baseUrl: NVIDIA_NIM_BASE_URL,
            provider: 'nvidia',
        };
        this._inner = new CloudProvider(cloudConfig);
    }

    isOffline(): boolean {
        return false;
    }

    async checkStatus(): Promise<ProviderStatus> {
        return this._inner.checkStatus();
    }

    getActiveModel(): IModelInfo | undefined {
        return this._inner.getActiveModel();
    }

    async setActiveModel(modelId: string): Promise<boolean> {
        return this._inner.setActiveModel(modelId);
    }

    async listModels(): Promise<IModelInfo[]> {
        // CloudProvider.listModels() already hits GET /models and falls back
        // to an empty list on error. We additionally fall back to our
        // curated NIM list if the live fetch returns nothing.
        const live = await this._inner.listModels();
        if (live.length > 0) {
            return live;
        }
        return NVIDIA_NIM_FALLBACK_MODELS.map(id => ({
            id,
            displayName: id,
            provider: 'cloud' as AIProviderType,
            contextWindowTokens: 128_000,
            supportsTools: true,
            supportsStreaming: true,
        }));
    }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        yield* this._inner.chat(messages, tools, options);
    }

    dispose(): void {
        this._inner.dispose();
    }

    /** Human-readable name for logging/UI. */
    get name(): string {
        return 'nvidia';
    }
}
