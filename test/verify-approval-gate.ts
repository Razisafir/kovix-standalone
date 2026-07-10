/**
 * verify-approval-gate.ts — Kovix 2.0 Phase 3 finish line.
 *
 * Run with:
 *   npx tsx test/verify-approval-gate.ts
 *
 * Tests the Approval Gate end-to-end via the EventEmitter interface:
 *   1. Mock LLM returns a 1-milestone plan.
 *   2. Mock LLM returns a write_file tool_call (destructive → needs approval).
 *   3. Mock LLM returns stop.
 *
 * The script listens for 'approval_required', asserts the payload, then calls
 * approveToolCall(callId) to unblock the loop. After the loop finishes, it
 * asserts the file exists on disk with the correct content and the milestone
 * reached VERIFIED.
 *
 * Output: "RESULT: PASS" or "RESULT: FAIL <reason>".
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop, AGENT_EVENTS } from '../src/core/agent/AgentLoop.js';
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolCall,
} from '../src/core/agent/types.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { createCoreTools } from '../src/core/tools/core-tools.js';
import type { ToolFunctionSchema } from '../src/core/tools/types.js';
import { MilestoneStatus } from '../src/core/milestones/types.js';

class MockLLMProvider implements LLMProvider {
  private readonly responses: LLMResponse[];
  private next = 0;

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(
    _messages: LLMMessage[],
    _tools?: ToolFunctionSchema[],
  ): Promise<LLMResponse> {
    if (this.next >= this.responses.length) {
      throw new Error(
        `MockLLMProvider: no more scripted responses (call index ${this.next})`,
      );
    }
    return this.responses[this.next++];
  }
}

function toolCallResponse(
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): LLMResponse {
  const call: LLMToolCall = {
    id: callId,
    type: 'function',
    function: { name: toolName, arguments: JSON.stringify(args) },
  };
  return {
    role: 'assistant',
    content: null,
    tool_calls: [call],
    stop_reason: 'tool_use',
  };
}

function stopResponse(text: string): LLMResponse {
  return { role: 'assistant', content: text, stop_reason: 'stop' };
}

function planningResponse(json: string): LLMResponse {
  return { role: 'assistant', content: json, stop_reason: 'stop' };
}

async function runVerify(): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kovix-verify-gate-'),
  );
  console.log(`[setup] workspaceRoot = ${workspaceRoot}`);

  try {
    const registry = new ToolRegistry();
    for (const tool of createCoreTools()) {
      registry.registerTool(tool);
    }
    console.log(
      `[setup] registered tools: ${registry
        .getAllToolSchemas()
        .map((s) => s.function.name)
        .join(', ')}`,
    );

    const planJson = JSON.stringify([
      { title: 'Write File', description: 'Write test.txt' },
    ]);
    const mockProvider = new MockLLMProvider([
      planningResponse(planJson),
      toolCallResponse('call_write_1', 'write_file', {
        path: 'approval-test.txt',
        content: 'gated',
      }),
      stopResponse('Done.'),
    ]);

    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
      workspaceRoot,
      maxIterations: 15,
    });

    // ── Wire up event listeners for assertion + auto-approval ────────────
    let approvalEventFired = false;
    let approvalToolName = '';
    let approvalPath = '';

    loop.on(AGENT_EVENTS.plan_ready, (plan: unknown) => {
      const milestones = plan as Array<{ title: string; status: string }>;
      console.log(
        `[event] plan_ready: ${milestones.length} milestone(s): ${milestones
          .map((m) => `"${m.title}" (${m.status})`)
          .join(', ')}`,
      );
    });

    loop.on(AGENT_EVENTS.milestone_started, (id: string) => {
      console.log(`[event] milestone_started: ${id}`);
    });

    loop.on(AGENT_EVENTS.tool_call, (payload: unknown) => {
      const p = payload as { callId: string; name: string; args: unknown };
      console.log(`[event] tool_call: ${p.name} (callId=${p.callId})`);
    });

    loop.on(AGENT_EVENTS.approval_required, (payload: unknown) => {
      const p = payload as {
        callId: string;
        name: string;
        args: { path?: string; content?: string };
      };
      approvalEventFired = true;
      approvalToolName = p.name;
      approvalPath = p.args.path ?? '';
      console.log(
        `[event] approval_required: tool="${p.name}" path="${approvalPath}" callId=${p.callId}`,
      );

      // Assertions on the approval payload.
      if (p.name !== 'write_file') {
        throw new Error(
          `approval_required: expected tool "write_file", got "${p.name}"`,
        );
      }
      if (approvalPath !== 'approval-test.txt') {
        throw new Error(
          `approval_required: expected path "approval-test.txt", got "${approvalPath}"`,
        );
      }

      // Simulate the UI clicking "Approve" — unblocks the loop.
      console.log(`[ui-sim] clicking Approve for callId=${p.callId}`);
      loop.approveToolCall(p.callId);
    });

    loop.on(AGENT_EVENTS.tool_result, (payload: unknown) => {
      const p = payload as {
        callId: string;
        result: { ok: boolean; output: string };
      };
      console.log(
        `[event] tool_result: callId=${p.callId} ok=${p.result.ok} output="${p.result.output}"`,
      );
    });

    loop.on(AGENT_EVENTS.milestone_verified, (id: string) => {
      console.log(`[event] milestone_verified: ${id}`);
    });

    // ── Run the milestone task ───────────────────────────────────────────
    const finalPlan = await loop.runMilestoneTask('Write a test file.');

    // ── Assertions ───────────────────────────────────────────────────────
    if (!approvalEventFired) {
      throw new Error('approval_required event never fired');
    }
    console.log(`[assert] approval_required event fired for write_file`);

    if (approvalToolName !== 'write_file') {
      throw new Error(
        `approval tool was "${approvalToolName}", expected "write_file"`,
      );
    }

    const testFilePath = path.join(workspaceRoot, 'approval-test.txt');
    const exists = await fs
      .access(testFilePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error('approval-test.txt was not created on disk');
    }
    const actualContent = await fs.readFile(testFilePath, 'utf8');
    if (actualContent !== 'gated') {
      throw new Error(
        `approval-test.txt content mismatch.\n  expected: "gated"\n  actual:   ${JSON.stringify(actualContent)}`,
      );
    }
    console.log(`[assert] approval-test.txt exists with content "gated"`);

    if (finalPlan.length !== 1) {
      throw new Error(`expected 1 milestone, got ${finalPlan.length}`);
    }
    if (finalPlan[0].status !== MilestoneStatus.VERIFIED) {
      throw new Error(
        `milestone expected VERIFIED, got ${finalPlan[0].status}`,
      );
    }
    console.log(`[assert] milestone reached VERIFIED status`);

    console.log('\nRESULT: PASS');
  } finally {
    try {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      console.log(`[cleanup] removed ${workspaceRoot}`);
    } catch (err) {
      console.error(
        `[cleanup] failed to remove ${workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

runVerify().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\nRESULT: FAIL ' + msg);
  process.exit(1);
});
