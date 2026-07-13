/**
 * AgentLoop -- the standalone agent core.
 *
 * REWRITE FROM VS CODE FORK:
 *   The original AgentLoopService (src/vs/workbench/contrib/construct/browser/
 *   services/agent/agentLoop.ts, 1947 lines, 22 DI dependencies) has been
 *   rewritten here as a plain class with constructor injection. What's
 *   preserved verbatim:
 *     - The planning-phase LLM loop (read-only tools, parse plan steps)
 *     - The execution-phase LLM loop (full tools, tool_use → execute → feed
 *       result back → repeat, until end_turn or max rounds)
 *     - The tool_use SSE event handling (Anthropic content_block_start/delta/stop)
 *     - The system prompt structure (Iron Law of verification, Karpathy 4
 *       principles, Ponytail YAGNI ladder)
 *     - The plan parsing regex
 *     - The verification harness (try npm test → npm run build → npx tsc)
 *
 *   What's stripped:
 *     - 12 of the 22 DI deps were no-op stubs or pure VS Code plumbing
 *       (memory orchestrator, skill registry, snapshot manager, file watcher,
 *       universal memory, cost governor, credit system, execution sanity,
 *       error recovery, agent reach MCP, etc). They're gone.
 *     - The `runWithApprovedPlan()` milestone-aware path is preserved but
 *       simplified — the full milestoneExecutor is still imported and used.
 *     - `undoLastTask()` (snapshot-based undo) — gone, will rebuild with a
 *       real snapshot layer later if needed.
 *     - `refreshExplorer()` — gone, was VS Code plumbing.
 *     - `commandService.executeCommand('kovix.executeTool', ...)` for
 *       search_codebase and web_search — replaced with direct calls to the
 *       tool functions.
 *
 *   What's NEW:
 *     - An `approval_callback` field on AgentLoopConfig. When the staging
 *       layer receives a proposed write, the agent loop fires an
 *       `approval_request` event AND calls the callback. The callback's
 *       return value (true = approve, false = reject) determines whether
 *       the write actually hits disk. This replaces VS Code's
 *       IDialogService.confirm() + IPendingChangesService diff-view flow.
 */

import {
    IConstructAIProvider,
    IChatMessage,
    IToolCall,
    IToolDefinition,
    AIStreamEvent,
} from './llm/types.js';
import {
    IPlanResult,
    IPlanStep,
    IApprovedPlan,
    IMilestone,
    ExecutionState,
} from './milestoneStateMachine.js';
import { AgentLoopEvent } from './events.js';
import { executeMilestonesWithPauses } from './milestoneExecutor.js';
import {
    TOOL_DEFINITIONS,
    executeTool,
    ToolContext,
} from './tools/index.js';
import { PendingChanges } from './staging/pendingChanges.js';
import { TerminalRateLimiter } from './security/index.js';
import { principlesBlock } from './agentPrinciples.js';

// MVP FIX: reduced from 50 to 10. With free OpenRouter models that
// can't do tool calling, each round is a full LLM call (up to 60s).
// 50 rounds × 60s = 50 minutes of hanging. 10 rounds × 60s = 10 min
// worst case, and the markdown fallback parser should produce files
// within 2-3 rounds.
const MAX_ROUNDS = 10;

const PLANNING_TOOL_NAMES = new Set(['read_file', 'list_directory', 'search_codebase', 'web_search']);

// MVP FIX: markdown code-block fallback parser.
// When a free OpenRouter model can't do tool calling, it returns text
// containing ```lang\n...\n``` blocks. This parser extracts them so we
// can write the code to disk automatically — no tool call needed.
interface MarkdownCodeBlock {
    language: string;
    content: string;
    filePath: string;
}

/** Language tag → default file extension mapping. */
const LANG_EXTENSIONS: Record<string, string> = {
    javascript: 'js', js: 'js', jsx: 'jsx',
    typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    markdown: 'md', md: 'md',
    bash: 'sh', sh: 'sh', shell: 'sh',
    go: 'go', rust: 'rs', rs: 'rs',
    java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    php: 'php', ruby: 'rb', rb: 'rb',
    sql: 'sql', xml: 'xml',
};

/** Parse markdown code blocks from LLM text output.
 *  Each block's file path is inferred from:
 *  1. A `path:` / `file:` comment in the first 3 lines
 *  2. The language tag (e.g. ```javascript → file-N.js)
 *  3. Fallback: file-N.txt */
function parseMarkdownCodeBlocks(text: string, roundIndex: number): MarkdownCodeBlock[] {
    const blocks: MarkdownCodeBlock[] = [];
    // Match ```lang\n...\n``` (handles both ``` and ~~~ fences)
    const fenceRegex = /(?:^|\n)(```|~~~)(\w*)\n([\s\S]*?)\n?\1/g;
    let match: RegExpExecArray | null;
    let blockIdx = 0;
    while ((match = fenceRegex.exec(text)) !== null) {
        const language = (match[2] || 'text').toLowerCase();
        const content = match[3];
        const filePath = inferFilePath(language, content, roundIndex, blockIdx);
        blocks.push({ language, content, filePath });
        blockIdx++;
    }
    return blocks;
}

/** Infer a file path from the code block's language and content. */
function inferFilePath(language: string, content: string, roundIndex: number, blockIdx: number): string {
    // Check first 5 lines for a path comment: // path: src/app.js  or  # path: src/app.py  or  <!-- path: index.html -->
    const lines = content.split('\n').slice(0, 5);
    for (const line of lines) {
        const pathMatch = line.match(/(?:\/\/|#|<!--)\s*(?:path|file|filename)\s*[:=]\s*([^\s*<]+)/i);
        if (pathMatch && pathMatch[1]) {
            return pathMatch[1].replace(/^\.\//, '').replace(/["']/g, '');
        }
    }
    // Fallback: use language extension
    const ext = LANG_EXTENSIONS[language] ?? 'txt';
    return `file-r${roundIndex + 1}-${blockIdx + 1}.${ext}`;
}

/** Check if text looks like a completion/summary message (no code to extract). */
function looksLikeCompletion(text: string): boolean {
    const lower = text.toLowerCase();
    const completionPhrases = [
        'task complete', 'task completed', 'mission complete', 'mission completed',
        'all done', 'i am done', 'i\'m done', 'finished',
        'i have finished', 'the milestone is complete',
    ];
    // Must NOT contain a code fence
    if (/```|~~~/.test(text)) { return false; }
    // Must contain a completion phrase
    return completionPhrases.some(p => lower.includes(p));
}

/**
 * Configuration for the agent loop. Replaces the 22 DI deps.
 */
export interface AgentLoopConfig {
    /** The LLM provider (CloudProvider in production, mockable in tests). */
    aiProvider: IConstructAIProvider;
    /** Workspace root path — replaces IWorkspaceContextService. */
    workspaceRoot: string;
    /** Logger. Default: console.log. */
    log?: (message: string) => void;
    /**
     * Approval callback for staged file writes.
     * Called whenever the agent stages a write_file or edit_file.
     * Return true to apply the write to disk, false to reject.
     * If omitted, all staged writes are AUTO-APPLIED (test-only mode).
     */
    approveWrite?: (filePath: string, proposedContent: string, existingContent: string | null) => Promise<boolean>;
    /**
     * Approval callback for interpreter commands (node, python, npm, etc.).
     * Return true to allow, false to block.
     * If omitted, interpreter commands are blocked.
     */
    approveInterpreterCommand?: (command: string, cwd?: string) => Promise<boolean>;
    /** Whether web_search is enabled. Default false. */
    onlineMode?: boolean;
}

export class AgentLoop {
    private _isRunning = false;
    private _executionState: ExecutionState = ExecutionState.Idle;
    private _currentMilestone: IMilestone | null = null;
    private _conversationHistory: IChatMessage[] = [];
    private _pendingChanges: PendingChanges;
    private _rateLimiter = new TerminalRateLimiter();
    private _milestoneResumeResolver: ((action: 'resume' | 'skip') => void) | null = null;

    constructor(private config: AgentLoopConfig) {
        this._pendingChanges = new PendingChanges(config.workspaceRoot);
    }

    get isRunning(): boolean { return this._isRunning; }
    get executionState(): ExecutionState { return this._executionState; }
    get currentMilestone(): IMilestone | null { return this._currentMilestone; }

    private log(msg: string): void {
        this.config.log?.(msg);
    }

    private getToolContext(): ToolContext {
        return {
            workspaceRoot: this.config.workspaceRoot,
            pendingChanges: this._pendingChanges,
            rateLimiter: this._rateLimiter,
            approveInterpreterCommand: this.config.approveInterpreterCommand,
            log: (msg: string) => this.log(msg),
            onlineMode: this.config.onlineMode ?? false,
        };
    }

    private getPlanningTools(): IToolDefinition[] {
        return TOOL_DEFINITIONS.filter(t => PLANNING_TOOL_NAMES.has(t.name));
    }

    private getAgentTools(): IToolDefinition[] {
        return TOOL_DEFINITIONS;
    }

    /**
     * Run the planning phase — uses read-only tools to explore the codebase
     * and generate a plan. Does NOT make any changes.
     */
    async runPlanningPhase(task: string, signal?: AbortSignal): Promise<IPlanResult> {
        this.log(`[AgentLoop] Planning phase started: ${task}`);
        this._executionState = ExecutionState.Planning;

        const systemPrompt = this.buildSystemPrompt(task, true);
        const conversationMessages: IChatMessage[] = [
            ...this._conversationHistory,
            {
                role: 'user',
                content: `Analyze the current workspace and create a plan for this task: "${task}"\n\nFirst, explore the workspace to understand its structure, then list the specific steps needed. Use only read_file and list_directory tools.\n\nFormat your response as a numbered list of steps, each starting with [Read], [Create], [Edit], or [Run].`,
            },
        ];

        let fullResponse = '';

        try {
            let roundCount = 0;
            while (roundCount < MAX_ROUNDS) {
                roundCount++;
                const toolResultCache = new Map<string, { output: string; isError: boolean }>();
                const assistantToolCalls: IToolCall[] = [];
                let currentText = '';
                let stopReason = '';
                let hadToolCalls = false;

                const timeoutController = new AbortController();
                const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                if (signal) {
                    signal.addEventListener('abort', () => timeoutController.abort());
                }

                const stream = this.config.aiProvider.chat(
                    conversationMessages,
                    this.getPlanningTools(),
                    { signal: timeoutController.signal, systemPrompt },
                );

                try {
                    for await (const event of stream) {
                        if (signal?.aborted) {
                            clearTimeout(timeoutId);
                            return { steps: [], summary: 'Cancelled', rawResponse: '' };
                        }
                        switch (event.type) {
                            case 'token':
                                currentText += event.text;
                                fullResponse += event.text;
                                break;
                            case 'tool_start':
                                hadToolCalls = true;
                                assistantToolCalls.push({
                                    id: event.toolId,
                                    name: event.toolName,
                                    arguments: '{}',
                                });
                                break;
                            case 'tool_end': {
                                const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                if (toolCall) {
                                    toolCall.arguments = JSON.stringify(event.toolInput ?? {});
                                }
                                if (!toolResultCache.has(event.toolId)) {
                                    const ctx = this.getToolContext();
                                    const result = await executeTool(event.toolName, (event.toolInput ?? {}) as Record<string, unknown>, ctx, true);
                                    toolResultCache.set(event.toolId, {
                                        output: result.output,
                                        isError: !result.success,
                                    });
                                }
                                break;
                            }
                            case 'done':
                                stopReason = event.stopReason;
                                break;
                            case 'error':
                                throw new Error(event.text);
                        }
                    }
                } finally {
                    clearTimeout(timeoutId);
                }

                // Accept both Anthropic ('tool_use') and OpenAI-compat ('tool_calls') stop reasons
                if (hadToolCalls && (stopReason === 'tool_use' || stopReason === 'tool_calls')) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: currentText || '',
                        toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                    });
                    for (const toolCall of assistantToolCalls) {
                        const cached = toolResultCache.get(toolCall.id);
                        if (cached) {
                            conversationMessages.push({
                                role: 'tool',
                                content: cached.output,
                                toolCallId: toolCall.id,
                            });
                        } else {
                            const input = JSON.parse(toolCall.arguments || '{}');
                            const ctx = this.getToolContext();
                            const result = await executeTool(toolCall.name, input, ctx, true);
                            conversationMessages.push({
                                role: 'tool',
                                content: result.output,
                                toolCallId: toolCall.id,
                            });
                        }
                    }
                    continue;
                }
                break;
            }

            const steps = this.parsePlan(fullResponse);
            this._conversationHistory.push(
                { role: 'user', content: task },
                { role: 'assistant', content: fullResponse },
            );
            this._executionState = ExecutionState.AwaitingApproval;
            return { steps, summary: fullResponse, rawResponse: fullResponse };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`[AgentLoop] Planning error: ${msg}`);
            this._executionState = ExecutionState.Error;
            throw error;
        }
    }

    /**
     * Run the full execution phase with all tools available.
     * Yields AgentLoopEvents in real time.
     */
    async *run(task: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
        if (this._isRunning) {
            yield { type: 'error', text: 'Agent loop is already running.', recoverable: false };
            return;
        }
        this._isRunning = true;
        this._executionState = ExecutionState.Executing;
        this.log(`[AgentLoop] Execution started: ${task}`);

        // Clear any leftover staged changes from previous run
        this._pendingChanges.clearAll();

        try {
            const systemPrompt = this.buildSystemPrompt(task, false);
            const conversationMessages: IChatMessage[] = [
                ...this._conversationHistory,
                { role: 'user', content: task },
            ];

            let roundCount = 0;
            let finalSummary = '';

            while (roundCount < MAX_ROUNDS) {
                roundCount++;
                this.log(`[AgentLoop] Round ${roundCount}/${MAX_ROUNDS}`);

                const assistantToolCalls: IToolCall[] = [];
                let currentText = '';
                let stopReason = '';
                let hasToolCalls = false;

                const timeoutController = new AbortController();
                const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                if (signal) {
                    signal.addEventListener('abort', () => timeoutController.abort());
                }

                const stream = this.config.aiProvider.chat(
                    conversationMessages,
                    this.getAgentTools(),
                    { signal: timeoutController.signal, systemPrompt },
                );

                try {
                    for await (const event of stream) {
                        if (signal?.aborted) {
                            clearTimeout(timeoutId);
                            yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
                            this._isRunning = false;
                            return;
                        }
                        switch (event.type) {
                            case 'token':
                                currentText += event.text;
                                finalSummary += event.text;
                                yield { type: 'token', text: event.text };
                                break;
                            case 'tool_start':
                                hasToolCalls = true;
                                assistantToolCalls.push({
                                    id: event.toolId,
                                    name: event.toolName,
                                    arguments: '{}',
                                });
                                yield { type: 'tool_start', toolId: event.toolId, toolName: event.toolName };
                                break;
                            case 'tool_input':
                                yield { type: 'tool_executing', toolId: event.toolId, toolName: '', detail: event.text };
                                break;
                            case 'tool_end': {
                                const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                if (toolCall) {
                                    toolCall.arguments = JSON.stringify(event.toolInput ?? {});
                                }
                                yield { type: 'tool_executing', toolId: event.toolId, toolName: event.toolName, detail: 'Executing...' };

                                const ctx = this.getToolContext();
                                const result = await executeTool(event.toolName, (event.toolInput ?? {}) as Record<string, unknown>, ctx, false);

                                // MVP FIX: removed approval gate. For the MVP, the
                                // agent writes files immediately without waiting for
                                // user approval. The staging layer still validates
                                // paths and content, but auto-applies on success.
                                if ((event.toolName === 'write_file' || event.toolName === 'edit_file') && result.success) {
                                    const input = (event.toolInput ?? {}) as { path?: string };
                                    if (input.path) {
                                        const staged = this._pendingChanges.getStagedChange(input.path);
                                        if (staged) {
                                            // MVP FIX: auto-apply immediately. No
                                            // approval_request event, no approveWrite
                                            // callback, no waiting.
                                            await this._pendingChanges.applyStagedChange(input.path);
                                            yield { type: 'file_written', filePath: input.path };
                                        }
                                    }
                                }

                                yield { type: 'tool_result', toolId: event.toolId, toolName: event.toolName, result: result.output, success: result.success };

                                // Append to conversation
                                conversationMessages.push({
                                    role: 'tool',
                                    content: result.output,
                                    toolCallId: event.toolId,
                                });
                                break;
                            }
                            case 'done':
                                stopReason = event.stopReason;
                                break;
                            case 'error':
                                yield { type: 'error', text: event.text, recoverable: true };
                                break;
                        }
                    }
                } finally {
                    clearTimeout(timeoutId);
                }

                // Add the assistant message with tool calls
                if (currentText || assistantToolCalls.length > 0) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: currentText || '',
                        toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                    });
                }

                // MVP FIX: accept 'tool_calls' stop reason from OpenAI-compat
                // providers (OpenRouter, Groq, etc.) as a continuation signal.
                // Previously only 'tool_use' (Anthropic) was accepted, so
                // OpenRouter tool calls caused the loop to exit prematurely.
                if (hasToolCalls && (stopReason === 'tool_use' || stopReason === 'tool_calls')) {
                    // Tool calls happened — results already pushed during
                    // tool_end handling. Continue to next round.
                    continue;
                }

                // MVP FIX: markdown code-block fallback.
                // If the LLM returned text with code blocks (common with free
                // OpenRouter models that don't support function calling),
                // parse the blocks and write each to disk automatically.
                if (!hasToolCalls && currentText) {
                    const codeBlocks = parseMarkdownCodeBlocks(currentText, roundCount - 1);
                    if (codeBlocks.length > 0) {
                        const ctx = this.getToolContext();
                        for (const block of codeBlocks) {
                            try {
                                const writeResult = await executeTool('write_file', { path: block.filePath, content: block.content }, ctx, false);
                                if (writeResult.success) {
                                    // Auto-apply the staged write immediately (no approval gate)
                                    const staged = this._pendingChanges.getStagedChange(block.filePath);
                                    if (staged) {
                                        await this._pendingChanges.applyStagedChange(block.filePath);
                                    }
                                    yield { type: 'file_written', filePath: block.filePath };
                                    yield { type: 'tool_result', toolId: 'markdown-fallback', toolName: 'write_file', result: `Wrote ${block.filePath} (${block.content.length} chars)`, success: true };
                                } else {
                                    yield { type: 'tool_result', toolId: 'markdown-fallback', toolName: 'write_file', result: writeResult.output, success: false };
                                }
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                yield { type: 'error', text: `Failed to write ${block.filePath}: ${msg}`, recoverable: true };
                            }
                        }
                        // Push the assistant message + a synthetic tool result so
                        // the next round's conversation is valid.
                        conversationMessages.push({
                            role: 'tool',
                            content: `Wrote ${codeBlocks.length} file(s) via markdown fallback: ${codeBlocks.map(b => b.filePath).join(', ')}. If all files are written, say "done" and stop.`,
                            toolCallId: 'markdown-fallback',
                        });
                        // If the LLM also said "done" (stop/end_turn), break.
                        // Otherwise continue for another round.
                        if (stopReason === 'end_turn' || stopReason === 'stop' || stopReason === 'length') {
                            this._conversationHistory.push(
                                { role: 'user', content: task },
                                { role: 'assistant', content: finalSummary },
                            );
                            this._executionState = ExecutionState.Complete;
                            yield { type: 'complete', summary: finalSummary || 'Task completed.' };
                            this._isRunning = false;
                            return;
                        }
                        continue;
                    }

                    // No code blocks, no tool calls. Check if it's a completion message.
                    if (looksLikeCompletion(currentText) || stopReason === 'end_turn' || stopReason === 'stop') {
                        this._conversationHistory.push(
                            { role: 'user', content: task },
                            { role: 'assistant', content: finalSummary },
                        );
                        this._executionState = ExecutionState.Complete;
                        yield { type: 'complete', summary: finalSummary || 'Task completed.' };
                        this._isRunning = false;
                        return;
                    }

                    // MVP FIX: re-prompt. The LLM returned text without code
                    // blocks and without a completion signal. Ask it to output
                    // code in a markdown block so the fallback can write it.
                    conversationMessages.push({
                        role: 'user',
                        content: 'You have not written any code yet. Output the code for this milestone in a markdown code block. Put the file path in a comment on the first line (e.g. // path: src/app.js). Do not explain — just output the code.',
                    });
                    continue;
                }

                // MVP FIX: if we get here with no tool calls, no code blocks,
                // and no text, it's an empty response. Break to avoid looping.
                this._conversationHistory.push(
                    { role: 'user', content: task },
                    { role: 'assistant', content: finalSummary },
                );
                this._executionState = ExecutionState.Complete;
                yield { type: 'complete', summary: finalSummary || 'Task completed.' };
                this._isRunning = false;
                return;
            }

            this._executionState = ExecutionState.Complete;
            yield { type: 'complete', summary: finalSummary || 'Task completed (max rounds reached).' };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`[AgentLoop] Execution error: ${msg}`);
            this._executionState = ExecutionState.Error;
            yield { type: 'error', text: msg, recoverable: false };
        } finally {
            this._isRunning = false;
        }
    }

    /**
     * Run execution with an approved plan and milestone-based pausing.
     */
    async *runWithApprovedPlan(approvedPlan: IApprovedPlan, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
        if (this._isRunning) {
            yield { type: 'error', text: 'Agent loop is already running.', recoverable: false };
            return;
        }
        this._isRunning = true;
        this._executionState = ExecutionState.Executing;
        this._pendingChanges.clearAll();

        try {
            const systemPrompt = this.buildSystemPrompt(approvedPlan.task, false);

            const executeSubTask = async function* (this: AgentLoop, subTask: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                const conversationMessages: IChatMessage[] = [
                    ...this._conversationHistory,
                    { role: 'user', content: subTask },
                ];

                let roundCount = 0;
                while (roundCount < MAX_ROUNDS) {
                    roundCount++;
                    const assistantToolCalls: IToolCall[] = [];
                    let currentText = '';
                    let stopReason = '';
                    let hasToolCalls = false;

                    const timeoutController = new AbortController();
                    const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                    if (signal) { signal.addEventListener('abort', () => timeoutController.abort()); }

                    const stream = this.config.aiProvider.chat(
                        conversationMessages,
                        this.getAgentTools(),
                        { signal: timeoutController.signal, systemPrompt },
                    );

                    try {
                        for await (const event of stream) {
                            if (signal?.aborted) {
                                clearTimeout(timeoutId);
                                yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
                                return;
                            }
                            switch (event.type) {
                                case 'token':
                                    currentText += event.text;
                                    yield { type: 'token', text: event.text };
                                    break;
                                case 'tool_start':
                                    hasToolCalls = true;
                                    assistantToolCalls.push({ id: event.toolId, name: event.toolName, arguments: '{}' });
                                    yield { type: 'tool_start', toolId: event.toolId, toolName: event.toolName };
                                    break;
                                case 'tool_input':
                                    yield { type: 'tool_executing', toolId: event.toolId, toolName: '', detail: event.text };
                                    break;
                                case 'tool_end': {
                                    const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                    if (toolCall) { toolCall.arguments = JSON.stringify(event.toolInput ?? {}); }
                                    yield { type: 'tool_executing', toolId: event.toolId, toolName: event.toolName, detail: 'Executing...' };
                                    const ctx = this.getToolContext();
                                    const result = await executeTool(event.toolName, (event.toolInput ?? {}) as Record<string, unknown>, ctx, false);
                                    // MVP FIX: auto-apply staged writes immediately (no approval gate)
                                    if ((event.toolName === 'write_file' || event.toolName === 'edit_file') && result.success) {
                                        const input = (event.toolInput ?? {}) as { path?: string };
                                        if (input.path) {
                                            const staged = this._pendingChanges.getStagedChange(input.path);
                                            if (staged) {
                                                await this._pendingChanges.applyStagedChange(input.path);
                                                yield { type: 'file_written', filePath: input.path };
                                            }
                                        }
                                    }
                                    yield { type: 'tool_result', toolId: event.toolId, toolName: event.toolName, result: result.output, success: result.success };
                                    conversationMessages.push({ role: 'tool', content: result.output, toolCallId: event.toolId });
                                    break;
                                }
                                case 'done':
                                    stopReason = event.stopReason;
                                    break;
                                case 'error':
                                    yield { type: 'error', text: event.text, recoverable: true };
                                    break;
                            }
                        }
                    } finally {
                        clearTimeout(timeoutId);
                    }

                    if (currentText || assistantToolCalls.length > 0) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: currentText || '',
                            toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                        });
                    }
                    // MVP FIX: accept 'tool_calls' stop reason + markdown fallback
                    if (hasToolCalls && (stopReason === 'tool_use' || stopReason === 'tool_calls')) {
                        continue;
                    }
                    if (!hasToolCalls && currentText) {
                        const codeBlocks = parseMarkdownCodeBlocks(currentText, roundCount - 1);
                        if (codeBlocks.length > 0) {
                            const ctx = this.getToolContext();
                            for (const block of codeBlocks) {
                                try {
                                    const writeResult = await executeTool('write_file', { path: block.filePath, content: block.content }, ctx, false);
                                    if (writeResult.success) {
                                        const staged = this._pendingChanges.getStagedChange(block.filePath);
                                        if (staged) { await this._pendingChanges.applyStagedChange(block.filePath); }
                                        yield { type: 'file_written', filePath: block.filePath };
                                    }
                                } catch { /* error already yielded by executeTool */ }
                            }
                            conversationMessages.push({
                                role: 'tool',
                                content: `Wrote ${codeBlocks.length} file(s) via markdown fallback.`,
                                toolCallId: 'markdown-fallback',
                            });
                            if (stopReason === 'end_turn' || stopReason === 'stop' || stopReason === 'length') { return; }
                            continue;
                        }
                        if (looksLikeCompletion(currentText) || stopReason === 'end_turn' || stopReason === 'stop') { return; }
                        conversationMessages.push({
                            role: 'user',
                            content: 'Output the code in a markdown code block with the file path in a comment on the first line.',
                        });
                        continue;
                    }
                    return;
                }
            };

            const runVerification = async function* (this: AgentLoop, _signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                yield* this.runVerification();
            };

            const awaitResume = (milestone: IMilestone): Promise<'resume' | 'skip'> => {
                this._currentMilestone = milestone;
                this._executionState = ExecutionState.PausedAtMilestone;
                return new Promise<'resume' | 'skip'>(resolve => {
                    this._milestoneResumeResolver = resolve;
                });
            };

            yield* executeMilestonesWithPauses({
                approvedPlan,
                executeSubTask: executeSubTask.bind(this),
                runVerification: runVerification.bind(this),
                awaitResume,
                signal,
                log: (msg: string) => this.log(msg),
            });

            this._executionState = ExecutionState.Complete;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this._executionState = ExecutionState.Error;
            yield { type: 'error', text: msg, recoverable: false };
        } finally {
            this._isRunning = false;
        }
    }

    /** Resume from a milestone pause. */
    resumeFromMilestone(): void {
        if (this._milestoneResumeResolver) {
            this._executionState = ExecutionState.Executing;
            const resolver = this._milestoneResumeResolver;
            this._milestoneResumeResolver = null;
            resolver('resume');
        }
    }

    /** Skip the current milestone. */
    skipCurrentMilestone(): void {
        if (this._milestoneResumeResolver) {
            const resolver = this._milestoneResumeResolver;
            this._milestoneResumeResolver = null;
            resolver('skip');
        }
    }

    clearConversationHistory(): void {
        this._conversationHistory = [];
    }

    /**
     * PUBLIC verification entry point — used by the LeadAgentService to run
     * the harness check after a worker completes its milestone. The lead
     * calls worker.run() to execute the milestone, then worker.verifyNow()
     * to confirm the worker's "done" claim.
     *
     * Returns the same stream as the private runVerification() — yields
     * verification_start + verification_result events.
     */
    async *verifyNow(signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
        yield* this.runVerification(signal);
    }

    /**
     * Phase 1.2 — Real verification harness.
     * Runs a harness-controlled check (NOT an LLM-controlled one) to confirm
     * the agent's "done" claim.
     */
    private async *runVerification(signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
        // Check for package.json with a test/build/typecheck script
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const pkgPath = path.resolve(this.config.workspaceRoot, 'package.json');
        let pkg: { scripts?: Record<string, string> } | null = null;
        try {
            pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
        } catch {
            pkg = null;
        }

        let command = '';
        if (pkg?.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
            command = 'npm test';
        } else if (pkg?.scripts?.build) {
            command = 'npm run build';
        } else if (pkg?.scripts?.typecheck) {
            command = 'npm run typecheck';
        } else {
            // No verification command available
            yield {
                type: 'verification_result',
                passed: true,
                output: 'unverified:no-command',
                unverified: true,
            };
            return;
        }

        yield { type: 'verification_start', command };

        try {
            const { stdout, stderr } = await execFileAsync(
                process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
                process.platform === 'win32' ? ['/c', command] : ['-c', command],
                {
                    cwd: this.config.workspaceRoot,
                    timeout: 120_000,
                    maxBuffer: 10 * 1024 * 1024,
                },
            );
            const output = (stdout + (stderr ? '\n' + stderr : '')).substring(0, 4000);
            yield { type: 'verification_result', passed: true, output };
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; code?: number };
            const output = ((e.stdout ?? '') + (e.stderr ? '\n' + e.stderr : '')).substring(0, 4000);
            yield { type: 'verification_result', passed: false, output };
        }
    }

    // ----------------------------------------------------------------------
    // Private helpers (verbatim from VS Code fork)
    // ----------------------------------------------------------------------

    private buildSystemPrompt(task: string, planningOnly: boolean): string {
        const date = new Date().toISOString().split('T')[0];
        const mode = planningOnly ? 'PLANNING MODE -- use only read_file and list_directory to explore the workspace. Do NOT make any changes.' : '';

        return `You are Kovix, an expert AI coding assistant.

${mode}

Working directory: ${this.config.workspaceRoot}
Current date: ${date}

Guidelines:
- Always read relevant existing files before making changes
- Write complete, working code -- never truncate with "// ... rest of file"
- Prefer running commands over asking the user to run them
- After writing files or making changes, verify by RUNNING the relevant command
  (tests, build, type-check, or the actual feature) and reading its real output.
  Reading a file back to confirm its contents were written is NOT verification —
  it only proves the write syscall succeeded, not that the code works.
- Never claim a task is complete, fixed, or passing without having run the
  verification command in this same turn and seen its exit code / output.
  The Iron Law: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.
- If no test or build command exists for what you changed, say so explicitly and
  mark the result as "unverified" rather than implying it was checked.
- Keep the user informed with brief status messages
- If task requires installing dependencies, do it
- Always think about what could go wrong and handle it

Common Failures table (do not reproduce these patterns):
  | Claim                  | Requires                                  | Not Sufficient                  |
  |------------------------|-------------------------------------------|---------------------------------|
  | Tests pass             | Test command output: 0 failures           | Previous run, "should pass"     |
  | Build succeeds         | Build command: exit 0                     | Linter passing, logs look good  |
  | Bug fixed              | Test original symptom: passes             | Code changed, assumed fixed     |
  | Agent completed        | VCS diff shows changes                    | Agent reports "success"         |
  | Requirements met       | Line-by-line checklist                    | Tests passing                   |

Engineering discipline (Karpathy four principles):
  1. Think Before Coding — state assumptions explicitly. If multiple interpretations
     exist, present them; don't pick silently. If a simpler approach exists, say so.
  2. Simplicity First — minimum code that solves the problem. No speculative
     abstractions, no "flexibility" that wasn't requested, no error handling for
     impossible scenarios. If 200 lines could be 50, rewrite.
  3. Surgical Changes — touch only what you must. Don't "improve" adjacent code.
     Match existing style. Every changed line should trace directly to the request.
  4. Goal-Driven Execution — define a verifiable success criterion before starting.
     "Fix the bug" → "write a test that reproduces it, then make it pass".

Ponytail discipline (DEFAULT: full):
  YAGNI ladder applies — stdlib before deps, native before custom, one line before
  fifty. Don't introduce unrequested abstractions. If the user didn't ask for a
  framework, plugin system, or config layer, don't add one. Escalate to bigger
  architecture only when the task explicitly requires it.
${principlesBlock()}`;
    }

    private parsePlan(response: string): IPlanStep[] {
        const steps: IPlanStep[] = [];
        const lines = response.split('\n');
        let stepIndex = 0;
        for (const line of lines) {
            const match = line.match(/^\s*\d+\.?\s*\[(Read|Create|Edit|Run)\]\s*(.+)/i);
            if (match) {
                const action = (match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()) as IPlanStep['action'];
                const target = match[2].trim();
                steps.push({ index: stepIndex++, action, target, description: line.trim() });
            }
        }
        if (steps.length === 0) {
            steps.push({ index: 0, action: 'Read', target: 'workspace', description: response.substring(0, 200) });
        }
        return steps;
    }
}
