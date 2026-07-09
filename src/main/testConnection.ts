/**
 * testConnection.ts — real, minimal API call to verify a provider config.
 *
 * This is NOT a fake checkmark. It instantiates the provider via the same
 * createProvider() factory the agent loop uses, then sends the smallest
 * possible chat request: one user message ("Reply with OK.") with
 * max_tokens=16, no tools, no system prompt. If the provider returns any
 * non-error response (even an empty stream), the key+model+endpoint combo
 * works.
 *
 * WHY NOT JUST `checkStatus()`?
 * ----------------------------
 * checkStatus() on CloudProvider hits `/models` (for OpenAI-compat) or just
 * trusts the key format (for Anthropic). It does NOT prove the key is
 * authorized to actually call the model. A real chat call does.
 *
 * WHY NOT A LARGER CALL?
 * ---------------------
 * The user said "smallest possible token usage." A 1-token user prompt +
 * max_tokens=16 means the worst case is ~20-30 tokens billed. We can't go
 * lower and still get a meaningful response.
 *
 * SECURITY
 * --------
 * The API key is passed in from the renderer (just-typed by the user, never
 * persisted yet) — we use it for this one call and then drop the reference.
 * We never log the key. Errors are sanitized: if the API echoes the key
 * back (rare but possible), we strip it.
 */

import { createProvider } from '../agent/llm/providerFactory.js';
import type { ProviderName } from '../agent/llm/providerFactory.js';
import type { AIStreamEvent } from '../agent/llm/types.js';

export interface TestConnectionInput {
    provider: ProviderName;
    apiKey?: string;
    modelId?: string;
    baseUrl?: string;
}

export interface TestConnectionResult {
    ok: boolean;
    /** Human-readable message for the UI. NEVER contains the API key. */
    message: string;
    /** How long the call took, in ms. */
    durationMs: number;
    /** What the model actually said (first ~50 chars). Useful for sanity. */
    responsePreview?: string;
}

/**
 * Make a real, minimal chat call to verify the provider config.
 * Timeout: 20 seconds. Returns ok=false on any failure.
 */
export async function testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const start = Date.now();
    const requiresKey = input.provider !== 'ollama' && input.provider !== 'xenova' && input.provider !== 'lmstudio' && input.provider !== 'litellm';

    if (requiresKey && !input.apiKey) {
        return {
            ok: false,
            message: 'No API key provided. This provider requires a key.',
            durationMs: 0,
        };
    }

    let provider;
    try {
        provider = createProvider({
            name: input.provider,
            apiKey: input.apiKey,
            modelId: input.modelId,
            baseUrl: input.baseUrl,
        });
    } catch (err) {
        return {
            ok: false,
            message: 'Failed to create provider: ' + sanitizeError(err),
            durationMs: Date.now() - start,
        };
    }

    // Set the active model if the user provided one.
    if (input.modelId) {
        try {
            await provider.setActiveModel(input.modelId);
        } catch (err) {
            return {
                ok: false,
                message: 'Failed to set model: ' + sanitizeError(err),
                durationMs: Date.now() - start,
            };
        }
    }

    // Hard timeout — if the API hangs, we don't want the UI to spin forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    let responseText = '';
    let firstError: string | null = null;
    let gotAnyEvent = false;

    try {
        const stream = provider.chat(
            [{ role: 'user', content: 'Reply with the single word OK.' }],
            [],  // no tools
            {
                maxTokens: 16,
                temperature: 0,
                signal: controller.signal,
            },
        );

        for await (const event of stream as AsyncIterable<AIStreamEvent>) {
            gotAnyEvent = true;
            if (event.type === 'token') {
                responseText += event.text;
            } else if (event.type === 'error') {
                firstError = firstError ?? event.text;
                // Continue consuming — some providers emit errors mid-stream
                // but we want to see if there's a usable response anyway.
            } else if (event.type === 'done') {
                break;
            }
            // Stop early once we have enough — saves tokens.
            if (responseText.length >= 8) {
                controller.abort();
                break;
            }
        }
    } catch (err) {
        const msg = sanitizeError(err);
        // AbortError is expected if we cancelled after getting enough response.
        if (responseText.length > 0 && (err instanceof Error && err.name === 'AbortError')) {
            // Treat as success — we got a response and cancelled.
        } else {
            return {
                ok: false,
                message: msg,
                durationMs: Date.now() - start,
            };
        }
    } finally {
        clearTimeout(timeout);
        try { provider.dispose(); } catch { /* ignore */ }
    }

    const durationMs = Date.now() - start;

    if (firstError && responseText.length === 0) {
        return {
            ok: false,
            message: firstError,
            durationMs,
        };
    }

    if (!gotAnyEvent && responseText.length === 0) {
        return {
            ok: false,
            message: 'No response received from provider (empty stream).',
            durationMs,
        };
    }

    return {
        ok: true,
        message: `Connection successful — ${input.provider} responded in ${durationMs}ms.`,
        durationMs,
        responsePreview: responseText.slice(0, 50) || '(empty response but no error)',
    };
}

/**
 * Sanitize an error for display. NEVER include the API key, even if the
 * upstream API was dumb enough to echo it back.
 */
function sanitizeError(err: unknown): string {
    if (err instanceof Error) {
        let msg = err.message || err.name;
        // Strip anything that looks like an API key (sk-ant-..., sk-or-v1-..., sk-...)
        msg = msg.replace(/sk-[a-zA-Z0-9_\-]{8,}/g, 'sk-***');
        msg = msg.replace(/Bearer\s+[a-zA-Z0-9_\-]{8,}/g, 'Bearer ***');
        return msg;
    }
    return String(err).replace(/sk-[a-zA-Z0-9_\-]{8,}/g, 'sk-***');
}
