/**
 * verify-agent-loop.ts — Kovix 2.0 Phase 1 finish line.
 *
 * Run with:
 *   npx tsx test/verify-agent-loop.ts
 *
 * Tests the AgentLoop end-to-end with a MockLLMProvider that returns a
 * pre-scripted sequence of responses. No real API calls, no credits burned.
 *
 * Scripted sequence:
 *   1. list_files(".")            — prove the loop executes a tool call.
 *   2. write_file("kovix-test.txt", "Kovix 2.0 is alive")
 *                                  — prove writes land on disk.
 *   3. stop("Task complete.")      — prove the loop terminates on `stop`.
 *
 * Pass criteria:
 *   - The script runs with zero errors.
 *   - `kovix-test.txt` exists on disk after runTask returns.
 *   - The file content is exactly "Kovix 2.0 is alive".
 *   - The script cleans up the test file + temp workspace.
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

/**
 * MockLLMProvider — returns a pre-scripted sequence of LLMResponse values.
 *
 * Each call to `chat()` pops the next response. If the script runs out, the
 * provider throws — this catches off-by-one errors in the test script.
 *
 * The provider records the messages it receives so the test can assert that
 * tool results were correctly appended to the history.
 */
class MockLLMProvider implements LLMProvider {
  private readonly responses: LLMResponse[];
  private next = 0;
  readonly receivedMessages: LLMMessage[][] = [];

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(
    messages: LLMMessage[],
    _tools?: ToolFunctionSchema[],
  ): Promise<LLMResponse> {
    // Snapshot the messages we received, for post-hoc assertions.
    this.receivedMessages.push(messages.map((m) => ({ ...m })));

    if (this.next >= this.responses.length) {
      throw new Error(
        `MockLLMProvider: no more scripted responses (call index ${this.next})`,
      );
    }
    const r = this.responses[this.next++];
    return r;
  }
}

/** Helper: build an assistant LLMResponse containing one tool_call. */
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

/** Helper: build an assistant LLMResponse that terminates the loop. */
function stopResponse(text: string): LLMResponse {
  return {
    role: 'assistant',
    content: text,
    stop_reason: 'stop',
  };
}

async function runVerify(): Promise<void> {
  // 1. Create a temp workspace directory. Unique per run; cleaned up at the end.
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kovix-verify-'),
  );
  console.log(`[setup] workspaceRoot = ${workspaceRoot}`);

  try {
    // 2. Build the tool registry with the three core filesystem tools.
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

    // 3. Build the MockLLMProvider with the scripted sequence.
    const mockProvider = new MockLLMProvider([
      // Iteration 1: list_files in the current directory.
      toolCallResponse('call_1', 'list_files', { path: '.' }),
      // Iteration 2: write_file with the test content.
      toolCallResponse('call_2', 'write_file', {
        path: 'kovix-test.txt',
        content: 'Kovix 2.0 is alive',
      }),
      // Iteration 3: stop with a completion message.
      stopResponse('Task complete.'),
    ]);

    // 4. Construct the AgentLoop and run it.
    const loop = new AgentLoop({
      provider: mockProvider,
      registry,
      workspaceRoot,
      maxIterations: 15,
    });

    await loop.runTask('Create a test file.');

    // 5. Assert the file exists with the expected content.
    const testFilePath = path.join(workspaceRoot, 'kovix-test.txt');
    const exists = await fs
      .access(testFilePath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      throw new Error('kovix-test.txt was not created on disk');
    }

    const actualContent = await fs.readFile(testFilePath, 'utf8');
    const expectedContent = 'Kovix 2.0 is alive';
    if (actualContent !== expectedContent) {
      throw new Error(
        `kovix-test.txt content mismatch.\n  expected: ${JSON.stringify(expectedContent)}\n  actual:   ${JSON.stringify(actualContent)}`,
      );
    }
    console.log(`[assert] kovix-test.txt exists with correct content`);

    // 6. Assert the loop saw exactly 3 LLM calls (no extra iterations).
    if (mockProvider.receivedMessages.length !== 3) {
      throw new Error(
        `expected 3 LLM calls, got ${mockProvider.receivedMessages.length}`,
      );
    }
    console.log(`[assert] LLM was called exactly 3 times`);

    // 7. Assert the third call's history included a `tool` role message for
    //    the write_file call (proves tool results are appended correctly).
    const thirdCallMessages = mockProvider.receivedMessages[2];
    const writeToolResult = thirdCallMessages.find(
      (m) => m.role === 'tool' && m.name === 'write_file',
    );
    if (!writeToolResult) {
      throw new Error(
        'third LLM call was missing the write_file tool-result message in history',
      );
    }
    console.log(`[assert] tool results were correctly appended to history`);

    console.log('\nRESULT: PASS');
  } finally {
    // 8. Clean up the temp workspace, regardless of pass/fail.
    try {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      console.log(`[cleanup] removed ${workspaceRoot}`);
    } catch (err) {
      // Don't mask a test failure with a cleanup failure.
      console.error(
        `[cleanup] failed to remove ${workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Entry point. Catch all errors and print RESULT: FAIL with the reason.
runVerify().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\nRESULT: FAIL ' + msg);
  process.exit(1);
});
