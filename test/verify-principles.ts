/**
 * verify-principles.ts — verify the AGENT_PRINCIPLES_CONTRACT is actually
 * present in the system prompts sent by refinementService, planningService,
 * and the agent loop's execution prompt.
 *
 * STRATEGY
 * --------
 * We create a CapturingProvider — a fake IConstructAIProvider that records
 * the `systemPrompt` from the options passed to chat(). Then we:
 *
 *   1. Call RefinementService.refine() with the capturing provider.
 *      → capture the prompt the refinement service built.
 *   2. Call PlanningService.plan() with the capturing provider.
 *      → capture the prompt the planning service built.
 *   3. Call AgentLoop.run() with the capturing provider.
 *      → capture the prompt the agent loop's buildSystemPrompt() built.
 *
 * For each captured prompt, we assert that AGENT_PRINCIPLES_CONTRACT is
 * present verbatim (we check a few representative substrings, not the
 * whole thing — the whole string is long).
 *
 * This is a REAL transcript: we really invoke the services with a real
 * provider instance (just mocked at the network layer — it yields a
 * minimal valid stream and exits). The prompts we capture are the
 * prompts the services really build and really pass to provider.chat().
 *
 * RUN
 * ---
 *   npx tsx test/verify-principles.ts
 */

import { RefinementService, type RefinementSpec } from '../src/agent/refinement/refinementService.js';
import { PlanningService } from '../src/agent/planning/planningService.js';
import { AgentLoop } from '../src/agent/agentLoop.js';
import { AGENT_PRINCIPLES_CONTRACT } from '../src/agent/agentPrinciples.js';
import type {
    IConstructAIProvider,
    IChatMessage,
    IChatOptions,
    IModelInfo,
    IToolDefinition,
    AIStreamEvent,
    AIProviderType,
    ProviderStatus,
} from '../src/agent/llm/types.js';

// ----------------------------------------------------------------------
// CapturingProvider — records every systemPrompt it sees.
// ----------------------------------------------------------------------

interface CapturedCall {
    stage: string;
    systemPrompt: string | undefined;
    messageCount: number;
    toolCount: number;
}

class CapturingProvider implements IConstructAIProvider {
    readonly providerType: AIProviderType = 'cloud';
    public captured: CapturedCall[] = [];
    public stageLabel: string = '';

    async *chat(
        messages: IChatMessage[],
        tools: IToolDefinition[],
        options?: IChatOptions,
    ): AsyncIterable<AIStreamEvent> {
        // Record what was passed.
        this.captured.push({
            stage: this.stageLabel,
            systemPrompt: options?.systemPrompt,
            messageCount: messages.length,
            toolCount: tools.length,
        });

        // Yield a minimal valid stream that ends immediately.
        // For refinement (emit_spec tool), we don't call the tool — the
        // service's retry loop will see "no tool call" and return the
        // text as a question. That's fine; we only care about the prompt.
        yield { type: 'token', text: 'ok' };
        yield { type: 'done', stopReason: 'stop' };
    }

    async listModels(): Promise<IModelInfo[]> { return []; }
    getActiveModel(): IModelInfo | undefined { return undefined; }
    async setActiveModel(_modelId: string): Promise<boolean> { return true; }
    isOffline(): boolean { return false; }
    async checkStatus(): Promise<ProviderStatus> { return ProviderStatus.Available; }
    dispose(): void { /* no-op */ }
}

// ----------------------------------------------------------------------
// Probes
// ----------------------------------------------------------------------

const PROBE_SUBSTRINGS: Array<{ label: string; text: string }> = [
    { label: 'NO COMPLETION CLAIM WITHOUT EVIDENCE', text: 'NO COMPLETION CLAIM WITHOUT EVIDENCE' },
    { label: 'VERIFY AGAINST THE REAL THING', text: 'VERIFY AGAINST THE REAL THING' },
    { label: 'STOP AND REPORT WHEN BLOCKED', text: 'STOP AND REPORT WHEN BLOCKED' },
    { label: 'SMALLEST CORRECT CHANGE', text: 'SMALLEST CORRECT CHANGE' },
    { label: 'VERIFY AFTER EVERY MILESTONE', text: 'VERIFY AFTER EVERY MILESTONE' },
    { label: 'VISIBLE PROGRESS', text: 'VISIBLE PROGRESS' },
];

const sampleSpec: RefinementSpec = {
    must: ['CLI accepts a folder path'],
    should: ['Print a summary every 60 seconds'],
    wont: ['No GUI'],
    doneCriteria: ['Running the tool prints a line within 1 second'],
};

async function probeRefinement(): Promise<CapturedCall[]> {
    const provider = new CapturingProvider();
    provider.stageLabel = 'refinement';
    const svc = new RefinementService({ aiProvider: provider, minTurns: 1, maxTurns: 2 });
    // Use priorTurns long enough to skip the "premature" path — call with
    // enough rounds that the service doesn't retry. 2 turns = past min.
    await svc.refine({
        ideaText: 'a tiny CLI tool that watches a folder and prints changed file paths',
        priorTurns: [
            { role: 'assistant', content: 'Question 1?' },
            { role: 'user', content: 'Yes.' },
            { role: 'assistant', content: 'Question 2?' },
            { role: 'user', content: 'Yes.' },
        ],
    });
    return provider.captured;
}

async function probePlanning(): Promise<CapturedCall[]> {
    const provider = new CapturingProvider();
    provider.stageLabel = 'planning';
    const svc = new PlanningService({ aiProvider: provider });
    await svc.plan({
        spec: sampleSpec,
        ideaText: 'a tiny CLI tool that watches a folder',
    });
    return provider.captured;
}

async function probeAgentLoop(): Promise<CapturedCall[]> {
    const provider = new CapturingProvider();
    provider.stageLabel = 'agentLoop';
    const loop = new AgentLoop({
        aiProvider: provider,
        workspaceRoot: '/tmp/probe-workspace',
        log: () => { /* silent */ },
    });
    // Drain the generator — it will yield events and exit.
    const stream = loop.run('do a small task: create a file');
    try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of stream) {
            break; // one round is enough to capture the prompt
        }
    } catch (_err) {
        // The mock provider yields 'ok' + done, so the loop may exit
        // immediately. We only care about the captured prompt.
    }
    return provider.captured;
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('  FAIL: ' + message);
        process.exitCode = 1;
    } else {
        console.log('  ok: ' + message);
    }
}

async function main(): Promise<void> {
    console.log('=== verify-principles: AGENT_PRINCIPLES_CONTRACT injection ===\n');
    console.log('Principles source (single source of truth): src/agent/agentPrinciples.ts');
    console.log('Probe substrings checked:');
    for (const p of PROBE_SUBSTRINGS) {
        console.log('  - ' + p.label);
    }
    console.log('');

    const allCaptured: Array<{ stage: string; prompt: string | undefined }> = [];

    console.log('[1/3] Probing RefinementService...');
    const refCaptured = await probeRefinement();
    if (refCaptured.length === 0) {
        console.error('  FAIL: refinementService did not call provider.chat()');
        process.exitCode = 1;
        return;
    }
    console.log('  captured ' + refCaptured.length + ' call(s).');
    for (const c of refCaptured) {
        allCaptured.push({ stage: c.stage, prompt: c.systemPrompt });
    }

    console.log('[2/3] Probing PlanningService...');
    const planCaptured = await probePlanning();
    if (planCaptured.length === 0) {
        console.error('  FAIL: planningService did not call provider.chat()');
        process.exitCode = 1;
        return;
    }
    console.log('  captured ' + planCaptured.length + ' call(s).');
    for (const c of planCaptured) {
        allCaptured.push({ stage: c.stage, prompt: c.systemPrompt });
    }

    console.log('[3/3] Probing AgentLoop.run()...');
    const agentCaptured = await probeAgentLoop();
    if (agentCaptured.length === 0) {
        console.error('  FAIL: agentLoop did not call provider.chat()');
        process.exitCode = 1;
        return;
    }
    console.log('  captured ' + agentCaptured.length + ' call(s).');
    for (const c of agentCaptured) {
        allCaptured.push({ stage: c.stage, prompt: c.systemPrompt });
    }

    console.log('\n=== Verifying principles are present in each captured prompt ===\n');

    let anyFail = false;
    for (const cap of allCaptured) {
        console.log('Stage: ' + cap.stage);
        if (!cap.prompt) {
            console.error('  FAIL: no systemPrompt captured for stage ' + cap.stage);
            anyFail = true;
            continue;
        }
        // Log a short preview of the prompt
        const preview = cap.prompt.length > 80
            ? cap.prompt.substring(0, 80) + '...(' + cap.prompt.length + ' chars total)'
            : cap.prompt;
        console.log('  prompt preview: ' + JSON.stringify(preview));
        for (const probe of PROBE_SUBSTRINGS) {
            const present = cap.prompt.includes(probe.text);
            if (!present) {
                console.error('  FAIL: missing "' + probe.label + '" in ' + cap.stage + ' prompt');
                anyFail = true;
            } else {
                console.log('  ok: ' + probe.label + ' present');
            }
        }
        // Also verify the canonical string is in there (single source of truth).
        if (!cap.prompt.includes(AGENT_PRINCIPLES_CONTRACT)) {
            console.error('  FAIL: full AGENT_PRINCIPLES_CONTRACT not present in ' + cap.stage + ' prompt');
            anyFail = true;
        } else {
            console.log('  ok: full AGENT_PRINCIPLES_CONTRACT present (canonical string match)');
        }
        console.log('');
    }

    if (anyFail) {
        console.error('=== RESULT: FAIL — principles not present in all prompts ===');
        process.exitCode = 1;
    } else {
        console.log('=== RESULT: PASS — all ' + allCaptured.length + ' captured prompts contain AGENT_PRINCIPLES_CONTRACT ===');
    }
}

main().catch((err) => {
    console.error('verify-principles: uncaught error:', err);
    process.exit(2);
});
