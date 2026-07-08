/**
 * OllamaProvider - concrete AI provider for a local Ollama instance.
 *
 * Ported from Kovix_2.0 src/vs/workbench/contrib/construct/browser/services/llm/ollamaProvider.ts
 *
 * CHANGE FROM VS CODE FORK:
 *   - Removed `Disposable` base class + `Emitter` (VS Code event system).
 *     Status changes are silent; the agent loop doesn't consume them in this
 *     code path. If we need to surface status to the UI later, we'll add a
 *     plain callback.
 *   - Removed `@ILogService`, `@IConfigurationService` DI. Constructor now
 *     takes a plain config object: { baseUrl?, modelId? }.
 *   - Removed `complete()` method (inline Copilot-style completion — not used
 *     by the agent loop, will rebuild for the new UI later).
 *   - Removed the `DOMException`-based AbortError check. In Node, `fetch`
 *     rejects with a regular Error whose `name` is `'AbortError'`.
 *   - Kept the full Ollama NDJSON streaming parser verbatim. This is the
 *     critical path — touch it and you risk breaking tool_call parsing.
 *   - Kept the model-context-window heuristic verbatim (used by listModels()
 *     since Ollama doesn't expose context window in /api/tags).
 *   - Kept the auto-select-model-on-checkStatus logic, but the configured
 *     model is now read from the config object instead of IConfigurationService.
 *
 * OFFLINE FIRST: Ollama runs entirely locally. If Ollama is not running,
 * checkStatus() returns ProviderStatus.Unreachable. The agent loop's
 * error handling will surface this to the user.
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

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

/**
 * Plain config object — replaces the 2 VS Code services the original
 * OllamaProvider pulled in via DI.
 */
export interface OllamaProviderConfig {
    /**
     * Base URL of the Ollama instance. Defaults to http://localhost:11434.
     * Override for remote Ollama servers or non-default ports.
     */
    baseUrl?: string;
    /**
     * Model ID to use. If omitted, the provider auto-selects the first
     * available model from /api/tags on first checkStatus() / chat() call.
     */
    modelId?: string;
}

/**
 * OllamaProvider — concrete AI provider for local Ollama instances.
 *
 * Supports:
 *   - /api/chat for streaming chat with tool support
 *   - /api/tags for listing available models
 *   - Auto-selection of the configured model (or first available)
 *
 * Ollama runs entirely locally — no API key, no internet required.
 */
export class OllamaProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'ollama';

    private _activeModel: IModelInfo | undefined;
    private _status: ProviderStatus = ProviderStatus.Unknown;
    private _baseUrl: string;
    private _configuredModel?: string;

    constructor(config: OllamaProviderConfig = {}) {
        this._baseUrl = (config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
        this._configuredModel = config.modelId;
    }

    isOffline(): boolean {
        return true;
    }

    async checkStatus(): Promise<ProviderStatus> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(this._baseUrl + '/api/tags', {
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!response.ok) {
                this._setStatus(ProviderStatus.Unreachable);
                return this._status;
            }

            const data = await response.json() as { models?: Array<{ name: string }> };
            if (!data.models || data.models.length === 0) {
                this._setStatus(ProviderStatus.NoModels);
                return this._status;
            }

            this._setStatus(ProviderStatus.Available);

            // Auto-select model: prefer configured model, fall back to first available
            if (!this._activeModel) {
                const models = await this.listModels();
                if (models.length > 0) {
                    if (this._configuredModel) {
                        const found = models.find(m =>
                            m.id === this._configuredModel ||
                            m.id.startsWith(this._configuredModel + ':'),
                        );
                        if (found) {
                            await this.setActiveModel(found.id);
                        } else {
                            await this.setActiveModel(models[0].id);
                        }
                    } else {
                        await this.setActiveModel(models[0].id);
                    }
                }
            }

            return this._status;
        } catch {
            this._setStatus(ProviderStatus.Unreachable);
            return this._status;
        }
    }

    getActiveModel(): IModelInfo | undefined {
        return this._activeModel;
    }

    async setActiveModel(modelId: string): Promise<boolean> {
        const models = await this.listModels();
        const model = models.find(m => m.id === modelId);
        if (!model) {
            return false;
        }
        this._activeModel = model;
        return true;
    }

    async listModels(): Promise<IModelInfo[]> {
        try {
            const response = await fetch(this._baseUrl + '/api/tags');
            if (!response.ok) {
                return [];
            }

            const data = await response.json() as {
                models: Array<{
                    name: string;
                    model: string;
                    size?: number;
                    details?: { parameter_size?: string; family?: string };
                }>;
            };

            return (data.models || []).map(m => {
                const modelName = m.name || m.model;
                const family = m.details?.family?.toLowerCase() ?? '';
                const supportsTools = family.includes('llama') ||
                    family.includes('mistral') ||
                    family.includes('qwen') ||
                    family.includes('command');
                const contextWindowTokens = this.estimateContextWindow(modelName, m.details?.parameter_size);

                return {
                    id: modelName,
                    displayName: modelName,
                    provider: 'ollama' as AIProviderType,
                    contextWindowTokens,
                    supportsTools,
                    supportsStreaming: true,
                } satisfies IModelInfo;
            });
        } catch {
            return [];
        }
    }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        if (!this._activeModel) {
            // Try auto-selecting a model on first chat if checkStatus() wasn't called
            const status = await this.checkStatus();
            if (status !== ProviderStatus.Available || !this._activeModel) {
                yield {
                    type: 'error',
                    text: 'Ollama is not reachable or has no models installed. ' +
                        'Install Ollama from https://ollama.com and pull a model with `ollama pull llama3.1`.',
                };
                return;
            }
        }

        const ollamaMessages = this.convertMessages(messages);

        const body: Record<string, unknown> = {
            model: this._activeModel.id,
            messages: ollamaMessages,
            stream: true,
            options: {
                num_predict: options?.maxTokens ?? 4096,
                temperature: options?.temperature ?? 0.7,
            },
        };

        if (options?.systemPrompt) {
            body.system = options.systemPrompt;
        }

        if (tools.length > 0 && this._activeModel.supportsTools) {
            body.tools = this.convertTools(tools);
        }

        let retryCount = 0;
        while (retryCount <= MAX_RETRIES) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                if (options?.signal) {
                    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
                }

                const response = await fetch(this._baseUrl + '/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status >= 500 && retryCount < MAX_RETRIES) {
                        retryCount++;
                        await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
                        continue;
                    }
                    yield { type: 'error', text: 'Ollama API error (' + response.status + '): ' + errorText };
                    return;
                }

                if (!response.body) {
                    yield { type: 'error', text: 'No response body from Ollama API.' };
                    return;
                }

                // Parse Ollama's NDJSON streaming format.
                // Each line is a JSON object with a partial response.
                // Tool calls arrive complete in a single chunk (not incremental deltas).
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
                            if (!trimmed) { continue; }

                            let chunk: Record<string, unknown>;
                            try {
                                chunk = JSON.parse(trimmed) as Record<string, unknown>;
                            } catch {
                                continue;
                            }

                            if (typeof chunk.message === 'object' && chunk.message !== null) {
                                const message = chunk.message as Record<string, unknown>;

                                if (message.content && typeof message.content === 'string') {
                                    const text = message.content as string;
                                    if (text.length > 0) {
                                        yield { type: 'token', text };
                                    }
                                }

                                if (message.tool_calls && Array.isArray(message.tool_calls)) {
                                    for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
                                        const func = tc.function as Record<string, unknown> | undefined;
                                        if (func) {
                                            const toolId = String(tc.id ?? 'tool_' + Date.now());
                                            const toolName = String(func.name ?? '');
                                            const toolArgs = typeof func.arguments === 'string'
                                                ? func.arguments
                                                : JSON.stringify(func.arguments ?? {});

                                            yield { type: 'tool_start', toolId, toolName };
                                            yield { type: 'tool_input', toolId, text: toolArgs };

                                            let parsedInput: unknown = {};
                                            try {
                                                parsedInput = JSON.parse(toolArgs);
                                            } catch {
                                                parsedInput = { raw: toolArgs };
                                            }
                                            yield { type: 'tool_end', toolId, toolName, toolInput: parsedInput };
                                        }
                                    }
                                }
                            }

                            if (chunk.done === true) {
                                yield { type: 'done', stopReason: 'stop' };
                                return;
                            }

                            if (chunk.error) {
                                yield { type: 'error', text: String(chunk.error) };
                                return;
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }

                // Stream ended without explicit done event
                yield { type: 'done', stopReason: 'stop' };
                return;

            } catch (error: unknown) {
                if (error instanceof Error && error.name === 'AbortError') {
                    yield { type: 'error', text: 'Request cancelled.' };
                    return;
                }

                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    yield { type: 'error', text: 'Ollama connection failed: ' + errorMsg };
                    return;
                }

                await this.sleep(Math.pow(2, retryCount) * 1000, options?.signal);
            }
        }
    }

    // --- Private helpers (verbatim from VS Code fork) ---

    private _setStatus(status: ProviderStatus): void {
        this._status = status;
    }

    private convertMessages(messages: IChatMessage[]): Array<Record<string, unknown>> {
        return messages.map(msg => {
            const result: Record<string, unknown> = { role: msg.role, content: msg.content };

            if (msg.toolCalls && msg.toolCalls.length > 0) {
                result.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: tc.arguments,
                    },
                }));
            }

            if (msg.toolCallId) {
                result.tool_call_id = msg.toolCallId;
            }

            return result;
        });
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

    /**
     * Estimate the context window size based on model name and parameter size.
     * Common Ollama models have known context windows; for unknown models,
     * we default to 4096 as a safe lower bound.
     */
    private estimateContextWindow(modelName: string, parameterSize?: string): number {
        const lowerName = modelName.toLowerCase();

        if (lowerName.includes('llama3.1') || lowerName.includes('llama-3.1')) {
            return 128_000;
        }
        if (lowerName.includes('llama3') || lowerName.includes('llama-3')) {
            return 8_192;
        }
        if (lowerName.includes('mistral') || lowerName.includes('mixtral')) {
            return 32_000;
        }
        if (lowerName.includes('qwen2.5') || lowerName.includes('qwen2')) {
            return 128_000;
        }
        if (lowerName.includes('codellama') || lowerName.includes('code-llama')) {
            return 16_384;
        }
        if (lowerName.includes('phi3') || lowerName.includes('phi-3')) {
            return 128_000;
        }
        if (lowerName.includes('gemma2') || lowerName.includes('gemma-2')) {
            return 8_192;
        }
        if (lowerName.includes('deepseek')) {
            return 64_000;
        }
        if (lowerName.includes('command')) {
            return 128_000;
        }

        if (parameterSize) {
            const sizeMatch = parameterSize.match(/(\d+)/);
            if (sizeMatch) {
                const params = parseInt(sizeMatch[1], 10);
                if (params >= 70) { return 128_000; }
                if (params >= 30) { return 32_000; }
                if (params >= 7) { return 8_192; }
            }
        }

        return 4_096;
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
        // Nothing to release — no persistent connections, no worker threads.
    }
}
