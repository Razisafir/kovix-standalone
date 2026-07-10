/**
 * LLM Provider Adapter -- Phase 4 Step 1.
 *
 * The agent core's native provider interface is `IConstructAIProvider`, which
 * streams `AIStreamEvent` objects (token / tool_start / tool_input / tool_end /
 * done / error) via an async iterable. That shape is great for real-time UI
 * streaming but awkward for:
 *   - Deterministic unit tests (you have to script a stream of events)
 *   - A second LLM call whose only purpose is a single yes/no judgement
 *     (the verification gate in MilestoneTaskRunner)
 *   - Any non-streaming consumer that just wants "the model's full reply"
 *
 * This module defines a non-streaming `LLMProvider` interface plus an adapter
 * that wraps any `IConstructAIProvider` into it. The adapter:
 *   1. Translates `LLMMessage[]` -> `IChatMessage[]`
 *   2. Translates `LLMToolSchema[]` (OpenAI function-calling format) ->
 *      `IToolDefinition[]` (the native schema shape)
 *   3. Drains the entire `AIStreamEvent` stream into a single `LLMResponse`:
 *      - token events -> concatenated into `content`
 *      - tool_start / tool_input / tool_end events -> collected into
 *        `tool_calls[]` (matching the OpenAI wire format)
 *      - done event -> `stop_reason`
 *   4. If the wrapped provider doesn't actually support tools (some local
 *      models and Xenova stub), the adapter still returns a text-only
 *      `LLMResponse` and logs a warning -- the caller is responsible for
 *      deciding what to do with `tool_calls === undefined`.
 *
 * TYPE NAMING NOTE:
 *   `cloudProvider.ts` already exports a `LLMProvider` *type alias* (a string
 *   union of provider names like 'anthropic' | 'openai' | ...). This module
 *   exports an *interface* also named `LLMProvider`. TypeScript keeps these
 *   distinct as long as a single file doesn't import both with the same local
 *   name. Test files in this package import only from this adapter module, so
 *   there's no collision in practice.
 */

import {
    IConstructAIProvider,
    IChatMessage,
    IToolDefinition,
    AIStreamEvent,
    IChatOptions,
} from './llm/types.js';

// ----------------------------------------------------------------------
// Non-streaming LLM types (OpenAI function-calling format)
// ----------------------------------------------------------------------

/**
 * Tool schema in OpenAI function-calling format.
 * `{ type: 'function', function: { name, description, parameters } }`
 * `parameters` is a JSON Schema object describing the function's arguments.
 */
export interface LLMToolSchema {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

/**
 * A tool call emitted by the model in its response, in OpenAI format.
 * `arguments` is a JSON-encoded string (NOT a parsed object) -- this matches
 * the OpenAI wire format and lets the caller decide when to parse.
 */
export interface LLMToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Present on assistant messages that requested tool calls. */
    tool_calls?: LLMToolCall[];
    /** Present on tool-result messages: the id of the tool call being answered. */
    tool_call_id?: string;
    /** Optional tool name (OpenAI includes this on tool-result messages). */
    name?: string;
}

export interface LLMResponse {
    role: 'assistant';
    content: string;
    /** Tool calls requested by the model. Undefined when no tools were called. */
    tool_calls?: LLMToolCall[];
    /**
     * Why the model stopped generating. Common values:
     *   - 'stop' / 'end_turn'      : natural end-of-turn
     *   - 'tool_use' / 'tool_calls': model wants to call tools (caller should
     *                                 execute and feed results back)
     *   - 'max_tokens'             : hit the length cap
     *   - 'error'                  : adapter collected an error event
     */
    stop_reason: string;
}

/**
 * Non-streaming LLM provider interface. The single `chat()` call returns the
 * model's complete response (text + any tool_calls + stop reason).
 *
 * `tools` is optional; when omitted, the model is called without a tool
 * schema (useful for the planning phase and the verification gate, where we
 * want a free-form answer rather than a function call).
 */
export interface LLMProvider {
    chat(messages: LLMMessage[], tools?: LLMToolSchema[]): Promise<LLMResponse>;
}

// ----------------------------------------------------------------------
// Translation helpers
// ----------------------------------------------------------------------

function translateMessage(msg: LLMMessage): IChatMessage {
    const out: IChatMessage = { role: msg.role, content: msg.content };
    if (msg.tool_calls) {
        out.toolCalls = msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
        }));
    }
    if (msg.tool_call_id) {
        out.toolCallId = msg.tool_call_id;
    }
    return out;
}

function translateMessages(msgs: LLMMessage[]): IChatMessage[] {
    return msgs.map(translateMessage);
}

function translateToolSchema(tool: LLMToolSchema): IToolDefinition {
    return {
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: tool.function.parameters,
    };
}

function translateToolSchemas(tools: LLMToolSchema[]): IToolDefinition[] {
    return tools.map(translateToolSchema);
}

// ----------------------------------------------------------------------
// Stream draining
// ----------------------------------------------------------------------

interface CollectedStream {
    content: string;
    toolCalls: LLMToolCall[];
    stopReason: string;
    error: string | null;
}

/**
 * Consume the entire `AIStreamEvent` stream from the wrapped provider and
 * collapse it into a single CollectedStream.
 *
 * Stream event semantics:
 *   - `token`        : append text to content
 *   - `tool_start`   : start a new tool call (id + name); arguments placeholder
 *   - `tool_input`   : incremental argument text (some providers stream the
 *                       JSON arguments token-by-token; we accumulate it)
 *   - `tool_end`     : finalize the tool call; if `toolInput` is present,
 *                       it OVERRIDES any streamed argument text (the final
 *                       parsed object is authoritative)
 *   - `done`         : capture stopReason
 *   - `error`        : capture error text; we keep draining but the response
 *                       will carry stop_reason='error'
 */
async function drainStream(stream: AsyncIterable<AIStreamEvent>): Promise<CollectedStream> {
    const result: CollectedStream = {
        content: '',
        toolCalls: [],
        stopReason: 'stop',
        error: null,
    };

    // Per-tool-call accumulator: id -> { name, argsBuffer }
    // tool_input events may arrive incrementally before tool_end finalizes.
    const toolCallMap = new Map<string, { name: string; argsBuffer: string; finalized: boolean }>();

    for await (const event of stream) {
        switch (event.type) {
            case 'token':
                result.content += event.text;
                break;
            case 'tool_start': {
                if (!toolCallMap.has(event.toolId)) {
                    toolCallMap.set(event.toolId, { name: event.toolName, argsBuffer: '', finalized: false });
                }
                break;
            }
            case 'tool_input': {
                const entry = toolCallMap.get(event.toolId);
                if (entry && !entry.finalized) {
                    entry.argsBuffer += event.text;
                }
                break;
            }
            case 'tool_end': {
                const entry = toolCallMap.get(event.toolId);
                const finalArgs =
                    event.toolInput !== undefined
                        ? JSON.stringify(event.toolInput)
                        : (entry?.argsBuffer ?? '{}');
                if (entry) {
                    entry.finalized = true;
                    entry.argsBuffer = finalArgs;
                }
                result.toolCalls.push({
                    id: event.toolId,
                    type: 'function',
                    function: {
                        name: event.toolName,
                        arguments: finalArgs,
                    },
                });
                break;
            }
            case 'done':
                result.stopReason = event.stopReason;
                break;
            case 'error':
                result.error = event.text;
                break;
        }
    }

    return result;
}

// ----------------------------------------------------------------------
// Adapter factory
// ----------------------------------------------------------------------

export interface LLMProviderAdapterOptions {
    /** Optional logger -- adapter will warn here if tools are unsupported. */
    log?: (message: string) => void;
    /** Default chat options (signal/systemPrompt/maxTokens/temperature). */
    defaultOptions?: IChatOptions;
}

/**
 * Wrap an `IConstructAIProvider` (streaming) into a non-streaming `LLMProvider`.
 *
 * The returned object's `chat()` method:
 *   1. Translates `LLMMessage[]` -> `IChatMessage[]`
 *   2. Translates `LLMToolSchema[]` -> `IToolDefinition[]` (or `[]` if omitted)
 *   3. Calls `provider.chat(messages, tools, options)` and drains the stream
 *   4. Returns a single `LLMResponse`
 *
 * Graceful degradation: if the provider's active model claims
 * `supportsTools === false` (consulted via `getActiveModel()`), the adapter
 * passes an empty tool list and logs a warning. The response's `tool_calls`
 * will then be undefined, and the caller can decide whether to surface that
 * to the user or fall back to a text-only mode.
 */
export function wrapProvider(
    provider: IConstructAIProvider,
    options: LLMProviderAdapterOptions = {},
): LLMProvider {
    const { log, defaultOptions } = options;

    return {
        async chat(messages: LLMMessage[], tools?: LLMToolSchema[]): Promise<LLMResponse> {
            const iMessages = translateMessages(messages);

            // Decide whether to actually pass tools. The IConstructAIProvider
            // signature REQUIRES a tools array (even if empty), so we always
            // pass one -- but if the active model doesn't support tools, we
            // pass [] and log a warning so the caller knows.
            let iTools: IToolDefinition[] = [];
            if (tools && tools.length > 0) {
                const active = provider.getActiveModel();
                if (active && !active.supportsTools) {
                    log?.(`[LLMProviderAdapter] Active model '${active.id}' does not support tools; calling text-only.`);
                    iTools = [];
                } else {
                    iTools = translateToolSchemas(tools);
                }
            }

            const mergedOptions: IChatOptions = { ...(defaultOptions ?? {}) };
            const stream = provider.chat(iMessages, iTools, mergedOptions);
            const collected = await drainStream(stream);

            if (collected.error) {
                return {
                    role: 'assistant',
                    content: collected.content,
                    stop_reason: 'error',
                };
            }

            const response: LLMResponse = {
                role: 'assistant',
                content: collected.content,
                stop_reason: collected.stopReason,
            };
            if (collected.toolCalls.length > 0) {
                response.tool_calls = collected.toolCalls;
            }
            return response;
        },
    };
}

// ----------------------------------------------------------------------
// Convenience: build an LLMToolSchema from an IToolDefinition
// ----------------------------------------------------------------------

/**
 * Convert one of the agent's native `IToolDefinition` objects into the OpenAI
 * function-calling `LLMToolSchema` format the adapter expects. This is what
 * the MilestoneTaskRunner uses to hand its tool catalog to the LLM via the
 * adapter.
 */
export function toToolSchema(tool: IToolDefinition): LLMToolSchema {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    };
}
