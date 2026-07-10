/**
 * Phase 4 verification script.
 *
 * Two suites:
 *   SUITE A -- Tool Schema Bridge
 *     MockStreamingProvider simulates the streaming IConstructAIProvider
 *     interface. Wrap it with wrapProvider(). Call adapter.chat() with the
 *     write_file tool schema. Assert:
 *       - tools were forwarded to the underlying provider (spy)
 *       - the returned LLMResponse has the correct text from token events
 *       - the returned LLMResponse has tool_calls with correct name+args
 *       - stop_reason is mapped correctly
 *
 *   SUITE B -- Verification Gate
 *     MockLLMProvider implements the non-streaming LLMProvider interface
 *     directly, with a scripted 4-call sequence:
 *       1. Planning:    [{"title":"Write File","description":"Write test.txt"}]
 *       2. Tool call:   write_file(path='verify-test.txt', content='verified')
 *       3. Stop:        "Done."
 *       4. Verification: "YES"
 *     Run MilestoneTaskRunner.runMilestoneTask(). Assert:
 *       - verification_result event fired with passed=true
 *       - milestone status is VERIFIED
 *       - file exists on disk
 *     Then a second test: verification returns "NO, the file was not created"
 *     -> milestone is marked FAILED.
 *
 * Prints "RESULT: PASS" only if every assertion across both suites passes.
 * Cleans up the test workspace under verify-workspace-phase4/ in finally.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import type {
    IConstructAIProvider,
    IChatMessage,
    IToolDefinition,
    AIStreamEvent,
    IChatOptions,
    IModelInfo,
} from '../src/agent/llm/types.js';
import { AIProviderType, ProviderStatus } from '../src/agent/llm/types.js';
import {
    type LLMProvider,
    type LLMMessage,
    type LLMResponse,
    type LLMToolSchema,
    wrapProvider,
    toToolSchema,
} from '../src/agent/llmProviderAdapter.js';
import {
    MilestoneTaskRunner,
    MilestoneStatus,
    type Milestone,
    type VerificationResultPayload,
    TOOL_DEFINITIONS,
} from '../src/agent/milestoneTaskRunner.js';

// ----------------------------------------------------------------------
// Test utilities
// ----------------------------------------------------------------------

let failures: string[] = [];
let passes: number = 0;

function assert(cond: boolean, label: string): void {
    if (cond) {
        passes++;
        console.log(`  ✓ ${label}`);
    } else {
        failures.push(label);
        console.error(`  ✗ ${label}`);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    const equal = JSON.stringify(actual) === JSON.stringify(expected);
    if (equal) {
        passes++;
        console.log(`  ✓ ${label}`);
    } else {
        failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
        console.error(`  ✗ ${label}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

// ----------------------------------------------------------------------
// SUITE A: Tool Schema Bridge
// ----------------------------------------------------------------------

/**
 * MockStreamingProvider implements IConstructAIProvider and records every
 * call to chat() so the test can assert what the adapter forwarded.
 *
 * `scriptedEvents` is the stream of AIStreamEvents the mock will emit on the
 * next chat() call. After emitting, the script is cleared (so a second call
 * without re-arming would emit nothing).
 */
class MockStreamingProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';

    /** Most recent arguments the adapter passed to chat(). */
    lastCall: {
        messages: IChatMessage[];
        tools: IToolDefinition[];
        options?: IChatOptions;
    } | null = null;

    /** Total number of chat() invocations. */
    callCount = 0;

    private scriptedEvents: AIStreamEvent[] = [];

    /** Arm the next chat() call with a stream of events. */
    script(events: AIStreamEvent[]): void {
        this.scriptedEvents = events;
    }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        this.callCount++;
        this.lastCall = { messages: [...messages], tools: [...tools], options };
        for (const ev of this.scriptedEvents) {
            yield ev;
        }
        this.scriptedEvents = [];
    }

    // The rest of IConstructAIProvider is irrelevant to the adapter test.
    // Return safe defaults so the mock satisfies the interface.
    async listModels(): Promise<IModelInfo[]> {
        return [
            {
                id: 'mock-model',
                displayName: 'Mock Model',
                provider: 'cloud',
                contextWindowTokens: 8192,
                supportsTools: true,
                supportsStreaming: true,
            },
        ];
    }
    getActiveModel(): IModelInfo | undefined {
        return {
            id: 'mock-model',
            displayName: 'Mock Model',
            provider: 'cloud',
            contextWindowTokens: 8192,
            supportsTools: true,
            supportsStreaming: true,
        };
    }
    async setActiveModel(_modelId: string): Promise<boolean> { return true; }
    isOffline(): boolean { return false; }
    async checkStatus(): Promise<ProviderStatus> { return ProviderStatus.Available; }
    dispose(): void { /* noop */ }
}

async function suiteA(): Promise<void> {
    console.log('\n--- SUITE A: Tool Schema Bridge ---');

    // 1. Build the mock with a scripted stream that exercises every event
    //    type the adapter must translate.
    const mock = new MockStreamingProvider();
    mock.script([
        { type: 'token', text: 'I will ' },
        { type: 'token', text: 'write the file.' },
        { type: 'tool_start', toolId: 'call_001', toolName: 'write_file' },
        { type: 'tool_input', toolId: 'call_001', text: '{"path":' },
        { type: 'tool_input', toolId: 'call_001', text: '"hello.txt","content":"hi"}' },
        { type: 'tool_end', toolId: 'call_001', toolName: 'write_file', toolInput: { path: 'hello.txt', content: 'hi' } },
        { type: 'done', stopReason: 'tool_use' },
    ]);

    // 2. Wrap with the adapter.
    const adapter: LLMProvider = wrapProvider(mock, { log: () => undefined });

    // 3. Build messages + the write_file tool schema (translated from the
    //    agent's native TOOL_DEFINITIONS so we exercise toToolSchema too).
    const writeFileDef = TOOL_DEFINITIONS.find(t => t.name === 'write_file');
    if (!writeFileDef) {
        assert(false, 'write_file tool definition exists in TOOL_DEFINITIONS');
        return;
    }
    const tools: LLMToolSchema[] = [toToolSchema(writeFileDef)];
    const messages: LLMMessage[] = [
        { role: 'user', content: 'Please write hello.txt with the text "hi".' },
    ];

    // 4. Call the adapter.
    const response: LLMResponse = await adapter.chat(messages, tools);

    // 5. Assert tools were forwarded to the mock provider.
    assert(mock.callCount === 1, 'adapter called underlying provider exactly once');
    assert(mock.lastCall !== null, 'adapter forwarded call args to provider');
    if (mock.lastCall) {
        assertEqual(mock.lastCall.tools.length, 1, 'adapter forwarded exactly 1 tool to provider');
        assertEqual(mock.lastCall.tools[0]!.name, 'write_file', 'adapter forwarded tool with correct name');
        assertEqual(mock.lastCall.tools[0]!.description, writeFileDef.description, 'adapter forwarded tool description verbatim');
        assertEqual(mock.lastCall.tools[0]!.inputSchema, writeFileDef.inputSchema, 'adapter forwarded tool inputSchema verbatim');
        assertEqual(mock.lastCall.messages.length, 1, 'adapter forwarded exactly 1 message');
        assertEqual(mock.lastCall.messages[0]!.role, 'user', 'adapter forwarded message role');
        assertEqual(mock.lastCall.messages[0]!.content, messages[0]!.content, 'adapter forwarded message content verbatim');
    }

    // 6. Assert the returned LLMResponse is correctly assembled.
    assertEqual(response.role, 'assistant', 'LLMResponse.role is assistant');
    assertEqual(response.content, 'I will write the file.', 'LLMResponse.content collected from token events');
    assertEqual(response.stop_reason, 'tool_use', 'LLMResponse.stop_reason mapped from done event');

    assert(response.tool_calls !== undefined, 'LLMResponse.tool_calls is defined');
    assert(Array.isArray(response.tool_calls) && response.tool_calls.length === 1, 'LLMResponse.tool_calls has exactly 1 entry');
    if (response.tool_calls && response.tool_calls.length === 1) {
        const tc = response.tool_calls[0]!;
        assertEqual(tc.id, 'call_001', 'tool_call.id mapped from tool_start');
        assertEqual(tc.type, 'function', 'tool_call.type is function (OpenAI format)');
        assertEqual(tc.function.name, 'write_file', 'tool_call.function.name mapped from tool_start');
        // tool_end's toolInput overrides the streamed tool_input fragments.
        const parsedArgs = JSON.parse(tc.function.arguments);
        assertEqual(parsedArgs.path, 'hello.txt', 'tool_call.function.arguments has correct path');
        assertEqual(parsedArgs.content, 'hi', 'tool_call.function.arguments has correct content');
    }

    // 7. Adapter also accepts a call WITHOUT tools (planning/verification path).
    mock.script([{ type: 'token', text: 'no tools here' }, { type: 'done', stopReason: 'stop' }]);
    const noToolsResponse = await adapter.chat([{ role: 'user', content: 'hi' }]);
    assertEqual(noToolsResponse.content, 'no tools here', 'adapter works without tools arg');
    assertEqual(noToolsResponse.stop_reason, 'stop', 'adapter maps stop reason when no tools');
    assert(noToolsResponse.tool_calls === undefined, 'adapter omits tool_calls when none emitted');
    if (mock.lastCall) {
        assertEqual(mock.lastCall.tools.length, 0, 'adapter passes empty tools array when tools omitted');
    }
}

// ----------------------------------------------------------------------
// SUITE B: Verification Gate
// ----------------------------------------------------------------------

/**
 * MockLLMProvider implements the non-streaming LLMProvider interface
 * directly. The test arms a queue of canned LLMResponse objects; each
 * chat() call shifts the next one off. Calls beyond the queue length throw.
 */
class MockLLMProvider implements LLMProvider {
    private queue: LLMResponse[] = [];
    callCount = 0;
    receivedToolsPerCall: (LLMToolSchema[] | undefined)[] = [];

    script(responses: LLMResponse[]): void {
        this.queue = [...responses];
        this.callCount = 0;
        this.receivedToolsPerCall = [];
    }

    async chat(messages: LLMMessage[], tools?: LLMToolSchema[]): Promise<LLMResponse> {
        this.callCount++;
        this.receivedToolsPerCall.push(tools);
        const next = this.queue.shift();
        if (!next) {
            throw new Error(`MockLLMProvider: queue exhausted on call ${this.callCount}`);
        }
        return next;
    }
}

async function suiteB_pass(): Promise<void> {
    console.log('\n--- SUITE B (pass case): Verification Gate ---');

    const mock = new MockLLMProvider();
    mock.script([
        // Call 1: Planning LLM reply -- a JSON array of milestones.
        {
            role: 'assistant',
            content: '[{"title":"Write File","description":"Write test.txt with the word verified"}]',
            stop_reason: 'stop',
        },
        // Call 2: Milestone 1 tool call -- the model emits a write_file call.
        {
            role: 'assistant',
            content: 'Writing the file now.',
            tool_calls: [
                {
                    id: 'call_abc',
                    type: 'function',
                    function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'verify-test.txt', content: 'verified' }),
                    },
                },
            ],
            stop_reason: 'tool_use',
        },
        // Call 3: After the tool result is fed back, the model stops.
        {
            role: 'assistant',
            content: 'Done. The file has been written.',
            stop_reason: 'stop',
        },
        // Call 4: Verification gate returns YES.
        {
            role: 'assistant',
            content: 'YES',
            stop_reason: 'stop',
        },
    ]);

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase4', 'pass');
    await fs.mkdir(workspace, { recursive: true });
    // Clean any leftover file from a prior run.
    try { await fs.rm(path.join(workspace, 'verify-test.txt'), { force: true }); } catch { /* ignore */ }

    const runner = new MilestoneTaskRunner({
        llm: mock,
        workspaceRoot: workspace,
        log: () => undefined,
    });

    const events: { type: string; payload: unknown }[] = [];
    const capture = (type: string) => (payload: unknown) => events.push({ type, payload });
    runner.on('plan_ready', capture('plan_ready'));
    runner.on('milestone_started', capture('milestone_started'));
    runner.on('tool_call', capture('tool_call'));
    runner.on('tool_result', capture('tool_result'));
    runner.on('verification_result', capture('verification_result'));
    runner.on('milestone_verified', capture('milestone_verified'));
    runner.on('milestone_failed', capture('milestone_failed'));
    runner.on('complete', capture('complete'));
    runner.on('error', capture('error'));

    const milestones = await runner.runMilestoneTask('Write verify-test.txt with the word "verified".');

    // Assert: planning call had NO tools (per spec).
    assertEqual(mock.receivedToolsPerCall[0], undefined, 'planning call had no tools arg');

    // Assert: 4 LLM calls total (plan + tool + stop + verification).
    assertEqual(mock.callCount, 4, 'exactly 4 LLM calls (plan + tool + stop + verify)');

    // Assert: verification_result event fired with passed=true.
    const vr = events.find(e => e.type === 'verification_result');
    assert(vr !== undefined, 'verification_result event fired');
    if (vr) {
        const p = vr.payload as VerificationResultPayload;
        assertEqual(p.passed, true, 'verification_result.passed === true');
        assertEqual(p.reason, 'YES', 'verification_result.reason captured the YES');
    }

    // Assert: milestone_verified fired, milestone_failed did NOT.
    assert(events.some(e => e.type === 'milestone_verified'), 'milestone_verified event fired');
    assert(!events.some(e => e.type === 'milestone_failed'), 'milestone_failed event did NOT fire');

    // Assert: final milestone status is VERIFIED.
    assertEqual(milestones.length, 1, 'exactly 1 milestone in plan');
    if (milestones.length === 1) {
        assertEqual(milestones[0]!.status, MilestoneStatus.Verified, 'milestone status === VERIFIED');
    }

    // Assert: file exists on disk with correct content.
    const filePath = path.join(workspace, 'verify-test.txt');
    let fileContent: string | null = null;
    try {
        fileContent = await fs.readFile(filePath, 'utf8');
    } catch {
        fileContent = null;
    }
    assert(fileContent !== null, 'verify-test.txt exists on disk after run');
    assertEqual(fileContent, 'verified', 'verify-test.txt content === "verified"');
}

async function suiteB_fail(): Promise<void> {
    console.log('\n--- SUITE B (fail case): Verification Gate rejects milestone ---');

    const mock = new MockLLMProvider();
    mock.script([
        // Call 1: Planning.
        {
            role: 'assistant',
            content: '[{"title":"Write File","description":"Write fail-test.txt with the word ok"}]',
            stop_reason: 'stop',
        },
        // Call 2: Tool call.
        {
            role: 'assistant',
            content: 'Writing now.',
            tool_calls: [
                {
                    id: 'call_xyz',
                    type: 'function',
                    function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'fail-test.txt', content: 'ok' }),
                    },
                },
            ],
            stop_reason: 'tool_use',
        },
        // Call 3: Stop.
        {
            role: 'assistant',
            content: 'Done.',
            stop_reason: 'stop',
        },
        // Call 4: Verification returns NO with a reason.
        {
            role: 'assistant',
            content: 'NO, the file was not created',
            stop_reason: 'stop',
        },
    ]);

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase4', 'fail');
    await fs.mkdir(workspace, { recursive: true });
    try { await fs.rm(path.join(workspace, 'fail-test.txt'), { force: true }); } catch { /* ignore */ }

    const runner = new MilestoneTaskRunner({
        llm: mock,
        workspaceRoot: workspace,
        log: () => undefined,
    });

    const events: { type: string; payload: unknown }[] = [];
    const capture = (type: string) => (payload: unknown) => events.push({ type, payload });
    runner.on('verification_result', capture('verification_result'));
    runner.on('milestone_verified', capture('milestone_verified'));
    runner.on('milestone_failed', capture('milestone_failed'));
    runner.on('complete', capture('complete'));

    const milestones = await runner.runMilestoneTask('Write fail-test.txt with the word "ok".');

    // Assert: verification_result fired with passed=false.
    const vr = events.find(e => e.type === 'verification_result');
    assert(vr !== undefined, 'verification_result event fired (fail case)');
    if (vr) {
        const p = vr.payload as VerificationResultPayload;
        assertEqual(p.passed, false, 'verification_result.passed === false');
        assert(p.reason.includes('NO'), 'verification_result.reason contains "NO"');
    }

    // Assert: milestone_failed fired, milestone_verified did NOT.
    assert(events.some(e => e.type === 'milestone_failed'), 'milestone_failed event fired');
    assert(!events.some(e => e.type === 'milestone_verified'), 'milestone_verified did NOT fire');

    // Assert: milestone status is FAILED.
    assertEqual(milestones.length, 1, 'exactly 1 milestone (fail case)');
    if (milestones.length === 1) {
        assertEqual(milestones[0]!.status, MilestoneStatus.Failed, 'milestone status === FAILED');
    }

    // Note: the file IS still on disk (the tool did execute successfully);
    // the failure is the LLM verifier saying "not created", which is a
    // deliberately wrong judgement. The point of this test is to prove the
    // runner respects the verifier's verdict even when the underlying tool
    // succeeded. So we don't assert on disk state here.
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('=========================================');
    console.log(' Phase 4 Verification -- Tool Bridge +');
    console.log(' Verification Gate');
    console.log('=========================================');

    try {
        await suiteA();
        await suiteB_pass();
        await suiteB_fail();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\nUNEXPECTED EXCEPTION: ${msg}`);
        failures.push(`uncaught exception: ${msg}`);
    } finally {
        // Clean up test workspaces.
        const root = path.resolve(process.cwd(), 'verify-workspace-phase4');
        try { await fs.rm(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log('\n-----------------------------------------');
    console.log(` Passes:   ${passes}`);
    console.log(` Failures: ${failures.length}`);
    console.log('-----------------------------------------');
    if (failures.length === 0) {
        console.log('\nRESULT: PASS\n');
        process.exit(0);
    } else {
        console.log('\nFailed assertions:');
        for (const f of failures) {
            console.log(`  - ${f}`);
        }
        console.log('\nRESULT: FAIL\n');
        process.exit(1);
    }
}

// EventEmitter import is unused at runtime here but kept for parity with
// Phase 3 pattern (and so future tests that need to assert on EventEmitter
// behavior don't have to re-add the import).
void EventEmitter;

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
