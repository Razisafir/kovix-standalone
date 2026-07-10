/**
 * Verification script - proves the extracted agent core runs standalone.
 *
 * Usage:
 *   # Auto-detect provider from env vars (priority: ANTHROPIC > OPENROUTER > NVIDIA > OLLAMA):
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx test/verify.ts
 *   OPENROUTER_API_KEY=sk-or-v1-... npx tsx test/verify.ts
 *   NVIDIA_API_KEY=nvapi-... npx tsx test/verify.ts
 *   OLLAMA_BASE_URL=http://localhost:11434 npx tsx test/verify.ts
 *
 *   # Explicit provider via flag (overrides env detection):
 *   npx tsx test/verify.ts --provider anthropic --api-key sk-ant-...
 *   npx tsx test/verify.ts --provider ollama --base-url http://localhost:11434
 *   npx tsx test/verify.ts --provider openrouter --api-key sk-or-v1-... --model meta-llama/llama-3.3-70b-instruct:free
 *
 *   # Custom task:
 *   npx tsx test/verify.ts --provider anthropic --api-key sk-ant-... --task "create a file called hello.txt with the text test in it"
 *
 *   # List all registered providers:
 *   npx tsx test/verify.ts --list-providers
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
import { AgentLoop, createProvider, listProviders } from '../src/agent/index.js';
import type { AgentLoopEvent, ProviderName } from '../src/agent/index.js';

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const DEFAULT_TASK = 'create a file called hello.txt with the text test in it';
const WORKSPACE_DIR = path.resolve(process.cwd(), 'verify-workspace');

// Parse CLI args
interface ParsedArgs {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    task: string;
    listProviders: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const result: ParsedArgs = { task: DEFAULT_TASK, listProviders: false };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--provider': result.provider = next; i++; break;
            case '--api-key': result.apiKey = next; i++; break;
            case '--model': result.model = next; i++; break;
            case '--base-url': result.baseUrl = next; i++; break;
            case '--task': result.task = next ?? DEFAULT_TASK; i++; break;
            case '--list-providers': result.listProviders = true; break;
        }
    }
    return result;
}

const args = parseArgs(process.argv);

// --list-providers short-circuits everything else
if (args.listProviders) {
    console.log('=== Registered LLM Providers ===');
    console.log('');
    const providers = listProviders();
    for (const p of providers) {
        const verified = p.verified ? 'VERIFIED  ' : 'STUB      ';
        const key = p.requiresApiKey ? 'needs-key' : 'no-key    ';
        const offline = p.offline ? 'offline' : 'online ';
        console.log(`  ${verified} ${key} ${offline}  ${p.name.padEnd(12)}  ${p.label}`);
    }
    console.log('');
    console.log('VERIFIED  = end-to-end tested with a real LLM call (see docs/PHASE0_REPORT.md)');
    console.log('STUB      = interface-ready, NOT tested with a real API call');
    process.exit(0);
}

// ----------------------------------------------------------------------
// Detect set provider env vars — for the multi-env-var warning below.
// NEVER returns key values, only names and lengths.
// ----------------------------------------------------------------------

interface DetectedProviderEnv {
    varName: string;
    keyLength: number;
}

/**
 * Scans the environment for known provider env vars. Used by
 * printProviderEnvWarning() to surface the silent-priority bug: when
 * multiple provider env vars are set simultaneously, the detection chain
 * picks exactly one (ANTHROPIC > OPENROUTER > NVIDIA > OLLAMA) and the
 * others are silently ignored — which has caused real confusion in
 * practice (e.g. a stale ANTHROPIC_API_KEY shadowing a fresh
 * OPENROUTER_API_KEY).
 *
 * Returns entries in priority order (highest first), matching the order
 * resolveProviderConfig() checks them in.
 */
function detectSetProviderEnvVars(): DetectedProviderEnv[] {
    const candidates: Array<{ varName: string; envName: string }> = [
        { varName: 'ANTHROPIC_API_KEY', envName: 'ANTHROPIC_API_KEY' },
        { varName: 'OPENROUTER_API_KEY', envName: 'OPENROUTER_API_KEY' },
        { varName: 'NVIDIA_API_KEY', envName: 'NVIDIA_API_KEY' },
    ];
    const detected: DetectedProviderEnv[] = [];
    for (const { varName, envName } of candidates) {
        const val = process.env[envName];
        if (val && val.length > 0) {
            detected.push({ varName, keyLength: val.length });
        }
    }
    // Ollama is special — it uses base URL / model, not an API key.
    if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
        detected.push({ varName: 'OLLAMA_BASE_URL / OLLAMA_MODEL', keyLength: 0 });
    }
    return detected;
}

/**
 * Prints a clear warning when multiple provider env vars are set at once,
 * explaining which one was picked and why. This prevents the silent
 * shadowing bug where a user sets OPENROUTER_API_KEY but a stale
 * ANTHROPIC_API_KEY from an old shell profile silently wins.
 *
 * Only called when --provider was NOT passed (env detection ran).
 */
function printProviderEnvWarning(pickedLabel: string): void {
    const detected = detectSetProviderEnvVars();
    if (detected.length <= 1) {
        return; // No ambiguity — nothing to warn about.
    }
    console.log('--- provider env-var warning ---');
    console.log(`⚠  Multiple provider env vars are set (${detected.length}).`);
    console.log('   Detection priority is fixed: ANTHROPIC > OPENROUTER > NVIDIA > OLLAMA.');
    console.log('   Detected (in priority order):');
    for (const d of detected) {
        const lenPart = d.keyLength > 0 ? ` (key length ${d.keyLength})` : ' (no key — base URL / model)';
        console.log(`     - ${d.varName}${lenPart}`);
    }
    console.log(`   Picked: ${pickedLabel} — it has the highest priority among the set vars.`);
    console.log('   If this is not what you intended, override with:');
    console.log('     npx tsx test/verify.ts --provider <anthropic|openrouter|nvidia|ollama> [--api-key <key>] [--model <id>]');
    console.log('   Or unset the shadowing var for this session, e.g. in PowerShell:');
    console.log('     $env:ANTHROPIC_API_KEY = $null');
    console.log('--------------------------------');
    console.log('');
}

// ----------------------------------------------------------------------
// Resolve provider config from CLI args + env vars
// ----------------------------------------------------------------------

function resolveProviderConfig(): { name: ProviderName; apiKey?: string; modelId?: string; baseUrl?: string; label: string } {
    // 1. Explicit --provider flag wins
    if (args.provider) {
        const name = args.provider as ProviderName;
        return {
            name,
            apiKey: args.apiKey,
            modelId: args.model,
            baseUrl: args.baseUrl,
            label: `--provider ${name}`,
        };
    }

    // 2. Auto-detect from env vars (priority: ANTHROPIC > OPENROUTER > NVIDIA > OLLAMA)
    if (process.env.ANTHROPIC_API_KEY) {
        return {
            name: 'anthropic',
            apiKey: process.env.ANTHROPIC_API_KEY,
            modelId: args.model ?? 'claude-sonnet-4-20250514',
            label: 'ANTHROPIC_API_KEY',
        };
    }
    if (process.env.OPENROUTER_API_KEY) {
        return {
            name: 'openrouter',
            apiKey: process.env.OPENROUTER_API_KEY,
            modelId: args.model ?? process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free',
            label: 'OPENROUTER_API_KEY',
        };
    }
    if (process.env.NVIDIA_API_KEY) {
        return {
            name: 'nvidia',
            apiKey: process.env.NVIDIA_API_KEY,
            modelId: args.model ?? process.env.NVIDIA_MODEL ?? 'meta/llama-3.3-70b-instruct',
            label: 'NVIDIA_API_KEY',
        };
    }
    if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
        return {
            name: 'ollama',
            modelId: process.env.OLLAMA_MODEL,
            baseUrl: process.env.OLLAMA_BASE_URL,
            label: 'OLLAMA_BASE_URL / OLLAMA_MODEL',
        };
    }

    // 3. Default: try Ollama (it's free, just needs to be running locally)
    return {
        name: 'ollama',
        label: 'default (Ollama at localhost:11434)',
    };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('=== Kovix Standalone Agent Verification ===');
    console.log('');
    console.log('Task: ' + args.task);
    console.log('Workspace: ' + WORKSPACE_DIR);

    const providerConfig = resolveProviderConfig();
    // Surface the silent-shadowing bug: if multiple provider env vars are
    // set and the user did NOT pass --provider, warn them about which one
    // was picked and why. No-op when --provider was used or only one var
    // is set.
    if (!args.provider) {
        printProviderEnvWarning(providerConfig.label);
    }
    console.log('Provider: ' + providerConfig.name + ' (' + providerConfig.label + ')');

    const maskedKey = providerConfig.apiKey
        ? providerConfig.apiKey.slice(0, 12) + '...' + providerConfig.apiKey.slice(-4)
        : (providerConfig.name === 'ollama' ? 'not required' : 'NOT SET');
    console.log('API key: ' + maskedKey);
    if (providerConfig.modelId) { console.log('Model: ' + providerConfig.modelId); }
    if (providerConfig.baseUrl) { console.log('Base URL: ' + providerConfig.baseUrl); }
    console.log('');

    let provider;
    try {
        provider = createProvider({
            name: providerConfig.name,
            apiKey: providerConfig.apiKey,
            modelId: providerConfig.modelId,
            baseUrl: providerConfig.baseUrl,
        });
    } catch (err) {
        console.error('FAIL: Could not create provider: ' + (err instanceof Error ? err.message : String(err)));
        console.error('');
        console.error('Available providers (use --list-providers for details):');
        for (const p of listProviders()) {
            console.error('  --provider ' + p.name + '  ' + (p.requiresApiKey ? '(needs --api-key)' : '(no key needed)'));
        }
        process.exit(1);
    }

    // For Ollama, check status first and report clearly if it's not reachable
    if (providerConfig.name === 'ollama') {
        console.log('--- Checking Ollama status ---');
        const status = await provider.checkStatus();
        console.log('Ollama status: ' + status);
        if (status !== 'available') {
            console.log('');
            console.log('Ollama is not available. To fix:');
            console.log('  1. Install Ollama from https://ollama.com');
            console.log('  2. Start the Ollama service (usually `ollama serve`)');
            console.log('  3. Pull a model: `ollama pull llama3.1`');
            console.log('  4. Re-run this script');
            console.log('');
            console.log('Or test with a cloud provider instead:');
            console.log('  ANTHROPIC_API_KEY=sk-ant-... npx tsx test/verify.ts');
            console.log('  OPENROUTER_API_KEY=sk-or-v1-... npx tsx test/verify.ts');
            process.exit(1);
        }
        const activeModel = provider.getActiveModel();
        console.log('Active model: ' + (activeModel?.id ?? 'none'));
        console.log('');
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
        plan = await agent.runPlanningPhase(args.task);
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
        const stream = agent.run(args.task);
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

    const providerLabel = providerConfig.name + ' (' + providerConfig.label + ')';
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
        console.log('The extracted agent core works standalone with ' + providerLabel + '.');
        console.log('Plan-Approve-Execute-Verify flow is real.');
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
            console.log('  [tool_executing] ' + event.toolName + ': ' + (event.detail ?? ''));
            break;
        case 'tool_result': {
            const mark = event.success ? 'OK' : 'FAIL';
            console.log('  [tool_result] ' + event.toolName + ' ' + mark);
            const out = event.result.substring(0, 200).replace(/\n/g, '\n    ');
            console.log('    output: ' + out);
            break;
        }
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
        case 'error': {
            const tag = event.recoverable ? 'recoverable' : 'FATAL';
            console.log('');
            console.log('  [error ' + tag + '] ' + event.text);
            break;
        }
        case 'verification_start':
            console.log('  [verification_start] ' + event.command);
            break;
        case 'verification_result': {
            const vmark = event.passed ? 'PASS' : 'FAIL';
            const unverified = event.unverified ? ' (unverified)' : '';
            console.log('  [verification_result] ' + vmark + unverified);
            if (event.output) {
                const vout = event.output.substring(0, 200).replace(/\n/g, '\n    ');
                console.log('    output: ' + vout);
            }
            break;
        }
        default:
            console.log('  [' + (event as { type: string }).type + ']');
    }
}

main().catch(err => {
    console.error('UNCAUGHT ERROR:', err);
    process.exit(99);
});
