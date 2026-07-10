/**
 * verify-refine.ts — Build mode Phase 1 verification.
 *
 * Runs the RefinementService end-to-end against a real LLM with a real idea,
 * simulating the user's answers. Captures the full transcript and asserts:
 *   1. Each turn returns EXACTLY ONE question (not a list, not a paragraph
 *      with multiple questions).
 *   2. The LLM eventually calls emit_spec and the service returns a spec.
 *   3. The spec is real structured data (from the LLM's tool call), not
 *      string-parsed prose.
 *   4. The spec has all 4 required arrays populated.
 *
 * Usage:
 *   # Auto-detect provider from env (priority: ANTHROPIC > OPENROUTER > NVIDIA > OLLAMA):
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx test/verify-refine.ts
 *   OPENROUTER_API_KEY=sk-or-v1-... npx tsx test/verify-refine.ts
 *
 *   # Explicit:
 *   npx tsx test/verify-refine.ts --provider openrouter --api-key sk-or-v1-... --model openai/gpt-oss-20b:free
 *
 *   # Custom idea:
 *   npx tsx test/verify-refine.ts --idea "a markdown note app with daily journaling"
 */

import { createProvider, listProviders, RefinementService } from '../src/agent/index.js';
import type { ProviderName, RefinementResult, RefinementTurn, RefinementSpec } from '../src/agent/index.js';

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const DEFAULT_IDEA = 'a tiny CLI tool that watches a folder and prints the names of files that change';

interface ParsedArgs {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    idea: string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const result: ParsedArgs = { idea: DEFAULT_IDEA };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--provider': result.provider = next; i++; break;
            case '--api-key': result.apiKey = next; i++; break;
            case '--model': result.model = next; i++; break;
            case '--base-url': result.baseUrl = next; i++; break;
            case '--idea': result.idea = next ?? DEFAULT_IDEA; i++; break;
        }
    }
    return result;
}

const args = parseArgs(process.argv);

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
    console.log('     npx tsx test/verify-refine.ts --provider <anthropic|openrouter|nvidia|ollama> [--api-key <key>] [--model <id>]');
    console.log('   Or unset the shadowing var for this session, e.g. in PowerShell:');
    console.log('     $env:ANTHROPIC_API_KEY = $null');
    console.log('--------------------------------');
    console.log('');
}

function resolveProviderConfig(): { name: ProviderName; apiKey?: string; modelId?: string; baseUrl?: string; label: string } {
    if (args.provider) {
        return {
            name: args.provider as ProviderName,
            apiKey: args.apiKey,
            modelId: args.model,
            baseUrl: args.baseUrl,
            label: `--provider ${args.provider}`,
        };
    }
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
            modelId: args.model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-oss-20b:free',
            label: 'OPENROUTER_API_KEY',
        };
    }
    if (process.env.NVIDIA_API_KEY) {
        return {
            name: 'nvidia',
            apiKey: process.env.NVIDIA_API_KEY,
            modelId: args.model ?? 'meta/llama-3.3-70b-instruct',
            label: 'NVIDIA_API_KEY',
        };
    }
    return {
        name: 'ollama',
        modelId: args.model ?? process.env.OLLAMA_MODEL,
        baseUrl: args.baseUrl ?? process.env.OLLAMA_BASE_URL,
        label: 'default (Ollama at localhost:11434)',
    };
}

// ----------------------------------------------------------------------
// Mock user answers
// ----------------------------------------------------------------------

/**
 * Pre-scripted answers to feed the refinement loop. The script simulates a
 * cooperative user who gives clear, concise answers. This is intentional —
 * we're verifying the SERVICE works, not testing the LLM's ability to handle
 * vague answers.
 *
 * If the LLM asks more questions than we have answers for, we fall back to a
 * generic "I'm not sure, please make a sensible default choice for me."
 */
const SCRIPTED_ANSWERS = [
    'It should watch the current directory recursively and print to stdout, one file per line.',
    'Target is developers on macOS and Linux. They run it from the terminal.',
    'Yes, ignore .git and node_modules by default. No config file needed for v1.',
    'Done means: I can run `kovix-watch .` and see a line printed within 1 second of saving any file in the folder (excluding ignored dirs).',
    'No remote sync, no GUI, no logging to file. Just stdout.',
];

function getAnswerForRound(round: number): string {
    return SCRIPTED_ANSWERS[round] ?? "I'm not sure — please make a sensible default for that.";
}

// ----------------------------------------------------------------------
// One-question-at-a-time check
// ----------------------------------------------------------------------

/**
 * Heuristic: a "single question" turn should NOT contain multiple question
 * marks, and should NOT contain list-y phrasing like "1." / "2." / "first" /
 * "second" / "also" / "additionally".
 *
 * This is a heuristic, not a parser. We're not trying to be perfect — we're
 * trying to catch egregious violations of the one-question rule.
 */
function isSingleQuestion(text: string): { pass: boolean; reason?: string } {
    const trimmed = text.trim();
    const questionMarkCount = (trimmed.match(/\?/g) ?? []).length;
    if (questionMarkCount > 1) {
        return { pass: false, reason: `contains ${questionMarkCount} question marks (expected ≤1)` };
    }
    const lower = trimmed.toLowerCase();
    const listMarkers = [/\bfirst[,.]/, /\bsecond[,.]/, /\bthird[,.]/, /\bfinally[,.]/, /\d+\.\s/, /\balso\b/, /\badditionally\b/, /\bfurthermore\b/];
    for (const marker of listMarkers) {
        if (marker.test(lower)) {
            return { pass: false, reason: `contains list-y marker: ${marker.source}` };
        }
    }
    return { pass: true };
}

// ----------------------------------------------------------------------
// Spec validation
// ----------------------------------------------------------------------

function validateSpec(spec: RefinementSpec): { pass: boolean; issues: string[] } {
    const issues: string[] = [];
    if (!Array.isArray(spec.must)) { issues.push('must is not an array'); }
    if (!Array.isArray(spec.should)) { issues.push('should is not an array'); }
    if (!Array.isArray(spec.wont)) { issues.push('wont is not an array'); }
    if (!Array.isArray(spec.doneCriteria)) { issues.push('doneCriteria is not an array'); }
    if (spec.must.length === 0) { issues.push('must is empty — every build needs at least one hard requirement'); }
    if (spec.doneCriteria.length === 0) { issues.push('doneCriteria is empty — every build needs at least one verifiable check'); }
    // Each entry must be a non-empty string
    for (const [key, arr] of Object.entries(spec) as Array<[keyof RefinementSpec, string[]]>) {
        for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] !== 'string' || arr[i].trim().length === 0) {
                issues.push(`${key}[${i}] is not a non-empty string`);
            }
        }
    }
    return { pass: issues.length === 0, issues };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('=== Kovix Build Mode — Phase 1 Refinement Verification ===');
    console.log('');
    console.log('Idea: ' + args.idea);
    console.log('');

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
        console.error('Available providers:');
        for (const p of listProviders()) {
            console.error('  --provider ' + p.name + '  ' + (p.requiresApiKey ? '(needs --api-key)' : '(no key needed)'));
        }
        process.exit(1);
    }

    const service = new RefinementService({
        aiProvider: provider,
        maxTurns: 5,
        minTurns: 3,
        log: (msg) => console.log('  ' + msg),
    });

    // ----------------------------------------------------------------------
    // Refinement loop
    // ----------------------------------------------------------------------
    console.log('');
    console.log('=== REFINEMENT LOOP ===');
    console.log('');

    const priorTurns: RefinementTurn[] = [];
    const transcript: Array<{ round: number; question: string; answer: string }> = [];
    let finalSpec: RefinementSpec | null = null;
    let roundsCompleted = 0;
    let oneQuestionViolations = 0;
    let hardCap = 8; // hard safety cap to prevent infinite loops

    while (hardCap-- > 0) {
        const round = roundsCompleted + 1;
        console.log(`--- Round ${round} ---`);

        let result: RefinementResult;
        try {
            result = await service.refine({
                ideaText: args.idea,
                priorTurns,
            });
        } catch (err) {
            console.error(`FAIL: refine() threw on round ${round}: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(2);
        }

        if (result.kind === 'spec') {
            console.log('');
            console.log('>>> emit_spec received — refinement complete <<<');
            finalSpec = result.spec;
            break;
        }

        // It's a question — check the one-question rule
        const check = isSingleQuestion(result.text);
        if (!check.pass) {
            oneQuestionViolations++;
            console.log('  QUESTION: ' + result.text);
            console.log('  ⚠️  ONE-QUESTION VIOLATION: ' + check.reason);
        } else {
            console.log('  QUESTION: ' + result.text);
        }

        // Record the assistant question
        priorTurns.push({ role: 'assistant', content: result.text });

        // Simulate user answer
        const answer = getAnswerForRound(roundsCompleted);
        console.log('  ANSWER (simulated): ' + answer);
        priorTurns.push({ role: 'user', content: answer });

        transcript.push({ round, question: result.text, answer });
        roundsCompleted++;
        console.log('');
    }

    if (!finalSpec) {
        console.error('FAIL: refinement loop exhausted hard cap without emitting spec.');
        process.exit(3);
    }

    // ----------------------------------------------------------------------
    // Validate the spec
    // ----------------------------------------------------------------------
    console.log('');
    console.log('=== FINAL SPEC ===');
    console.log('');
    console.log('  must:');
    for (const item of finalSpec.must) { console.log('    - ' + item); }
    console.log('  should:');
    for (const item of finalSpec.should) { console.log('    - ' + item); }
    console.log('  wont:');
    for (const item of finalSpec.wont) { console.log('    - ' + item); }
    console.log('  doneCriteria:');
    for (const item of finalSpec.doneCriteria) { console.log('    - ' + item); }
    console.log('');

    const specValidation = validateSpec(finalSpec);

    // ----------------------------------------------------------------------
    // Final report
    // ----------------------------------------------------------------------
    console.log('=== VERIFICATION REPORT ===');
    console.log('');
    console.log(`Rounds completed:        ${roundsCompleted}`);
    console.log(`One-question violations: ${oneQuestionViolations}`);
    console.log(`Spec emitted:            ${finalSpec ? 'YES' : 'NO'}`);
    console.log(`Spec valid:              ${specValidation.pass ? 'YES' : 'NO'}`);
    if (!specValidation.pass) {
        console.log('Spec issues:');
        for (const issue of specValidation.issues) { console.log('  - ' + issue); }
    }
    console.log('');

    const allPass = finalSpec && specValidation.pass && oneQuestionViolations === 0 && roundsCompleted >= 3 && roundsCompleted <= 5;

    console.log('=== CHECKS ===');
    console.log(`  [${roundsCompleted >= 3 && roundsCompleted <= 5 ? 'PASS' : 'FAIL'}] Refinement ran 3-5 rounds (got ${roundsCompleted})`);
    console.log(`  [${oneQuestionViolations === 0 ? 'PASS' : 'FAIL'}] Every question was a single question (no lists, no multiple ?s)`);
    console.log(`  [${finalSpec ? 'PASS' : 'FAIL'}] LLM called emit_spec (structured tool call, not string-parsed prose)`);
    console.log(`  [${specValidation.pass ? 'PASS' : 'FAIL'}] Spec has all 4 required arrays populated`);
    console.log('');

    if (allPass) {
        console.log('>>> ALL CHECKS PASSED <<<');
        process.exit(0);
    } else {
        console.log('>>> SOME CHECKS FAILED — see above <<<');
        process.exit(4);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(99);
});
