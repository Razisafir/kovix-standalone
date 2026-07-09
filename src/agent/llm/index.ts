/**
 * Public API for LLM providers.
 *
 * VERIFIED providers (real transcripts in docs/PHASE0_REPORT.md):
 *   - CloudProvider with Anthropic key → Anthropic Claude
 *   - OllamaProvider → local Ollama instance
 *
 * INTERFACE-READY, BLOCKED on key for end-to-end verification:
 *   - NvidiaNimProvider (see nvidiaProvider.ts + test/verify-nvidia.ts)
 *
 * INTERFACE-READY, UNTESTED stubs (see stubProviders.ts):
 *   - OpenAIProvider, OpenRouterProvider, TogetherProvider,
 *     GroqProvider, MistralProvider, DeepSeekProvider, GeminiProvider,
 *     LmStudioProvider, LiteLLMProvider, XenovaProvider
 *
 * Use createProvider({ name, apiKey?, modelId? }) from providerFactory.ts as
 * the single entry point — it knows how to instantiate any registered provider.
 */

// Verified
export { CloudProvider, type CloudProviderConfig, type LLMProvider } from './cloudProvider.js';
export { OllamaProvider, type OllamaProviderConfig } from './ollamaProvider.js';

// NVIDIA NIM — dedicated class (BLOCKED on key for e2e verification)
export { NvidiaNimProvider, type NvidiaNimProviderConfig, NVIDIA_NIM_BASE_URL, NVIDIA_NIM_DEFAULT_MODEL, NVIDIA_NIM_FALLBACK_MODELS } from './nvidiaProvider.js';

// Stubs (interface-ready, untested)
export {
    OpenAIProvider,
    OpenRouterProvider,
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

// Factory (preferred entry point)
export {
    createProvider,
    listProviders,
    type ProviderName,
    type CreateProviderOptions,
} from './providerFactory.js';

// Types
export * from './types.js';
