/**
 * verify-milestones.ts — Kovix 2.0 Phase 2 finish line.
 *
 * Run with:
 *   npx tsx test/verify-milestones.ts
 *
 * Tests the two-phase Milestone execution flow end-to-end with a
 * MockLLMProvider that returns a 5-call scripted sequence:
 *
 *   Call 1 (planning)      — JSON array: 2 milestones (Create Dir, Write File)
 *   Call 2 (milestone 1)   — tool_call: list_files(".")
 *   Call 3 (milestone 1)   — stop: "Done checking."
 *   Call 4 (milestone 2)   — tool_call: write_file("test-dir/test.txt", "success")
 *   Call 5 (milestone 2)   — stop: "File written."
 *
 * Pass criteria:
 *  - The planning call returns a 2-milestone plan.
 *  - MilestoneManager has 2 milestones after the run.
 *  - Both milestones end with status VERIFIED.
 *  - The file test-dir/test.txt exists on disk with content "success".
 *
 * Output: prints "RESULT: PASS" or "RESULT: FAIL <reason>".
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from '../src/core/agent/AgentLoop.js';
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

/**
 * MockLLMProvider — returns a pre-scripted sequence of LLMResponse values.
 *
 * For Phase 2, the first call (planning) is made WITHOUT tools and must
 * return a raw JSON string in `content`. Subsequent calls (execution) are
 * made WITH tools and follow the Phase 1 tool_call/stop format.
 */
class MockLLMProvider implements LLMProvider {
  private readonly responses: LLMResponse[];
  private next = 0;
  readonly receivedMessages: LLMMessage[][] = [];
  readonly receivedTools: (ToolFunctionSchema[] | undefined)[] = [];

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolFunctionSchema[],
  ): Promise<LLMResponse> {
    this.receivedMessages.push(messages.map((m) => ({ ...m })));
    this.receivedTools.push(tools);

    if (this.next >= this.responses.length) {
      throw new Error(
        `MockLLMProvider: no more scripted responses (call index ${this.next})`,
      );
    }
    return this.responses[this.next++];
  }
}

/** Build an assistant response with one tool_call. */
function toolCallResponse(
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): LLMResponse {
  const call: LLMToolCall = {
    id: callId,
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
  return {
    role: 'assistant',
    content: null,
    tool_calls: [call],
    stop_reason: 'tool_use',
  };
}

/** Build an assistant response that terminates the tool loop. */
function stopResponse(text: string): LLMResponse {
  return {
    role: 'assistant',
    content: text,
    stop_reason: 'stop',
  };
}

/** Build a planning response (no tools, raw JSON content). */
function planningResponse(json: string): LLMResponse {
  return {
    role: 'assistant',
    content: json,
    stop_reason: 'stop',
  };
}

async function runVerify(): Promise<void> {
  // 1. Temp workspace.
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kovix-verify-ms-'),
  );
  console.log(`[setup] workspaceRoot = ${workspaceRoot}`);

  try {
    // 2. Build the registry with core filesystem tools.
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

    // 3. Script the 5-call mock sequence.
    const planJson = JSON.stringify([
      { title: 'Create Dir', description: 'Make a test dir' },
      { title: 'Write File', description: 'Write test.txt in that dir' },
    ]);
    const mockProvider = new MockLLMProvider([
      // Call 1: planning response (raw JSON, no tools).
      planningResponse(planJson),
      // Call 2: milestone 1 — list_files.
      toolCallResponse('call_ms1_1', 'list_files', { path: '.' }),
      // Call 3: milestone 1 — stop.
      stopResponse('Done checking.'),
      // Call 4: milestone 2 — write_file (creates test-dir/ on the fly).
      toolCallResponse('call_ms2_1', 'write_file', {
        path: 'test-dir/test.txt',
        content: 'success',
      }),
      // Call 5: milestone 2 — stop.
      stopResponse('File written.'),
    ]);

    // 4. Construct + run the milestone task.
    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
      workspaceRoot,
      maxIterations: 15,
    });

    const finalPlan = await loop.runMilestoneTask('Set up a test directory and write a file.');

    // 5. Assertions.
    // 5a. 2 milestones in the plan.
    if (finalPlan.length !== 2) {
      throw new Error(
        `expected 2 milestones in final plan, got ${finalPlan.length}`,
      );
    }
    console.log(`[assert] plan has 2 milestones`);

    // 5b. Both VERIFIED.
    for (const m of finalPlan) {
      if (m.status !== MilestoneStatus.VERIFIED) {
        throw new Error(
          `milestone "${m.title}" expected VERIFIED but got ${m.status}`,
        );
      }
    }
    console.log(`[assert] both milestones ended VERIFIED`);

    // 5c. test-dir/test.txt exists with "success".
    const testFilePath = path.join(workspaceRoot, 'test-dir', 'test.txt');
    const exists = await fs
      .access(testFilePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error('test-dir/test.txt was not created on disk');
    }
    const actualContent = await fs.readFile(testFilePath, 'utf8');
    if (actualContent !== 'success') {
      throw new Error(
        `test-dir/test.txt content mismatch.\n  expected: "success"\n  actual:   ${JSON.stringify(actualContent)}`,
      );
    }
    console.log(`[assert] test-dir/test.txt exists with content "success"`);

    // 5d. LLM was called exactly 5 times (1 plan + 2 + 2 exec).
    if (mockProvider.receivedMessages.length !== 5) {
      throw new Error(
        `expected 5 LLM calls, got ${mockProvider.receivedMessages.length}`,
      );
    }
    console.log(`[assert] LLM was called exactly 5 times`);

    // 5e. First call (planning) had NO tools; subsequent calls had tools.
    if (mockProvider.receivedTools[0] !== undefined) {
      throw new Error('planning call should have no tools, but received some');
    }
    for (let i = 1; i < 5; i++) {
      if (mockProvider.receivedTools[i] === undefined) {
        throw new Error(`execution call ${i} should have tools, but got none`);
      }
    }
    console.log(`[assert] planning call had no tools; execution calls had tools`);

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
