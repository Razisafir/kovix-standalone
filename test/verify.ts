/**
 * Verification script - proves the extracted agent core runs standalone.
 *
 * Run with:
 *   # OpenRouter (free model, default):
 *   OPENROUTER_API_KEY=sk-or-v1-... npx tsx test/verify.ts
 *   # OpenRouter with a specific free model:
 *   OPENROUTER_API_KEY=sk-or-v1-... OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free npx tsx test/verify.ts
 *   # Anthropic (Claude):
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx test/verify.ts
 *   # Custom task:
 *   OPENROUTER_API_KEY=sk-or-v1-... npx tsx test/verify.ts --task "create a file called hello.txt with the text test in it"
 *
 * What this proves (or fails to prove):
 *   1. The agent instantiates without VS Code's DI system
 *   2. It makes a REAL LLM API call (not mocked)
 *   3. The LLM returns a plan
 *   4. The staging layer BLOCKS the write - hello.txt must NOT exist
 *      between the planning phase and the explicit approval call
 *   5. After approval, hello.txt is REALLY on disk with the right content
 *
 * Output: a real transcript of every event the agent emits, plus a final
 * PASS/FAIL summary. Nothing is faked. If a step fails, we say so.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AgentLoop, CloudProvider } from '../src/agent/index.js';
import type { AgentLoopEvent } from '../src/agent/index.js';

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const DEFAULT_TASK = 'create a file called hello.txt with the text test in it';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
// Default free OpenRouter model that supports tool calling.
// Override with OPENROUTER_MODEL env var if you want a different one.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// NVIDIA NIM (OpenAI-compatible). Free tier with 1000 credits/month.
// Models that support tool calling:
//   meta/llama-3.3-70b-instruct
//   meta/llama-3.1-70b-instruct
//   meta/llama-3.1-405b-instruct
//   nvidia/llama-3.1-nemotron-70b-instruct
//   qwen/qwen2.5-7b-instruct
const NVIDIA_MODEL = process.env.NVIDIA_MODEL ?? 'meta/llama-3.3-70b-instruct';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const WORKSPACE_DIR = path.resolve(process.cwd(), 'verify-workspace');

// Parse --task argument
const taskArgIdx = process.argv.indexOf('--task');
const task = taskArgIdx >= 0 ? process.argv[taskArgIdx + 1] : DEFAULT_TASK;

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('=== Kovix Standalone Agent Verification ===');
    console.log('');
    console.log('Task: ' + task);
    console.log('Workspace: ' + WORKSPACE_DIR);

    // Pick provider based on which key is set (priority: ANTHROPIC > NVIDIA > OPENROUTER)
    let providerConfig: { apiKey: string; modelId: string; baseUrl?: string; provider?: 'anthropic' | 'openrouter' | 'nvidia' };
    let providerLabel: string;
    if (ANTHROPIC_API_KEY) {
        providerConfig = { apiKey: ANTHROPIC_API_KEY, modelId: 'claude-sonnet-4-20250514' };
        providerLabel = 'Anthropic (claude-sonnet-4)';
    } else if (NVIDIA_API_KEY) {
        providerConfig = {
            apiKey: NVIDIA_API_KEY,
            modelId: NVIDIA_MODEL,
            baseUrl: NVIDIA_BASE_URL,
            provider: 'nvidia',
        };
        providerLabel = 'NVIDIA NIM (' + NVIDIA_MODEL + ')';
    } else if (OPENROUTER_API_KEY) {
        providerConfig = {
            apiKey: OPENROUTER_API_KEY,
            modelId: OPENROUTER_MODEL,
            baseUrl: OPENROUTER_BASE_URL,
            provider: 'openrouter',
        };
        providerLabel = 'OpenRouter (' + OPENROUTER_MODEL + ')';
    } else {
        providerLabel = 'NOT SET';
        providerConfig = { apiKey: '', modelId: '' };
    }

    const maskedKey = providerConfig.apiKey
        ? providerConfig.apiKey.slice(0, 12) + '...' + providerConfig.apiKey.slice(-4)
        : 'NOT SET';
    console.log('Provider: ' + providerLabel);
    console.log('API key: ' + maskedKey);
    console.log('');

    if (!providerConfig.apiKey) {
        console.error('FAIL: No API key found.');
        console.error('Set one of:');
        console.error('  NVIDIA_API_KEY=nvapi-...          (uses meta/llama-3.3-70b-instruct by default)');
        console.error('  OPENROUTER_API_KEY=sk-or-v1-...  (uses a free model by default)');
        console.error('  ANTHROPIC_API_KEY=sk-ant-...');
        console.error('');
        console.error('Example:');
        console.error('  NVIDIA_API_KEY=nvapi-... npx tsx test/verify.ts');
        process.exit(1);
    }

    // Set up a clean workspace
    console.log('--- Setting up workspace ---');
    try { await fs.rm(WORKSPACE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    console.log('Created: ' + WORKSPACE_DIR);

    // Track approval state
    let approvalCalled = false;
    let approvalFilePath = '';
    let approvalProposedContent = '';
    let fileWrittenBeforeApproval = false;
    let fileWrittenAfterApproval = false;

    // Create the agent
    const provider = new CloudProvider(providerConfig);

    const agent = new AgentLoop({
        aiProvider: provider,
        workspaceRoot: WORKSPACE_DIR,
        log: (msg: string) => console.log('  [agent] ' + msg),
        approveWrite: async (filePath: string, proposedContent: string, _existing: string | null) => {
            approvalCalled = true;
            approvalFilePath = filePath;
            approvalProposedContent = proposedContent;
            console.log('');
            console.log('--- APPROVAL CALLBACK FIRED ---');
            console.log('File: ' + filePath);
            console.log('Proposed content (' + proposedContent.length + ' chars):');
            const lines = proposedContent.split('\n');
            for (const line of lines) {
                console.log('  | ' + line);
            }

            // Check the file is NOT on disk yet (staging must block the write)
            try {
                await fs.readFile(path.join(WORKSPACE_DIR, filePath), 'utf8');
                fileWrittenBeforeApproval = true;
                console.log('!!! VIOLATION: File exists on disk BEFORE approval was given !!!');
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    console.log('Confirmed: file NOT on disk before approval (staging works).');
                }
            }
            console.log('Approving...');
            return true;
        },
        approveInterpreterCommand: async (cmd: string) => {
            console.log('  [interpreter approval] Auto-approving: ' + cmd);
            return true;
        },
        onlineMode: false,
    });

    // ----------------------------------------------------------------------
    // Phase 1: Planning
    // ----------------------------------------------------------------------
    console.log('');
    console.log('=== PHASE 1: PLANNING ===');
    let plan;
    try {
        plan = await agent.runPlanningPhase(task);
    } catch (err) {
        console.error('PLANNING FAILED:', err instanceof Error ? err.message : String(err));
        process.exit(2);
    }

    console.log('');
    console.log('--- PLAN RESULT ---');
    console.log('Steps: ' + plan.steps.length);
    for (const step of plan.steps) {
        console.log('  ' + (step.index + 1) + '. [' + step.action + '] ' + step.target);
    }
    console.log('');
    console.log('Raw LLM response (first 800 chars):');
    console.log(plan.rawResponse.substring(0, 800));
    console.log('');

    // ----------------------------------------------------------------------
    // Phase 2: Execution
    // ----------------------------------------------------------------------
    console.log('');
    console.log('=== PHASE 2: EXECUTION ===');

    let eventCount = 0;
    let completeReceived = false;
    let errorReceived: string | null = null;

    try {
        const stream = agent.run(task);
        for await (const event of stream as AsyncIterable<AgentLoopEvent>) {
            eventCount++;
            logEvent(event);

            if (event.type === 'complete') {
                completeReceived = true;
            }
            if (event.type === 'error' && !event.recoverable) {
                errorReceived = event.text;
            }
            if (event.type === 'file_written') {
                fileWrittenAfterApproval = true;
                console.log('  >>> file_written event: ' + event.filePath);
            }
        }
    } catch (err) {
        console.error('EXECUTION STREAM THREW:', err instanceof Error ? err.message : String(err));
        process.exit(3);
    }

    console.log('');
    console.log('--- EXECUTION SUMMARY ---');
    console.log('Total events: ' + eventCount);
    console.log('complete event received: ' + completeReceived);
    console.log('fatal error: ' + (errorReceived ?? 'none'));
    console.log('approval callback called: ' + approvalCalled);
    console.log('file written before approval: ' + fileWrittenBeforeApproval);
    console.log('file_written event received: ' + fileWrittenAfterApproval);

    // ----------------------------------------------------------------------
    // Phase 3: Verify the file on disk
    // ----------------------------------------------------------------------
    console.log('');
    console.log('=== PHASE 3: DISK VERIFICATION ===');

    const helloPath = path.join(WORKSPACE_DIR, 'hello.txt');
    let diskContent: string | null = null;
    let diskExists = false;
    try {
        diskContent = await fs.readFile(helloPath, 'utf8');
        diskExists = true;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            diskExists = false;
        }
    }

    console.log('hello.txt exists on disk: ' + diskExists);
    if (diskExists) {
        console.log('hello.txt content: ' + JSON.stringify(diskContent));
        console.log('hello.txt length: ' + (diskContent?.length ?? 0) + ' chars');
    }

    // ----------------------------------------------------------------------
    // Final verdict
    // ----------------------------------------------------------------------
    console.log('');
    console.log('=== FINAL VERDICT ===');

    const checks: Array<{ name: string; pass: boolean; detail?: string }> = [
        { name: 'Agent instantiated (no VS Code DI)', pass: true },
        { name: 'Real LLM API call succeeded (' + providerLabel + ')', pass: plan.steps.length > 0 || plan.rawResponse.length > 0 },
        { name: 'LLM returned a plan', pass: plan.steps.length > 0, detail: plan.steps.length + ' steps' },
        { name: 'Approval callback was invoked', pass: approvalCalled, detail: approvalCalled ? 'file: ' + approvalFilePath : 'no callback fired' },
        { name: 'File NOT written before approval (staging blocks writes)', pass: !fileWrittenBeforeApproval, detail: fileWrittenBeforeApproval ? 'VIOLATION: write hit disk before approval' : 'staging worked' },
        { name: 'hello.txt exists on disk after execution', pass: diskExists, detail: diskExists ? 'content: ' + JSON.stringify(diskContent) : 'file not on disk' },
        { name: "hello.txt contains 'test'", pass: diskContent === 'test' || (diskContent?.trim() === 'test'), detail: diskContent ? 'actual: ' + JSON.stringify(diskContent) : 'no content' },
        { name: 'complete event received', pass: completeReceived },
    ];

    let allPass = true;
    for (const c of checks) {
        const status = c.pass ? 'PASS' : 'FAIL';
        if (!c.pass) { allPass = false; }
        const detail = c.detail ? ' - ' + c.detail : '';
        console.log('  [' + status + '] ' + c.name + detail);
    }

    console.log('');
    if (allPass) {
        console.log('=== ALL CHECKS PASSED ===');
        console.log('The extracted agent core works standalone. Plan-Approve-Execute-Verify flow is real.');
        process.exit(0);
    } else {
        console.log('=== SOME CHECKS FAILED ===');
        console.log('See details above. The agent ran but did not satisfy every guarantee.');
        process.exit(4);
    }
}

function logEvent(event: AgentLoopEvent): void {
    switch (event.type) {
        case 'token':
            process.stdout.write(event.text);
            break;
        case 'tool_start':
            console.log('');
            console.log('  [tool_start] ' + event.toolName + ' (id=' + event.toolId + ')');
            break;
        case 'tool_executing':
            const detail = event.detail ?? '';
            console.log('  [tool_executing] ' + event.toolName + ': ' + detail);
            break;
        case 'tool_result':
            const mark = event.success ? 'OK' : 'FAIL';
            console.log('  [tool_result] ' + event.toolName + ' ' + mark);
            const out = event.result.substring(0, 200).replace(/\n/g, '\n    ');
            console.log('    output: ' + out);
            break;
        case 'approval_request':
            console.log('');
            console.log('  [approval_request] ' + event.filePath);
            break;
        case 'file_written':
            console.log('  [file_written] ' + event.filePath);
            break;
        case 'complete':
            console.log('');
            console.log('  [complete] ' + event.summary.substring(0, 200));
            break;
        case 'error':
            const tag = event.recoverable ? 'recoverable' : 'FATAL';
            console.log('');
            console.log('  [error ' + tag + '] ' + event.text);
            break;
        case 'verification_start':
            console.log('  [verification_start] ' + event.command);
            break;
        case 'verification_result':
            const vmark = event.passed ? 'PASS' : 'FAIL';
            const unverified = event.unverified ? ' (unverified)' : '';
            console.log('  [verification_result] ' + vmark + unverified);
            if (event.output) {
                const vout = event.output.substring(0, 200).replace(/\n/g, '\n    ');
                console.log('    output: ' + vout);
            }
            break;
        default:
            console.log('  [' + event.type + ']');
    }
}

main().catch(err => {
    console.error('UNCAUGHT ERROR:', err);
    process.exit(99);
});
