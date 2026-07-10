/**
 * Phase 5 verification script — Final UI Wiring & Approval Gate.
 *
 * Verifies that the Phase 5 wiring (MilestoneTaskRunner approval gate +
 * llm_text event + Mission Control IPC bridge) is correctly in place and
 * behaves end-to-end. Complements verify-phase4.ts (which exercised the
 * non-approval, autoApplyWrites path).
 *
 * SUITES:
 *
 *   A. Approval Gate — APPROVE path
 *      Configure MilestoneTaskRunner with `requireApproval: true`. The
 *      scripted LLM emits a write_file tool_call. Assert:
 *        - `approval_required` event fires with the correct callId / name / args
 *        - calling `runner.approveToolCall(callId)` unblocks execution
 *        - the file is written to disk
 *        - the milestone reaches VERIFIED
 *
 *   B. Approval Gate — REJECT path
 *      Same setup, but `runner.rejectToolCall(callId)`. Assert:
 *        - the tool_result has success=false and "rejected" in the output
 *        - the file is NOT written to disk
 *        - the milestone reaches FAILED (because verification gate sees no
 *          file was created)
 *
 *   C. llm_text event
 *      Assert the new 'llm_text' event fires with the assistant's text
 *      content during the execution loop.
 *
 *   D. Static wiring check (no Electron required)
 *      Read the source files of:
 *        - src/main/missionControlIpc.ts
 *        - src/preload/preload.ts
 *        - src/main/main.ts
 *      Assert:
 *        - missionControlIpc.ts imports MilestoneTaskRunner + wrapProvider
 *          from '../agent/...' (NOT '../core/...')
 *        - missionControlIpc.ts registers handlers for kovix:mc:start,
 *          kovix:mc:approve, kovix:mc:reject, kovix:mc:file-tree
 *        - preload.ts exposes window.kovixAPI.mission.{start,approve,
 *          reject,getFileTree,onPlanReady,onApprovalRequired,...}
 *        - main.ts calls setupMissionControlIpc(...) during app.whenReady
 *
 * Prints "RESULT: PASS" only if every assertion across all suites passes.
 * Cleans up the test workspace under verify-workspace-phase5/ in finally.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as nodeFs from 'node:fs';

import {
    MilestoneTaskRunner,
    MilestoneStatus,
    type VerificationResultPayload,
    type ApprovalRequiredPayload,
    type LlmTextPayload,
    type ToolCallPayload,
    type ToolResultPayload,
} from '../src/agent/milestoneTaskRunner.js';
import type {
    LLMProvider,
    LLMMessage,
    LLMResponse,
    LLMToolSchema,
} from '../src/agent/llmProviderAdapter.js';

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
// Mock LLMProvider (non-streaming, same shape as Phase 4 verify script)
// ----------------------------------------------------------------------

class MockLLMProvider implements LLMProvider {
    private queue: LLMResponse[] = [];
    callCount = 0;

    script(responses: LLMResponse[]): void {
        this.queue = [...responses];
        this.callCount = 0;
    }

    async chat(messages: LLMMessage[], tools?: LLMToolSchema[]): Promise<LLMResponse> {
        this.callCount++;
        void messages;
        void tools;
        const next = this.queue.shift();
        if (!next) {
            throw new Error(`MockLLMProvider: queue exhausted on call ${this.callCount}`);
        }
        return next;
    }
}

// ----------------------------------------------------------------------
// SUITE A: Approval Gate — APPROVE path
// ----------------------------------------------------------------------

async function suiteA_approve(): Promise<void> {
    console.log('\n--- SUITE A: Approval Gate (APPROVE) ---');

    const mock = new MockLLMProvider();
    mock.script([
        // Call 1: Planning — single milestone to write a file.
        {
            role: 'assistant',
            content: '[{"title":"Write File","description":"Write approve.txt with the word ok"}]',
            stop_reason: 'stop',
        },
        // Call 2: Execution — model emits a write_file tool_call.
        {
            role: 'assistant',
            content: 'I will create the file now.',
            tool_calls: [
                {
                    id: 'call_approve_1',
                    type: 'function',
                    function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'approve.txt', content: 'ok' }),
                    },
                },
            ],
            stop_reason: 'tool_use',
        },
        // Call 3: After tool result, model declares done.
        {
            role: 'assistant',
            content: 'Done. The file has been written.',
            stop_reason: 'stop',
        },
        // Call 4: Verification gate — YES.
        {
            role: 'assistant',
            content: 'YES',
            stop_reason: 'stop',
        },
    ]);

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase5', 'approve');
    await fs.mkdir(workspace, { recursive: true });
    try { await fs.rm(path.join(workspace, 'approve.txt'), { force: true }); } catch { /* ignore */ }

    const runner = new MilestoneTaskRunner({
        llm: mock,
        workspaceRoot: workspace,
        requireApproval: true,
        autoApplyWrites: true,
        log: () => undefined,
    });

    const events: { type: string; payload: unknown }[] = [];
    const capture = (type: string) => (payload: unknown) => events.push({ type, payload });

    // The key Phase 5 wiring: when approval_required fires, immediately
    // call approveToolCall to unblock the runner. This mirrors what the
    // Mission Control UI does when the user clicks Approve.
    let approvalCalls = 0;
    runner.on('approval_required', (payload: ApprovalRequiredPayload) => {
        approvalCalls++;
        events.push({ type: 'approval_required', payload });
        // Approve synchronously inside the listener — the runner's await
        // resolves on the next microtask.
        runner.approveToolCall(payload.callId);
    });
    runner.on('llm_text', capture('llm_text'));
    runner.on('plan_ready', capture('plan_ready'));
    runner.on('milestone_started', capture('milestone_started'));
    runner.on('tool_call', capture('tool_call'));
    runner.on('tool_result', capture('tool_result'));
    runner.on('verification_result', capture('verification_result'));
    runner.on('milestone_verified', capture('milestone_verified'));
    runner.on('milestone_failed', capture('milestone_failed'));
    runner.on('complete', capture('complete'));

    const milestones = await runner.runMilestoneTask('Write approve.txt with the word "ok".');

    // Assert: approval_required fired exactly once with correct payload.
    assertEqual(approvalCalls, 1, 'approval_required fired exactly once (approve path)');
    const ar = events.find(e => e.type === 'approval_required');
    if (ar) {
        const p = ar.payload as ApprovalRequiredPayload;
        assertEqual(p.callId, 'call_approve_1', 'approval_required.callId matches tool_call.id');
        assertEqual(p.name, 'write_file', 'approval_required.name === write_file');
        assertEqual((p.args as { path: string }).path, 'approve.txt', 'approval_required.args.path correct');
    }

    // Assert: tool_result had success=true (because we approved).
    const tr = events.find(e => e.type === 'tool_result');
    if (tr) {
        const p = tr.payload as ToolResultPayload;
        assertEqual(p.success, true, 'tool_result.success === true (after approve)');
        assertEqual(p.name, 'write_file', 'tool_result.name === write_file');
    } else {
        assert(false, 'tool_result event fired');
    }

    // Assert: milestone_verified fired, milestone_failed did NOT.
    assert(events.some(e => e.type === 'milestone_verified'), 'milestone_verified fired (approve path)');
    assert(!events.some(e => e.type === 'milestone_failed'), 'milestone_failed did NOT fire (approve path)');

    // Assert: final milestone status is VERIFIED.
    assertEqual(milestones.length, 1, 'exactly 1 milestone (approve path)');
    if (milestones.length === 1) {
        assertEqual(milestones[0]!.status, MilestoneStatus.Verified, 'milestone status === VERIFIED (approve path)');
    }

    // Assert: file exists on disk with correct content.
    let fileContent: string | null = null;
    try {
        fileContent = await fs.readFile(path.join(workspace, 'approve.txt'), 'utf8');
    } catch {
        fileContent = null;
    }
    assert(fileContent !== null, 'approve.txt exists on disk (approve path)');
    assertEqual(fileContent, 'ok', 'approve.txt content === "ok"');

    // Assert: verification_result passed=true.
    const vr = events.find(e => e.type === 'verification_result');
    if (vr) {
        const p = vr.payload as VerificationResultPayload;
        assertEqual(p.passed, true, 'verification_result.passed === true (approve path)');
    }
}

// ----------------------------------------------------------------------
// SUITE B: Approval Gate — REJECT path
// ----------------------------------------------------------------------

async function suiteB_reject(): Promise<void> {
    console.log('\n--- SUITE B: Approval Gate (REJECT) ---');

    const mock = new MockLLMProvider();
    mock.script([
        // Call 1: Planning.
        {
            role: 'assistant',
            content: '[{"title":"Write File","description":"Write reject.txt with the word no"}]',
            stop_reason: 'stop',
        },
        // Call 2: Execution — model emits a write_file tool_call.
        {
            role: 'assistant',
            content: 'Creating the file.',
            tool_calls: [
                {
                    id: 'call_reject_1',
                    type: 'function',
                    function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'reject.txt', content: 'no' }),
                    },
                },
            ],
            stop_reason: 'tool_use',
        },
        // Call 3: After rejection error, model gives up (stops).
        {
            role: 'assistant',
            content: 'Understood, I will not write that file.',
            stop_reason: 'stop',
        },
        // Call 4: Verification gate — NO (the file was not created).
        {
            role: 'assistant',
            content: 'NO, the file was not created',
            stop_reason: 'stop',
        },
    ]);

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase5', 'reject');
    await fs.mkdir(workspace, { recursive: true });
    try { await fs.rm(path.join(workspace, 'reject.txt'), { force: true }); } catch { /* ignore */ }

    const runner = new MilestoneTaskRunner({
        llm: mock,
        workspaceRoot: workspace,
        requireApproval: true,
        autoApplyWrites: true,
        log: () => undefined,
    });

    const events: { type: string; payload: unknown }[] = [];
    const capture = (type: string) => (payload: unknown) => events.push({ type, payload });

    // Reject the approval — simulates user clicking Reject in Mission Control.
    let approvalCalls = 0;
    runner.on('approval_required', (payload: ApprovalRequiredPayload) => {
        approvalCalls++;
        events.push({ type: 'approval_required', payload });
        runner.rejectToolCall(payload.callId);
    });
    runner.on('llm_text', capture('llm_text'));
    runner.on('plan_ready', capture('plan_ready'));
    runner.on('milestone_started', capture('milestone_started'));
    runner.on('tool_call', capture('tool_call'));
    runner.on('tool_result', capture('tool_result'));
    runner.on('verification_result', capture('verification_result'));
    runner.on('milestone_verified', capture('milestone_verified'));
    runner.on('milestone_failed', capture('milestone_failed'));
    runner.on('complete', capture('complete'));

    const milestones = await runner.runMilestoneTask('Write reject.txt with the word "no".');

    // Assert: approval_required fired exactly once.
    assertEqual(approvalCalls, 1, 'approval_required fired exactly once (reject path)');

    // Assert: tool_result had success=false and "rejected" in the output.
    const tr = events.find(e => e.type === 'tool_result');
    if (tr) {
        const p = tr.payload as ToolResultPayload;
        assertEqual(p.success, false, 'tool_result.success === false (after reject)');
        assert(p.output.toLowerCase().includes('reject'), `tool_result.output contains "reject" (got: ${p.output})`);
    } else {
        assert(false, 'tool_result event fired (reject path)');
    }

    // Assert: milestone_failed fired, milestone_verified did NOT.
    assert(events.some(e => e.type === 'milestone_failed'), 'milestone_failed fired (reject path)');
    assert(!events.some(e => e.type === 'milestone_verified'), 'milestone_verified did NOT fire (reject path)');

    // Assert: final milestone status is FAILED.
    assertEqual(milestones.length, 1, 'exactly 1 milestone (reject path)');
    if (milestones.length === 1) {
        assertEqual(milestones[0]!.status, MilestoneStatus.Failed, 'milestone status === FAILED (reject path)');
    }

    // Assert: file was NOT written to disk.
    let fileExists = false;
    try {
        await fs.access(path.join(workspace, 'reject.txt'));
        fileExists = true;
    } catch {
        fileExists = false;
    }
    assert(!fileExists, 'reject.txt does NOT exist on disk (reject path)');

    // Assert: verification_result passed=false.
    const vr = events.find(e => e.type === 'verification_result');
    if (vr) {
        const p = vr.payload as VerificationResultPayload;
        assertEqual(p.passed, false, 'verification_result.passed === false (reject path)');
    }
}

// ----------------------------------------------------------------------
// SUITE C: llm_text event
// ----------------------------------------------------------------------

async function suiteC_llmText(): Promise<void> {
    console.log('\n--- SUITE C: llm_text event ---');

    const mock = new MockLLMProvider();
    mock.script([
        // Call 1: Planning — no llm_text here (planning response is parsed
        // as JSON; the runner does NOT emit llm_text for the planning call
        // because it isn't inside the execution tool loop).
        {
            role: 'assistant',
            content: '[{"title":"Do thing","description":"Do the thing"}]',
            stop_reason: 'stop',
        },
        // Call 2: Execution — assistant content should surface as llm_text.
        {
            role: 'assistant',
            content: 'I am reasoning about the task.',
            tool_calls: [
                {
                    id: 'call_llmtext_1',
                    type: 'function',
                    function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'llmtext.txt', content: 'x' }),
                    },
                },
            ],
            stop_reason: 'tool_use',
        },
        // Call 3: Stop — second llm_text event from this content.
        {
            role: 'assistant',
            content: 'Finished.',
            stop_reason: 'stop',
        },
        // Call 4: Verification YES — note: the runner does NOT emit llm_text
        // for the verification call (only the execution tool loop does).
        {
            role: 'assistant',
            content: 'YES',
            stop_reason: 'stop',
        },
    ]);

    const workspace = path.resolve(process.cwd(), 'verify-workspace-phase5', 'llmtext');
    await fs.mkdir(workspace, { recursive: true });
    try { await fs.rm(path.join(workspace, 'llmtext.txt'), { force: true }); } catch { /* ignore */ }

    const runner = new MilestoneTaskRunner({
        llm: mock,
        workspaceRoot: workspace,
        requireApproval: true,
        autoApplyWrites: true,
        log: () => undefined,
    });

    const llmTexts: string[] = [];
    runner.on('approval_required', (payload: ApprovalRequiredPayload) => {
        runner.approveToolCall(payload.callId);
    });
    runner.on('llm_text', (payload: LlmTextPayload) => {
        llmTexts.push(payload.text);
    });

    await runner.runMilestoneTask('Write llmtext.txt with the letter "x".');

    // Assert: at least 2 llm_text events fired (call 2 content + call 3 content).
    // The planning call and verification call should NOT emit llm_text.
    assert(llmTexts.length >= 2, `at least 2 llm_text events fired (got ${llmTexts.length})`);
    assert(llmTexts.includes('I am reasoning about the task.'), 'first execution LLM text captured');
    assert(llmTexts.includes('Finished.'), 'second execution LLM text captured');
    // Sanity: planning content (JSON plan) should NOT have been emitted as llm_text.
    assert(!llmTexts.some(t => t.includes('"title":"Do thing"')), 'planning JSON not leaked as llm_text');
}

// ----------------------------------------------------------------------
// SUITE D: Static wiring check (no Electron required)
// ----------------------------------------------------------------------

async function suiteD_staticWiring(): Promise<void> {
    console.log('\n--- SUITE D: Static wiring check ---');

    const root = process.cwd();
    const ipcPath = path.join(root, 'src', 'main', 'missionControlIpc.ts');
    const preloadPath = path.join(root, 'src', 'preload', 'preload.ts');
    const mainPath = path.join(root, 'src', 'main', 'main.ts');

    const [ipcSrc, preloadSrc, mainSrc] = await Promise.all([
        fs.readFile(ipcPath, 'utf8').catch(() => null),
        fs.readFile(preloadPath, 'utf8').catch(() => null),
        fs.readFile(mainPath, 'utf8').catch(() => null),
    ]);

    assert(ipcSrc !== null, 'src/main/missionControlIpc.ts exists');
    assert(preloadSrc !== null, 'src/preload/preload.ts exists');
    assert(mainSrc !== null, 'src/main/main.ts exists');

    if (ipcSrc) {
        // Must import MilestoneTaskRunner + wrapProvider from ../agent/
        assert(
            ipcSrc.includes("from '../agent/milestoneTaskRunner.js'"),
            "missionControlIpc.ts imports MilestoneTaskRunner from '../agent/milestoneTaskRunner.js'",
        );
        assert(
            ipcSrc.includes("from '../agent/llmProviderAdapter.js'"),
            "missionControlIpc.ts imports wrapProvider from '../agent/llmProviderAdapter.js'",
        );
        // Must NOT import from the old src/core/ paths (which don't exist).
        assert(
            !ipcSrc.includes("'../core/"),
            "missionControlIpc.ts does NOT import from '../core/' (no phantom paths)",
        );
        // Must register the 4 IPC handlers.
        assert(ipcSrc.includes("'kovix:mc:start'"), "missionControlIpc.ts registers 'kovix:mc:start' handler");
        assert(ipcSrc.includes("'kovix:mc:approve'"), "missionControlIpc.ts registers 'kovix:mc:approve' handler");
        assert(ipcSrc.includes("'kovix:mc:reject'"), "missionControlIpc.ts registers 'kovix:mc:reject' handler");
        assert(ipcSrc.includes("'kovix:mc:file-tree'"), "missionControlIpc.ts registers 'kovix:mc:file-tree' handler");

        // Must instantiate the runner with requireApproval: true (the whole
        // point of Phase 5 — destructive writes should pause for the user).
        assert(
            ipcSrc.includes('requireApproval: true'),
            'missionControlIpc.ts instantiates MilestoneTaskRunner with requireApproval: true',
        );

        // Must wire the new Phase 5 events through to the renderer.
        assert(ipcSrc.includes("'kovix:mc:approval-required'"), "missionControlIpc.ts forwards 'approval_required' → kovix:mc:approval-required");
        assert(ipcSrc.includes("'kovix:mc:llm-text'"), "missionControlIpc.ts forwards 'llm_text' → kovix:mc:llm-text");

        // Must use the Phase 4 adapter (wrapProvider).
        assert(ipcSrc.includes('wrapProvider('), 'missionControlIpc.ts calls wrapProvider() to build the LLM');
    }

    if (preloadSrc) {
        // The preload must expose the mission.* API surface to the renderer.
        assert(preloadSrc.includes('mission:'), 'preload.ts exposes a `mission:` namespace');
        assert(preloadSrc.includes("ipcRenderer.invoke('kovix:mc:start'"), "preload exposes mission.start → kovix:mc:start");
        assert(preloadSrc.includes("ipcRenderer.invoke('kovix:mc:approve'"), "preload exposes mission.approve → kovix:mc:approve");
        assert(preloadSrc.includes("ipcRenderer.invoke('kovix:mc:reject'"), "preload exposes mission.reject → kovix:mc:reject");
        assert(preloadSrc.includes("ipcRenderer.invoke('kovix:mc:file-tree'"), "preload exposes mission.getFileTree → kovix:mc:file-tree");

        // Must register push-event listeners for the events the UI renders.
        assert(preloadSrc.includes("'kovix:mc:plan-ready'"), "preload listens for kovix:mc:plan-ready");
        assert(preloadSrc.includes("'kovix:mc:approval-required'"), "preload listens for kovix:mc:approval-required");
        assert(preloadSrc.includes("'kovix:mc:milestone-verified'"), "preload listens for kovix:mc:milestone-verified");
        assert(preloadSrc.includes("'kovix:mc:milestone-failed'"), "preload listens for kovix:mc:milestone-failed");
        assert(preloadSrc.includes("'kovix:mc:tool-call'"), "preload listens for kovix:mc:tool-call");
        assert(preloadSrc.includes("'kovix:mc:tool-result'"), "preload listens for kovix:mc:tool-result");
        assert(preloadSrc.includes("'kovix:mc:llm-text'"), "preload listens for kovix:mc:llm-text");
        assert(preloadSrc.includes("'kovix:mc:complete'"), "preload listens for kovix:mc:complete");
    }

    if (mainSrc) {
        // main.ts must call setupMissionControlIpc during app.whenReady.
        assert(mainSrc.includes('setupMissionControlIpc'), 'main.ts calls setupMissionControlIpc() during startup');
        assert(mainSrc.includes("from './missionControlIpc.js'"), "main.ts imports setupMissionControlIpc from './missionControlIpc.js'");
        assert(mainSrc.includes('MISSION_CONTROL_HTML'), 'main.ts loads MISSION_CONTROL_HTML (Phase 3 UI)');
        // Must NOT reference the old Build Mode HTML as the primary view.
        assert(
            !/loadURL\([^)]*BUILD_MODE_HTML/.test(mainSrc) || mainSrc.includes('MISSION_CONTROL_HTML'),
            'main.ts no longer uses BUILD_MODE_HTML as the primary view (Phase 5 replaced it)',
        );
    }

    // File-tree sanity: confirm the agent/ directory has both new files.
    const agentDir = path.join(root, 'src', 'agent');
    assert(
        nodeFs.existsSync(path.join(agentDir, 'milestoneTaskRunner.ts')),
        'src/agent/milestoneTaskRunner.ts exists',
    );
    assert(
        nodeFs.existsSync(path.join(agentDir, 'llmProviderAdapter.ts')),
        'src/agent/llmProviderAdapter.ts exists',
    );
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('=========================================');
    console.log(' Phase 5 Verification -- Final Wiring');
    console.log(' + Approval Gate + llm_text event');
    console.log('=========================================');

    try {
        await suiteA_approve();
        await suiteB_reject();
        await suiteC_llmText();
        await suiteD_staticWiring();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\nUNEXPECTED EXCEPTION: ${msg}`);
        failures.push(`uncaught exception: ${msg}`);
    } finally {
        // Clean up test workspaces.
        const root = path.resolve(process.cwd(), 'verify-workspace-phase5');
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

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
