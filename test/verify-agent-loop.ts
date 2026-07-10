/**
 * Phase 1 verification -- Tool Registry & Autonomous Agent Loop smoke test.
 *
 * This script exercises the existing AgentLoop against a mock IConstructAIProvider
 * to prove the agent core's tool-registry + planning/execution loop works
 * end-to-end without a real LLM.
 *
 * The mock provider scripts a 3-call sequence:
 *   1. list_directory -> explore workspace
 *   2. write_file     -> stage a hello.txt
 *   3. stop           -> "Done"
 *
 * Asserts:
 *   - The agent's planning phase completes (steps array returned)
 *   - The execution loop yields a 'complete' event
 *   - The 'file_written' event fires after auto-approval
 *   - hello.txt is on disk with the right content
 *   - Exactly 2 LLM calls happened (planning + execution)
 *
 * Prints "RESULT: PASS" if every assertion holds.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
    IConstructAIProvider,
    IChatMessage,
    IToolDefinition,
    AIStreamEvent,
    IChatOptions,
    IModelInfo,
} from '../src/agent/llm/types.js';
import { AIProviderType, ProviderStatus } from '../src/agent/llm/types.js';
import { AgentLoop, type AgentLoopEvent } from '../src/agent/index.js';

let passes = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string): void {
    if (cond) { passes++; console.log(`  ✓ ${label}`); }
    else { failures.push(label); console.error(`  ✗ ${label}`); }
}

/**
 * MockStreamingProvider -- arms a queue of (events[]) batches; each chat()
 * call shifts the next batch and yields it. Records every call for inspection.
 */
class MockProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';
    private queue: AIStreamEvent[][] = [];
    callCount = 0;
    lastReceivedTools: IToolDefinition[] = [];

    script(batches: AIStreamEvent[][]): void { this.queue = [...batches]; this.callCount = 0; }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        this.callCount++;
        this.lastReceivedTools = [...tools];
        void messages; void options;
        const batch = this.queue.shift();
        if (!batch) { throw new Error('MockProvider queue exhausted'); }
        for (const ev of batch) { yield ev; }
    }

    async listModels(): Promise<IModelInfo[]> {
        return [{ id: 'mock', displayName: 'mock', provider: 'cloud', contextWindowTokens: 8192, supportsTools: true, supportsStreaming: true }];
    }
    getActiveModel(): IModelInfo | undefined {
        return { id: 'mock', displayName: 'mock', provider: 'cloud', contextWindowTokens: 8192, supportsTools: true, supportsStreaming: true };
    }
    async setActiveModel(): Promise<boolean> { return true; }
    isOffline(): boolean { return false; }
    async checkStatus(): Promise<ProviderStatus> { return ProviderStatus.Available; }
    dispose(): void { /* noop */ }
}

async function main(): Promise<void> {
    console.log('=========================================');
    console.log(' Phase 1 Verification -- Tool Registry &');
    console.log(' Autonomous Agent Loop');
    console.log('=========================================');

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase1');
    await fs.mkdir(workspace, { recursive: true });
    try { await fs.rm(path.join(workspace, 'hello.txt'), { force: true }); } catch { /* ignore */ }

    try {
        const mock = new MockProvider();
        // Batch 1: planning -- list_directory then stop with a plan
        mock.script([
            [
                { type: 'tool_start', toolId: 't1', toolName: 'list_directory' },
                { type: 'tool_end', toolId: 't1', toolName: 'list_directory', toolInput: { path: '.' } },
                { type: 'token', text: 'Plan:\n1. [Create] hello.txt with content "test"\n2. [Run] verify' },
                { type: 'done', stopReason: 'stop' },
            ],
            // Batch 2: execution -- write_file then stop
            [
                { type: 'tool_start', toolId: 't2', toolName: 'write_file' },
                { type: 'tool_end', toolId: 't2', toolName: 'write_file', toolInput: { path: 'hello.txt', content: 'test' } },
                { type: 'token', text: 'Done. File written.' },
                { type: 'done', stopReason: 'stop' },
            ],
        ]);

        const loop = new AgentLoop({
            aiProvider: mock,
            workspaceRoot: workspace,
            log: () => undefined,
            // No approveWrite callback -> auto-apply (test-only mode)
        });

        // Phase A: planning
        const plan = await loop.runPlanningPhase('create a file called hello.txt with the text test in it');
        assert(plan.steps.length > 0, 'planning phase produced non-empty steps array');
        assert(mock.callCount === 1, `exactly 1 LLM call after planning (got ${mock.callCount})`);
        assert(mock.lastReceivedTools.length > 0, 'planning phase was given read-only tools');
        const planningToolsAreReadOnly = mock.lastReceivedTools.every(t =>
            t.name === 'read_file' || t.name === 'list_directory' || t.name === 'search_codebase' || t.name === 'web_search'
        );
        assert(planningToolsAreReadOnly, 'planning tools are read-only (read_file / list_directory / search_codebase / web_search)');

        // Phase B: execution -- drain the generator
        const events: AgentLoopEvent[] = [];
        for await (const ev of loop.run('create a file called hello.txt with the text test in it')) {
            events.push(ev);
        }
        assert(mock.callCount === 2, `exactly 2 LLM calls after execution (got ${mock.callCount})`);
        assert(events.some(e => e.type === 'tool_start' && e.toolName === 'write_file'), 'write_file tool_start event emitted');
        assert(events.some(e => e.type === 'file_written' && e.filePath === 'hello.txt'), 'file_written event emitted for hello.txt');
        assert(events.some(e => e.type === 'complete'), 'complete event emitted');

        // Assert file on disk
        const content = await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8');
        assertEqual(content, 'test', 'hello.txt content === "test"');

        // Assert write_file tool was given in execution
        // (lastReceivedTools captured from the execution call)
        assert(mock.lastReceivedTools.some(t => t.name === 'write_file'), 'execution phase had write_file tool available');
    } finally {
        try { await fs.rm(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log('\n-----------------------------------------');
    console.log(` Passes:   ${passes}`);
    console.log(` Failures: ${failures.length}`);
    console.log('-----------------------------------------');
    if (failures.length === 0) { console.log('\nRESULT: PASS\n'); process.exit(0); }
    else {
        console.log('\nFailed:'); for (const f of failures) console.log(`  - ${f}`);
        console.log('\nRESULT: FAIL\n'); process.exit(1);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passes++; console.log(`  ✓ ${label}`); }
    else {
        failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
        console.error(`  ✗ ${label}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
