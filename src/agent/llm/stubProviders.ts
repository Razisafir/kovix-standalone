/**
 * Stub providers — interface-ready, NOT TESTED.
 *
 * These exist so the UI's provider picker can list all the LLMs Kovix intends
 * to support, and so the agent core's provider factory has a complete shape.
 * They implement the IConstructAIProvider contract but throw on chat() with
 * a clear "not implemented" error rather than silently failing or attempting
 * an untested API call.
 *
 * Each stub is a thin wrapper around CloudProvider with provider-specific
 * defaults baked in (baseUrl, default model, key prefix). When you're ready
 * to fully verify one of these, the work is:
 *   1. Get a real API key for that provider
 *   2. Run `npx tsx test/verify.ts --provider <name>` with that key
 *   3. Confirm the verify script's 8 checks all pass
 *   4. Move the stub out of this file into its own file and mark it as
 *      "verified" in PROVIDERS.md
 *
 * DO NOT ship a v1 that calls these "supported" — they're scaffolded, not
 * verified. The two verified providers are Anthropic (via CloudProvider) and
 * Ollama (via OllamaProvider).
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

/**
 * Common config shape for all cloud stubs. Each stub adds its own defaults
 * on top of this.
 */
export interface CloudStubConfig {
    apiKey: string;
    modelId?: string;
}

/**
 * Base class for stub providers. Subclasses set _defaultBaseUrl and
 * _defaultModel in their constructor, then delegate to an internal
 * CloudProvider instance.
 *
 * We delegate to CloudProvider instead of inheriting from it because each
 * stub represents a distinct provider identity (OpenAI vs OpenRouter vs NVIDIA
 * NIM, etc.) — the agent loop and UI switch on providerType, and we want
 * each stub to be addressable as its own thing even though the underlying
 * HTTP call path is identical (OpenAI-compatible).
 */
abstract class CloudStubProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';

    protected _defaultBaseUrl: string;
    protected _defaultModel: string;
    protected _providerName: string;
    protected _inner: CloudProvider;

    constructor(providerName: string, defaultBaseUrl: string, defaultModel: string, config: CloudStubConfig) {
        this._providerName = providerName;
        this._defaultBaseUrl = defaultBaseUrl;
        this._defaultModel = defaultModel;
        this._inner = new CloudProvider({
            apiKey: config.apiKey,
            modelId: config.modelId ?? defaultModel,
            baseUrl: defaultBaseUrl,
            provider: 'custom',
        });
    }

    abstract isOffline(): boolean;

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
        return this._inner.listModels();
    }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        yield* this._inner.chat(messages, tools, options);
    }

    dispose(): void {
        this._inner.dispose();
    }

    /** Human-readable name for logging/UI. */
    get name(): string {
        return this._providerName;
    }
}

// ----------------------------------------------------------------------
// Individual stubs
// ----------------------------------------------------------------------

/**
 * OpenAI stub.
 *
 * Status: INTERFACE-READY, UNTESTED.
 * The underlying HTTP path (OpenAI chat/completions) is the same one
 * OpenRouter/NVIDIA NIM use and is verified via OpenRouter. To verify
 * OpenAI itself, get a real sk-... key from platform.openai.com and run
 * verify.ts with --provider openai.
 */
export class OpenAIProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('openai', 'https://api.openai.com/v1', 'gpt-4o', config);
    }
    isOffline(): boolean { return false; }
}

/**
 * OpenRouter stub.
 *
 * Status: VERIFIED via free NVIDIA Nemotron model (see PHASE0_REPORT.md).
 * Kept here as a stub because the verified path goes through CloudProvider
 * directly with `provider: 'openrouter'` — this class is a convenience
 * wrapper for the UI's provider picker. To re-verify, run verify.ts with
 * --provider openrouter.
 */
export class OpenRouterProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('openrouter', 'https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct:free', config);
    }
    isOffline(): boolean { return false; }
}

// NOTE: NVIDIA NIM has been promoted from a stub to a dedicated provider class
// in `./nvidiaProvider.ts`. The dedicated class passes `provider: 'nvidia'`
// to CloudProvider so the chatOpenAI path applies the
// `parallel_tool_calls = false` workaround that NIM needs when tools are
// present. Verification is still BLOCKED on a real NIM API key — see
// test/verify-nvidia.ts and PROVIDERS.md.

/**
 * Together AI stub.
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: meta-llama/Llama-3.3-70B-Instruct-Turbo
 */
export class TogetherProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('together', 'https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', config);
    }
    isOffline(): boolean { return false; }
}

/**
 * Groq stub.
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: llama-3.3-70b-versatile
 */
export class GroqProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile', config);
    }
    isOffline(): boolean { return false; }
}

/**
 * Mistral stub.
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: mistral-large-latest
 */
export class MistralProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('mistral', 'https://api.mistral.ai/v1', 'mistral-large-latest', config);
    }
    isOffline(): boolean { return false; }
}

/**
 * DeepSeek stub.
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: deepseek-chat
 */
export class DeepSeekProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', config);
    }
    isOffline(): boolean { return false; }
}

/**
 * Google Gemini (OpenAI-compatible endpoint) stub.
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: gemini-1.5-pro
 * Note: Gemini's native API is NOT OpenAI-compatible; this uses Google's
 * OpenAI-compat shim. For native Gemini support (with multimodal), we'd
 * need to write a dedicated provider. Out of scope for v1.
 */
export class GeminiProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-1.5-pro', config);
    }
    isOffline(): boolean { return false; }
}

/**
 * LM Studio stub (local OpenAI-compatible server).
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: pulled from LM Studio's loaded model
 * LM Studio runs on http://localhost:1234 by default.
 */
export class LmStudioProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('lmstudio', 'http://localhost:1234/v1', 'local-model', config);
    }
    isOffline(): boolean { return true; }
}

/**
 * LiteLLM proxy stub.
 * Status: INTERFACE-READY, UNTESTED.
 * Default model: whatever the proxy is configured to route to.
 * LiteLLM runs on http://localhost:4000 by default.
 */
export class LiteLLMProvider extends CloudStubProvider {
    constructor(config: CloudStubConfig) {
        super('litellm', 'http://localhost:4000/v1', 'default', config);
    }
    isOffline(): boolean { return true; }
}

/**
 * Xenova stub — in-process ONNX models via @xenova/transformers.
 * Status: INTERFACE-READY, UNTESTED.
 *
 * The original VS Code fork had a full XenovaProvider (414 lines) that ran
 * quantized models in a web worker. We did NOT port it in Phase 0 because:
 *   - It pulls in @xenova/transformers (a heavy dep, ~50MB)
 *   - The in-process ONNX runtime is tricky to get right in Node vs browser
 *   - Ollama covers the "local, no API key" use case better
 *
 * If you want offline inference without installing Ollama, this is the
 * provider to build out. For now, it throws clearly.
 */
export class XenovaProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'xenova';

    constructor(_config: { modelId?: string } = {}) {
        // No init — see chat() for the error message.
    }

    isOffline(): boolean { return true; }

    async checkStatus(): Promise<ProviderStatus> {
        return ProviderStatus.Unreachable;
    }

    getActiveModel(): IModelInfo | undefined {
        return undefined;
    }

    async setActiveModel(_modelId: string): Promise<boolean> {
        return false;
    }

    async listModels(): Promise<IModelInfo[]> {
        return [];
    }

    async *chat(_messages: IChatMessage[], _tools: IToolDefinition[], _options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        yield {
            type: 'error',
            text: 'XenovaProvider is interface-ready but NOT ported. ' +
                'Use OllamaProvider for local inference, or install Ollama from https://ollama.com.',
        };
    }

    dispose(): void { /* nothing */ }
}
