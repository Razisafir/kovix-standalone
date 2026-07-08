/**
 * LLM provider types.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/llm/constructAIProvider.ts
 *
 * CHANGE FROM VS CODE FORK:
 *   - Stripped the `createDecorator` import + IConstructAIProvider service
 *     decorator. We're not using VS Code's DI; we just export the types.
 *   - Stripped `Event` import — we don't fire VS Code events. Provider status
 *     changes will be reported via plain callbacks in the future UI layer.
 *   - Stripped `complete()` / `ICompleteOptions` / `ICompleteResult` — inline
 *     Copilot-style completion is a UI feature we'll rebuild later, not part
 *     of the agent core. Keeping it would force us to carry dead interface
 *     weight through every provider.
 *   - The IConstructAIProvider interface is preserved (with `_serviceBrand`
 *     removed) because CloudProvider implements it and the agent loop
 *     consumes it.
 */

export class ConstructAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConstructAuthError';
    }
}

export class ConstructRateLimitError extends Error {
    constructor(message: string, public readonly retryAfter?: number) {
        super(message);
        this.name = 'ConstructRateLimitError';
    }
}

export class ConstructOverloadedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConstructOverloadedError';
    }
}

export interface IModelInfo {
    /** Unique identifier for the model (e.g. 'claude-sonnet-4-20250514') */
    id: string;
    /** Human-readable name for display in the model picker */
    displayName: string;
    /** The provider that hosts this model */
    provider: AIProviderType;
    /** Approximate context window size in tokens */
    contextWindowTokens: number;
    /** Whether this model supports tool/function calling */
    supportsTools: boolean;
    /** Whether this model supports streaming responses */
    supportsStreaming: boolean;
}

export interface IChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** For tool_result messages: the ID of the tool call this is responding to */
    toolCallId?: string;
    /** For assistant messages: tool calls requested by the model */
    toolCalls?: IToolCall[];
}

export interface IToolCall {
    /** Unique ID for this tool call */
    id: string;
    /** Name of the tool to invoke */
    name: string;
    /** JSON-encoded arguments for the tool */
    arguments: string;
}

export interface IToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export type AIStreamEvent =
    | { type: 'token'; text: string }
    | { type: 'tool_start'; toolId: string; toolName: string }
    | { type: 'tool_input'; toolId: string; text: string }
    | { type: 'tool_end'; toolId: string; toolName: string; toolInput: unknown }
    | { type: 'done'; stopReason: string }
    | { type: 'error'; text: string };

export interface IChatOptions {
    /** AbortSignal for cancelling the request */
    signal?: AbortSignal;
    /** System prompt to prepend to the conversation */
    systemPrompt?: string;
    /** Maximum tokens to generate in the response */
    maxTokens?: number;
    /** Temperature for sampling (0.0 = deterministic, 1.0 = creative) */
    temperature?: number;
}

export type AIProviderType = 'ollama' | 'xenova' | 'cloud';

export enum ProviderStatus {
    Available = 'available',
    NoModels = 'noModels',
    Unreachable = 'unreachable',
    Unknown = 'unknown',
}

/**
 * The unified AI provider interface. Concrete implementations adapt their
 * respective backends to this interface. The agent loop only depends on
 * this abstraction.
 */
export interface IConstructAIProvider {
    /**
     * Stream a conversation to the active model, yielding AIStreamEvents.
     */
    chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent>;

    /** List all models available from this provider. */
    listModels(): Promise<IModelInfo[]>;

    /** Get the currently active model. */
    getActiveModel(): IModelInfo | undefined;

    /** Set the active model by ID. */
    setActiveModel(modelId: string): Promise<boolean>;

    /** Whether this provider can operate without internet. */
    isOffline(): boolean;

    /** Check the current status of this provider. */
    checkStatus(): Promise<ProviderStatus>;

    /** The type of this provider (ollama, xenova, or cloud). */
    readonly providerType: AIProviderType;

    /** Dispose the provider and release resources. */
    dispose(): void;
}
