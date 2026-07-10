/**
 * Phase 2 verification -- Milestone State Machine smoke test.
 *
 * Exercises the MilestoneTaskRunner's planning + execution loop with a mock
 * LLMProvider that scripts a 5-call sequence covering two milestones:
 *   Call 1 (plan):    [{title:"Setup",description:"read dir"}, {title:"Write",description:"write file"}]
 *   Call 2 (m1 tool): list_directory tool_call
 *   Call 3 (m1 stop): "Done m1"
 *   Call 4 (m2 tool): write_file tool_call
 *   Call 5 (m2 stop): "Done m2"
 *
 * Verification gate is bypassed by having the verifier reply YES at the right
 * moments (we use a 7-call mock: plan + (m1 tool + m1 stop + m1 verify) + (m2 tool + m2 stop + m2 verify)).
 *
 * Asserts:
 *   - 2 milestones planned
 *   - Both milestones reach VERIFIED status
 *   - Planning call had no tools
 *   - File written by m2 exists on disk
 *
 * Prints "RESULT: PASS" if every assertion holds.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
    MilestoneTaskRunner,
    MilestoneStatus,
    type Milestone,
    type LLMProvider,
    type LLMMessage,
    type LLMResponse,
    type LLMToolSchema,
    type VerificationResultPayload,
} from '../src/agent/milestoneTaskRunner.js';

let passes = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string): void {
    if (cond) { passes++; console.log(`  ✓ ${label}`); }
    else { failures.push(label); console.error(`  ✗ ${label}`); }
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
        void messages;
        const next = this.queue.shift();
        if (!next) throw new Error(`MockLLMProvider queue exhausted on call ${this.callCount}`);
        return next;
    }
}

async function main(): Promise<void> {
    console.log('=========================================');
    console.log(' Phase 2 Verification -- Milestone State');
    console.log(' Machine');
    console.log('=========================================');

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase2');
    await fs.mkdir(workspace, { recursive: true });
    try { await fs.rm(path.join(workspace, 'milestone-output.txt'), { force: true }); } catch { /* ignore */ }

    try {
        const mock = new MockLLMProvider();
        mock.script([
            // Call 1: planning -- 2 milestones
            { role: 'assistant', content: '[{"title":"Setup","description":"List the workspace"},{"title":"Write","description":"Write milestone-output.txt with ok"}]', stop_reason: 'stop' },
            // Call 2: m1 tool call -- list_directory
            { role: 'assistant', content: 'Listing.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) } }], stop_reason: 'tool_use' },
            // Call 3: m1 stop
            { role: 'assistant', content: 'Done m1', stop_reason: 'stop' },
            // Call 4: m1 verify -> YES
            { role: 'assistant', content: 'YES', stop_reason: 'stop' },
            // Call 5: m2 tool call -- write_file
            { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'milestone-output.txt', content: 'ok' }) } }], stop_reason: 'tool_use' },
            // Call 6: m2 stop
            { role: 'assistant', content: 'Done m2', stop_reason: 'stop' },
            // Call 7: m2 verify -> YES
            { role: 'assistant', content: 'YES', stop_reason: 'stop' },
        ]);

        const runner = new MilestoneTaskRunner({
            llm: mock,
            workspaceRoot: workspace,
            log: () => undefined,
        });

        const events: { type: string; payload: unknown }[] = [];
        const capture = (type: string) => (payload: unknown) => events.push({ type, payload });
        runner.on('plan_ready', capture('plan_ready'));
        runner.on('milestone_started', capture('milestone_started'));
        runner.on('milestone_verified', capture('milestone_verified'));
        runner.on('milestone_failed', capture('milestone_failed'));
        runner.on('verification_result', capture('verification_result'));
        runner.on('complete', capture('complete'));

        const milestones: Milestone[] = await runner.runMilestoneTask('Setup workspace and write milestone-output.txt');

        // Planning call had no tools
        assertEqual(mock.receivedToolsPerCall[0], undefined, 'planning call had no tools');

        // 2 milestones planned
        assertEqual(milestones.length, 2, 'exactly 2 milestones planned');

        // Both VERIFIED
        if (milestones.length === 2) {
            assertEqual(milestones[0]!.status, MilestoneStatus.Verified, 'milestone 0 status === VERIFIED');
            assertEqual(milestones[1]!.status, MilestoneStatus.Verified, 'milestone 1 status === VERIFIED');
        }

        // 2 verification_result events, both passed=true
        const vrs = events.filter(e => e.type === 'verification_result').map(e => e.payload as VerificationResultPayload);
        assertEqual(vrs.length, 2, 'exactly 2 verification_result events');
        if (vrs.length === 2) {
            assertEqual(vrs[0]!.passed, true, 'm1 verification passed');
            assertEqual(vrs[1]!.passed, true, 'm2 verification passed');
        }

        // 2 milestone_verified events, 0 milestone_failed
        assertEqual(events.filter(e => e.type === 'milestone_verified').length, 2, '2 milestone_verified events');
        assertEqual(events.filter(e => e.type === 'milestone_failed').length, 0, '0 milestone_failed events');

        // File on disk
        const content = await fs.readFile(path.join(workspace, 'milestone-output.txt'), 'utf8');
        assertEqual(content, 'ok', 'milestone-output.txt content === "ok"');

        // Total LLM calls = 7
        assertEqual(mock.callCount, 7, 'exactly 7 LLM calls (plan + 3*m1 + 3*m2)');
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

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
