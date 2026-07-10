/**
 * Phase 3 verification -- Approval Gate smoke test.
 *
 * The existing AgentLoop uses an `approveWrite` callback (in AgentLoopConfig)
 * to gate file writes -- the agent stages the change, the loop fires an
 * `approval_request` event AND awaits the callback before applying the write.
 *
 * This script verifies both sides of the gate:
 *   1. REJECT path -- callback returns false -> staged change is cleared,
 *      file is NOT written, an error string is fed back to the LLM.
 *   2. APPROVE path -- callback returns true -> staged change is applied,
 *      `file_written` event fires, file IS on disk.
 *
 * Uses the existing MockProvider pattern (scripted AIStreamEvent batches)
 * so no real LLM call is made.
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

class MockProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';
    private queue: AIStreamEvent[][] = [];
    callCount = 0;

    script(batches: AIStreamEvent[][]): void { this.queue = [...batches]; this.callCount = 0; }

    async *chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent> {
        this.callCount++;
        void messages; void tools; void options;
        const batch = this.queue.shift();
        if (!batch) throw new Error('MockProvider queue exhausted');
        for (const ev of batch) yield ev;
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

async function runCase(opts: { approve: boolean; workspace: string; mock: MockProvider }): Promise<AgentLoopEvent[]> {
    const loop = new AgentLoop({
        aiProvider: opts.mock,
        workspaceRoot: opts.workspace,
        log: () => undefined,
        approveWrite: async () => opts.approve,
    });
    const events: AgentLoopEvent[] = [];
    for await (const ev of loop.run('write approval-test.txt')) {
        events.push(ev);
    }
    return events;
}

async function main(): Promise<void> {
    console.log('=========================================');
    console.log(' Phase 3 Verification -- Approval Gate');
    console.log('=========================================');

    const rejectWorkspace = path.resolve(process.cwd(), 'verify-workspace-phase3-reject');
    const approveWorkspace = path.resolve(process.cwd(), 'verify-workspace-phase3-approve');
    await fs.mkdir(rejectWorkspace, { recursive: true });
    await fs.mkdir(approveWorkspace, { recursive: true });
    try {
        await fs.rm(path.join(rejectWorkspace, 'approval-test.txt'), { force: true });
        await fs.rm(path.join(approveWorkspace, 'approval-test.txt'), { force: true });
    } catch { /* ignore */ }

    try {
        // --- Case 1: REJECT ---
        console.log('\n--- Case 1: Reject path ---');
        const rejectMock = new MockProvider();
        rejectMock.script([
            [
                { type: 'tool_start', toolId: 't1', toolName: 'write_file' },
                { type: 'tool_end', toolId: 't1', toolName: 'write_file', toolInput: { path: 'approval-test.txt', content: 'rejected' } },
                { type: 'token', text: 'I will write the file.' },
                { type: 'done', stopReason: 'tool_use' },
            ],
            [
                { type: 'token', text: 'Acknowledged rejection.' },
                { type: 'done', stopReason: 'stop' },
            ],
        ]);
        const rejectEvents = await runCase({ approve: false, workspace: rejectWorkspace, mock: rejectMock });
        assert(rejectEvents.some(e => e.type === 'approval_request'), 'reject: approval_request event fired');
        assert(!rejectEvents.some(e => e.type === 'file_written'), 'reject: NO file_written event fired');
        // File must not exist
        let exists = false;
        try { await fs.access(path.join(rejectWorkspace, 'approval-test.txt')); exists = true; } catch { /* not exists */ }
        assert(!exists, 'reject: file NOT on disk');

        // --- Case 2: APPROVE ---
        console.log('\n--- Case 2: Approve path ---');
        const approveMock = new MockProvider();
        approveMock.script([
            [
                { type: 'tool_start', toolId: 't2', toolName: 'write_file' },
                { type: 'tool_end', toolId: 't2', toolName: 'write_file', toolInput: { path: 'approval-test.txt', content: 'approved' } },
                { type: 'token', text: 'I will write the file.' },
                { type: 'done', stopReason: 'tool_use' },
            ],
            [
                { type: 'token', text: 'Done.' },
                { type: 'done', stopReason: 'stop' },
            ],
        ]);
        const approveEvents = await runCase({ approve: true, workspace: approveWorkspace, mock: approveMock });
        assert(approveEvents.some(e => e.type === 'approval_request'), 'approve: approval_request event fired');
        assert(approveEvents.some(e => e.type === 'file_written' && e.filePath === 'approval-test.txt'), 'approve: file_written event fired for approval-test.txt');
        const content = await fs.readFile(path.join(approveWorkspace, 'approval-test.txt'), 'utf8');
        assert(content === 'approved', 'approve: file content === "approved"');
    } finally {
        try { await fs.rm(rejectWorkspace, { recursive: true, force: true }); } catch { /* ignore */ }
        try { await fs.rm(approveWorkspace, { recursive: true, force: true }); } catch { /* ignore */ }
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

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
