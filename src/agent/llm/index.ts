/**
 * Public API for LLM providers.
 *
 * VERIFIED providers (real transcripts in docs/PHASE0_REPORT.md):
 *   - CloudProvider with Anthropic key → Anthropic Claude
 *   - OllamaProvider → local Ollama instance
 *
 * INTERFACE-READY, UNTESTED stubs (see stubProviders.ts):
 *   - OpenAIProvider, OpenRouterProvider, NvidiaNimProvider, TogetherProvider,
 *     GroqProvider, MistralProvider, DeepSeekProvider, GeminiProvider,
 *     LmStudioProvider, LiteLLMProvider, XenovaProvider
 *
 * Use createProvider({ name, apiKey?, modelId? }) from providerFactory.ts as
 * the single entry point — it knows how to instantiate any registered provider.
 */

// Verified
export { CloudProvider, type CloudProviderConfig, type LLMProvider } from './cloudProvider.js';
export { OllamaProvider, type OllamaProviderConfig } from './ollamaProvider.js';

// Stubs (interface-ready, untested)
export {
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

// Factory (preferred entry point)
export {
    createProvider,
    listProviders,
    type ProviderName,
    type CreateProviderOptions,
} from './providerFactory.js';

// Types
export * from './types.js';
