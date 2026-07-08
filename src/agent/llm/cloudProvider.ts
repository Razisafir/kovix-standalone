/**
 * CloudProvider - concrete AI provider for cloud APIs.
 *
 * Ported from Kovix_2.0 src/vs/workbench/contrib/construct/browser/services/llm/cloudProvider.ts
 *
 * CHANGE FROM VS CODE FORK:
 *   - Removed `Disposable` base class + Emitter (VS Code event system).
 *     Provider status changes are now silent (the agent loop doesn't consume
 *     them in this code path). If we need to surface status to the UI later,
 *     we'll add a plain callback.
 *   - Removed `@ILogService`, `@IConfigurationService`, `@IStorageService`,
 *     `@ISecureKeyManager` DI. Constructor now takes a plain config object:
 *       { apiKey, modelId?, baseUrl?, provider? }
 *     The key resolution waterfall (keychain → storage → config) is gone —
 *     the caller is responsible for getting the key. In production this'll
 *     be the new SecureKeyManager equivalent; in tests it's `process.env`.
 *   - Removed `complete()` method (inline Copilot completion — not used by
 *     the agent loop, will rebuild for the new UI later).
 *   - Removed OpenRouter-specific HTTP-Referer / X-Title headers (not used
 *     by Anthropic path; will re-add when we wire OpenRouter back up).
 *   - Kept the full Anthropic SSE streaming parser verbatim. This is the
 *     critical path — touch it and you risk breaking tool_use parsing.
 *   - Kept the OpenAI-compatible chat path verbatim too (still useful for
 *     OpenRouter / LM Studio / Together / Groq / NVIDIA NIM).
 *   - Removed `anthropic-dangerous-direct-browser-access` header — that
 *     was only needed because VS Code's renderer ran in a browser context.
 *     We're in Node now; the header is unnecessary and Anthropic's docs
 *     recommend omitting it for server-side calls.
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
    ConstructAuthError,
    ConstructRateLimitError,
    ConstructOverloadedError,
} from './types.js';
import { redactSecrets } from '../security/secretPatterns.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_RETRIES = 3;

/** Which LLM provider the API key is for. Auto-detected from key prefix. */
export type LLMProvider =
    | 'anthropic'
    | 'openai'
    | 'nvidia' | 'openrouter' | 'lmstudio' | 'together'
    | 'groq' | 'mistral' | 'gemini' | 'deepseek' | 'litellm' | 'custom';

/**
 * Plain config object — replaces the 4 VS Code services the original
 * CloudProvider pulled in via DI.
 */
export interface CloudProviderConfig {
    /** API key. Required. For Anthropic, must start with `sk-ant-`. */
    apiKey: string;
    /**
     * Model ID to use. If omitted, defaults to DEFAULT_ANTHROPIC_MODEL for
     * Anthropic keys, or the first model returned by /models for OpenAI-compat.
     */
    modelId?: string;
    /**
     * Base URL for OpenAI-compatible providers. Ignored for Anthropic keys
     * (Anthropic has a fixed endpoint). Defaults to OpenAI.
     */
    baseUrl?: string;
    /**
     * Explicit provider hint. If omitted, auto-detected from the key prefix
     * (sk-ant- → anthropic, everything else → openai-compatible).
     */
    provider?: LLMProvider;
}

interface IAnthropicSSEChunk {
    type: string;
    content_block?: { type: string; id?: string; name?: string; text?: string };
    delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
    error?: { message?: string };
}

/**
 * CloudProvider — concrete AI provider for cloud APIs.
 *
 * Supports:
 *   - Anthropic Messages API (auto-detected from `sk-ant-` key prefix)
 *   - OpenAI-compatible APIs (OpenAI, OpenRouter, Together, Groq, LM Studio,
 *     LiteLLM, NVIDIA NIM, Mistral, DeepSeek, Gemini OpenAI-compat)
 */
export class CloudProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';

    private _activeModel: IModelInfo | undefined;
    private _status: ProviderStatus = ProviderStatus.Unknown;
    private _baseUrl: string;
    private _apiKey: string;
    private _activeLLMProvider: LLMProvider;
    private _customModels: IModelInfo[] = [];

    constructor(config: CloudProviderConfig) {
        if (!config.apiKey) {
            throw new Error('CloudProvider: apiKey is required');
        }
        this._apiKey = config.apiKey;
        this._baseUrl = config.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
        this._activeLLMProvider = config.provider ?? (this.isAnthropicKey ? 'anthropic' : 'openai');

        // Resolve initial model
        const modelId = config.modelId ?? DEFAULT_ANTHROPIC_MODEL;
        this._activeModel = {
            id: modelId,
            displayName: modelId,
            provider: 'cloud',
            contextWindowTokens: 200_000,
            supportsTools: true,
            supportsStreaming: true,
        };

        // Pre-populate the Anthropic known-models list so listModels() works
        // without a network call (Anthropic has no /models endpoint).
        if (this.isAnthropicKey) {
            this._customModels = [
                { id: DEFAULT_ANTHROPIC_MODEL, displayName: 'Claude Sonnet 4', provider: 'cloud', contextWindowTokens: 200_000, supportsTools: true, supportsStreaming: true },
                { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', provider: 'cloud', contextWindowTokens: 200_000, supportsTools: true, supportsStreaming: true },
                { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku', provider: 'cloud', contextWindowTokens: 200_000, supportsTools: true, supportsStreaming: true },
            ];
        }

        // Redact key in any future log; just a no-op for now.
        void redactSecrets;
    }

    private get isAnthropicKey(): boolean {
        return this._apiKey.startsWith('sk-ant-');
    }

    private _buildHeaders(): Record<string, string> {
        return {
            'Authorization': 'Bearer ' + this._apiKey,
            'Content-Type': 'application/json',
        };
    }

    private _setStatus(status: ProviderStatus): void {
        this._status = status;
    }

    isOffline(): boolean {
        return false;
    }

    async checkStatus(): Promise<ProviderStatus> {
        if (!this._apiKey) {
            this._setStatus(ProviderStatus.NoModels);
            return this._status;
        }
        if (this.isAnthropicKey) {
            // Anthropic has no /models endpoint; trust the key format.
            this._setStatus(ProviderStatus.Available);
            return this._status;
        }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const response = await fetch(this._baseUrl + '/models', {
                headers: this._buildHeaders(),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) {
                this._setStatus(ProviderStatus.Unreachable);
                return this._status;
            }
            const data = await response.json() as { data?: Array<{ id: string }> };
            if (!data.data || data.data.length === 0) {
                this._setStatus(ProviderStatus.NoModels);
                return this._status;
            }
            this._setStatus(ProviderStatus.Available);
            return this._status;
        } catch {
            this._setStatus(ProviderStatus.Unreachable);
            return this._status;
        }
    }

    async listModels(): Promise<IModelInfo[]> {
        if (this.isAnthropicKey) {
            return this._customModels;
        }
        try {
            const response = await fetch(this._baseUrl + '/models', {
                headers: this._buildHeaders(),
            });
            if (!response.ok) {
                return this._customModels;
            }
            const data = await response.json() as { data?: Array<{ id: string }> };
            return (data.data ?? []).map(m => ({
                id: m.id,
                displayName: m.id,
                provider: 'cloud' as AIProviderType,
                contextWindowTokens: 128_000,
                supportsTools: true,
                supportsStreaming: true,
            }));
        } catch {
            return this._customModels;
        }
    }

    getActiveModel(): IModelInfo | undefined {
        return this._activeModel;
    }

    async setActiveModel(modelId: string): Promise<boolean> {
        // For Anthropic: trust the caller (no /models endpoint to verify against).
        // For OpenAI-compat: also trust — the model list is best-effort.
        const known = this._customModels.find(m => m.id === modelId);
        this._activeModel = known ?? {
            id: modelId,
            displayName: modelId,
            provider: 'cloud',
            contextWindowTokens: 200_000,
            supportsTools: true,
            supportsStreaming: true,
        };
        return true;
    }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        if (!this._apiKey) {
            yield { type: 'error', text: 'No API key configured.' };
            return;
        }
        if (!this._activeModel) {
            yield { type: 'error', text: 'No active model set.' };
            return;
        }
        if (this.isAnthropicKey) {
            yield* this.chatAnthropic(messages, tools, options);
        } else {
            yield* this.chatOpenAI(messages, tools, options);
        }
    }

    // ----------------------------------------------------------------------
    // Anthropic Messages API
    // ----------------------------------------------------------------------

    private async *chatAnthropic(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        const anthropicMessages = this.convertToAnthropicMessages(messages);
        const anthropicTools = this.convertToAnthropicTools(tools);

        const body: Record<string, unknown> = {
            model: this._activeModel!.id,
            max_tokens: options?.maxTokens ?? 8192,
            messages: anthropicMessages,
            stream: true,
        };
        if (options?.systemPrompt) {
            body.system = options.systemPrompt;
        }
        if (anthropicTools.length > 0) {
            body.tools = anthropicTools;
        }

        let retryCount = 0;
        while (retryCount <= MAX_RETRIES) {
            try {
                const response = await fetch(ANTHROPIC_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this._apiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify(body),
                    signal: options?.signal,
                });

                if (response.status === 401) {
                    throw new ConstructAuthError('Anthropic API key is invalid. Please check your settings.');
                }
                if (response.status === 529) {
                    throw new ConstructOverloadedError('Anthropic API is overloaded. Please try again later.');
                }
                if (response.status === 429) {
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        const retryAfterHeader = response.headers.get('retry-after');
                        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
                        throw new ConstructRateLimitError('Rate limited by Anthropic API. Please try again later.', retryAfter);
                    }
                    const backoffMs = Math.pow(2, retryCount) * 1000;
                    yield { type: 'error', text: 'Rate limited. Retrying in ' + (backoffMs / 1000) + 's...' };
                    await this.sleep(backoffMs, options?.signal);
                    continue;
                }
                if (response.status >= 500) {
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        throw new ConstructOverloadedError('Anthropic API server error (' + response.status + ').');
                    }
                    await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
                    continue;
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    yield { type: 'error', text: 'Anthropic API error (' + response.status + '): ' + errorText };
                    return;
                }
                if (!response.body) {
                    yield { type: 'error', text: 'No response body from Anthropic API.' };
                    return;
                }

                // Parse Anthropic SSE stream
                let currentToolId: string | null = null;
                let currentToolName: string | null = null;
                let currentToolInput = '';

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) { break; }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
                            const jsonStr = trimmed.slice(6);
                            if (jsonStr === '[DONE]') { continue; }

                            let chunk: IAnthropicSSEChunk;
                            try {
                                chunk = JSON.parse(jsonStr) as IAnthropicSSEChunk;
                            } catch {
                                continue;
                            }

                            const eventType = chunk.type;

                            if (eventType === 'content_block_start') {
                                const contentBlock = chunk.content_block;
                                if (contentBlock?.type === 'tool_use') {
                                    currentToolId = contentBlock.id ?? null;
                                    currentToolName = contentBlock.name ?? null;
                                    currentToolInput = '';
                                    yield {
                                        type: 'tool_start',
                                        toolId: currentToolId ?? '',
                                        toolName: currentToolName ?? '',
                                    };
                                }
                            } else if (eventType === 'content_block_delta') {
                                const delta = chunk.delta;
                                if (delta?.type === 'text_delta' && delta.text) {
                                    yield { type: 'token', text: delta.text };
                                } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                                    currentToolInput += delta.partial_json;
                                    yield {
                                        type: 'tool_input',
                                        toolId: currentToolId ?? '',
                                        text: delta.partial_json,
                                    };
                                }
                            } else if (eventType === 'content_block_stop') {
                                if (currentToolId && currentToolName) {
                                    let parsedInput: unknown = {};
                                    if (currentToolInput) {
                                        try {
                                            parsedInput = JSON.parse(currentToolInput);
                                        } catch {
                                            parsedInput = { raw: currentToolInput };
                                        }
                                    }
                                    yield {
                                        type: 'tool_end',
                                        toolId: currentToolId,
                                        toolName: currentToolName,
                                        toolInput: parsedInput,
                                    };
                                    currentToolId = null;
                                    currentToolName = null;
                                    currentToolInput = '';
                                }
                            } else if (eventType === 'message_delta') {
                                const delta = chunk.delta;
                                if (delta?.stop_reason) {
                                    yield { type: 'done', stopReason: delta.stop_reason };
                                }
                            } else if (eventType === 'error') {
                                yield { type: 'error', text: chunk.error?.message ?? 'Unknown streaming error' };
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
                return;
            } catch (error: unknown) {
                if (error instanceof Error && error.name === 'AbortError') {
                    yield { type: 'error', text: 'Request cancelled.' };
                    return;
                }
                if (error instanceof ConstructAuthError || error instanceof ConstructRateLimitError || error instanceof ConstructOverloadedError) {
                    yield { type: 'error', text: error.message };
                    return;
                }
                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    yield { type: 'error', text: 'Anthropic connection failed: ' + (error instanceof Error ? error.message : String(error)) };
                    return;
                }
                await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
            }
        }
    }

    // ----------------------------------------------------------------------
    // OpenAI-compatible chat completions API
    // ----------------------------------------------------------------------

    private async *chatOpenAI(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        const openaiMessages = this.convertMessages(messages, options?.systemPrompt);

        const body: Record<string, unknown> = {
            model: this._activeModel!.id,
            messages: openaiMessages,
            stream: true,
            max_tokens: options?.maxTokens ?? 4096,
            temperature: options?.temperature ?? 0.7,
        };

        if (tools.length > 0 && this._activeModel!.supportsTools) {
            body.tools = this.convertTools(tools);
            if (this._activeLLMProvider === 'nvidia' ||
                this._activeLLMProvider === 'groq' ||
                this._activeLLMProvider === 'together' ||
                this._activeLLMProvider === 'openrouter' ||
                this._activeLLMProvider === 'lmstudio' ||
                this._activeLLMProvider === 'litellm') {
                body.parallel_tool_calls = false;
            }
        }

        let retryCount = 0;
        while (retryCount <= MAX_RETRIES) {
            try {
                const response = await fetch(this._baseUrl + '/chat/completions', {
                    method: 'POST',
                    headers: this._buildHeaders(),
                    body: JSON.stringify(body),
                    signal: options?.signal,
                });

                if (response.status === 401) {
                    throw new ConstructAuthError('API key is invalid.');
                }
                if (response.status === 429) {
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        throw new ConstructRateLimitError('Rate limited.');
                    }
                    await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
                    continue;
                }
                if (response.status >= 500) {
                    retryCount++;
                    if (retryCount > MAX_RETRIES) {
                        throw new ConstructOverloadedError('Server error (' + response.status + ').');
                    }
                    await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
                    continue;
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    yield { type: 'error', text: 'API error (' + response.status + '): ' + errorText };
                    return;
                }
                if (!response.body) {
                    yield { type: 'error', text: 'No response body.' };
                    return;
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let currentToolId: string | null = null;
                let currentToolName: string | null = null;
                let currentToolArgs = '';

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) { break; }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
                            const jsonStr = trimmed.slice(6);
                            if (jsonStr === '[DONE]') {
                                yield { type: 'done', stopReason: 'stop' };
                                continue;
                            }
                            let chunk: {
                                choices?: Array<{
                                    delta?: {
                                        content?: string;
                                        tool_calls?: Array<{
                                            id?: string;
                                            function?: { name?: string; arguments?: string };
                                        }>;
                                    };
                                    finish_reason?: string;
                                }>;
                            };
                            try {
                                chunk = JSON.parse(jsonStr);
                            } catch {
                                continue;
                            }
                            const choice = chunk.choices?.[0];
                            if (!choice) { continue; }
                            const delta = choice.delta;

                            if (delta?.content) {
                                yield { type: 'token', text: delta.content };
                            }
                            if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                for (const tc of delta.tool_calls) {
                                    if (tc.id && tc.function?.name) {
                                        currentToolId = tc.id;
                                        currentToolName = tc.function.name;
                                        currentToolArgs = tc.function.arguments ?? '';
                                        yield {
                                            type: 'tool_start',
                                            toolId: currentToolId,
                                            toolName: currentToolName,
                                        };
                                    } else if (tc.function?.arguments) {
                                        currentToolArgs += tc.function.arguments;
                                        yield {
                                            type: 'tool_input',
                                            toolId: currentToolId ?? '',
                                            text: tc.function.arguments,
                                        };
                                    }
                                }
                            }
                            if (choice.finish_reason === 'tool_calls' && currentToolId && currentToolName) {
                                let parsedInput: unknown = {};
                                try {
                                    parsedInput = JSON.parse(currentToolArgs || '{}');
                                } catch {
                                    parsedInput = { raw: currentToolArgs };
                                }
                                yield {
                                    type: 'tool_end',
                                    toolId: currentToolId,
                                    toolName: currentToolName,
                                    toolInput: parsedInput,
                                };
                                currentToolId = null;
                                currentToolName = null;
                                currentToolArgs = '';
                            }
                            if (choice.finish_reason === 'stop') {
                                yield { type: 'done', stopReason: 'stop' };
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
                return;
            } catch (error: unknown) {
                if (error instanceof Error && error.name === 'AbortError') {
                    yield { type: 'error', text: 'Request cancelled.' };
                    return;
                }
                if (error instanceof ConstructAuthError || error instanceof ConstructRateLimitError || error instanceof ConstructOverloadedError) {
                    yield { type: 'error', text: error.message };
                    return;
                }
                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    yield { type: 'error', text: 'Connection failed: ' + (error instanceof Error ? error.message : String(error)) };
                    return;
                }
                await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
            }
        }
    }

    // ----------------------------------------------------------------------
    // Message + tool format converters (verbatim from VS Code fork)
    // ----------------------------------------------------------------------

    private convertMessages(messages: IChatMessage[], systemPrompt?: string): Array<Record<string, unknown>> {
        const result: Array<Record<string, unknown>> = [];
        if (systemPrompt) {
            result.push({ role: 'system', content: systemPrompt });
        }
        for (const msg of messages) {
            if (msg.role === 'system') {
                result.push({ role: 'system', content: msg.content });
            } else if (msg.role === 'user') {
                result.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                const assistantMsg: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.arguments },
                    }));
                }
                result.push(assistantMsg);
            } else if (msg.role === 'tool') {
                result.push({
                    role: 'tool',
                    content: msg.content,
                    tool_call_id: msg.toolCallId,
                });
            }
        }
        return result;
    }

    private convertToAnthropicMessages(messages: IChatMessage[]): Array<Record<string, unknown>> {
        const result: Array<Record<string, unknown>> = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                continue;
            } else if (msg.role === 'user') {
                result.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                const contentBlocks: Array<Record<string, unknown>> = [];
                if (msg.content) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                }
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        let parsedArgs: unknown = {};
                        try {
                            parsedArgs = JSON.parse(tc.arguments);
                        } catch {
                            parsedArgs = { raw: tc.arguments };
                        }
                        contentBlocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: parsedArgs,
                        });
                    }
                }
                result.push({
                    role: 'assistant',
                    content: contentBlocks.length > 0 ? contentBlocks : msg.content,
                });
            } else if (msg.role === 'tool') {
                result.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.toolCallId,
                        content: msg.content,
                    }],
                });
            }
        }
        while (result.length > 0 && (result[0] as { role: string }).role !== 'user') {
            result.shift();
        }
        return result;
    }

    private convertToAnthropicTools(tools: IToolDefinition[]): Array<Record<string, unknown>> {
        return tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
        }));
    }

    private convertTools(tools: IToolDefinition[]): Array<Record<string, unknown>> {
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }));
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Aborted'));
            }, { once: true });
        });
    }

    dispose(): void {
        // Nothing to release — no workers, no open connections.
    }
}
