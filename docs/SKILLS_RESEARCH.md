# SKILLS_RESEARCH — obra/superpowers pattern analysis for Kovix

**Date:** 2026-07-10
**Source:** [github.com/obra/superpowers](https://github.com/obra/superpowers) (MIT, Jesse Vincent)
**Method:** Read-only fetch of raw skill files. No code cloned, downloaded, or executed.

---

## What superpowers is

A collection of Markdown "skills" + a bootstrap instruction injected into a coding agent's context (Claude Code, Cursor, Codex, etc.). **Not a runtime framework** — it is prompt engineering packaged as composable skills that auto-trigger via a session-start hook.

Its pipeline maps almost 1:1 onto Kovix's:

| Superpowers stage | Kovix equivalent |
|---|---|
| brainstorming | refinementService (idea → spec) |
| writing-plans | planningService (spec → milestones) |
| executing-plans / subagent-driven-development | kovix:exec:start + AgentLoop |
| requesting-code-review | (Kovix does not have this yet) |
| finishing-a-development-branch | (not applicable — Kovix writes to a workspace, not git branches) |

---

## Patterns worth adapting

### 1. Spec self-review checklist (HIGHEST LEVERAGE)

Before handing the spec to the user, the agent runs an inline self-critique pass:

1. **Placeholder scan** — any "TBD", "TODO", or vague requirements? Fix them.
2. **Internal consistency** — do any sections contradict each other?
3. **Scope check** — is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check** — could any requirement be interpreted two ways? If so, pick one and make it explicit.

**Adaptation cost:** Low — add a self-review stage to `refinementService` before returning the spec. The current `emit_spec` tool call returns immediately; we could add a second LLM call that reviews the spec against these 4 checks and revises before returning to the UI.

### 2. Consumes/Produces interfaces between milestones

Each milestone in the plan declares:

```
**Consumes:** [what this milestone uses from earlier milestones — exact signatures]
**Produces:** [what later milestones rely on — exact function names, parameter and return types]
```

This makes milestones independently verifiable — a milestone's success can be checked against its Produces contract without re-reading the whole plan.

**Adaptation cost:** Medium — restructure `planningService` milestone output to include `consumes` and `produces` fields. The current `PlanMilestone` type has `satisfies` (which spec requirement it addresses) but not inter-milestone contracts.

### 3. Global Constraints block in the plan

A shared constraints section that every milestone implicitly inherits:

```
## Global Constraints
- Node >= 20.0.0
- No new dependencies without explicit approval
- All files must be written to the workspace root, not absolute paths
```

**Adaptation cost:** Medium — add a `globalConstraints` field to `PlanResult` and have the agent's system prompt reference it during execution.

### 4. "No Placeholders" anti-pattern list

The plan self-review rejects:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases" (without specifics)
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the executor may read tasks out of order)
- Steps that describe *what* to do without showing *how* (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

**Adaptation cost:** Low — add a validation pass to `planningService` that rejects plans containing these anti-patterns and retries.

### 5. Status-code protocol for execution

Implementers report exactly one of:

- `DONE` — task complete, all tests pass
- `DONE_WITH_CONCERNS` — complete but with caveats the controller should review
- `BLOCKED` — cannot proceed; controller must assess and either provide more context, re-dispatch with a more capable model, split the task, or escalate to the human
- `NEEDS_CONTEXT` — missing information to proceed

Handler rules:
- **BLOCKED** → never force the same model to retry without changes. Either provide more context, upgrade the model, split the task, or escalate.
- **DONE_WITH_CONCERNS** → read concerns; address correctness/scope before moving to review.

**Adaptation cost:** Low — add a `status` field to the milestone execution result and a handler in the execution loop. Currently Kovix uses `pending | running | paused | completed | skipped | failed` — the superpowers protocol is more granular about *why* something failed.

### 6. Two-stage review (spec-compliance vs code-quality)

Separate reviews:
1. **Spec compliance** — did you build the right thing? (missing/extra/misunderstood features vs the spec)
2. **Code quality** — did you build it well? (style, maintainability, correctness of implementation)

The reviewer is explicitly told: *"Treat the implementer's report as unverified claims about the code. It may be incomplete, inaccurate, or optimistic. A stated rationale never downgrades a finding's severity."*

**Adaptation cost:** Medium — Kovix doesn't have a review step currently. Could add a post-execution review pass that checks the build output against the spec's `doneCriteria`.

### 7. "It's OK to stop" escalation culture

From the implementer prompt: *"It is always OK to stop and say 'this is too hard for me.' Bad work is worse than no work. You will not be penalized for escalating."*

**Adaptation cost:** Low — add this to the AgentLoop's system prompt. Reduces silent low-quality output.

### 8. Durable progress ledger

*"Conversation memory does not survive compaction. Controllers that lost their place have re-dispatched entire completed task sequences — the single most expensive failure observed. Track progress in a ledger file, not only in todos."*

**Adaptation status:** Kovix already persists session state via `sessionStore.ts` (in-memory only). The lesson here is that for long-running autonomous execution, the progress state should be **disk-persisted** so a crash or restart doesn't lose place. Currently if Electron crashes mid-execution, the session is lost.

**Adaptation cost:** Low-Medium — add disk persistence for the execution state (not just the session).

### 9. Artifacts-as-files (pass paths, not pasted strings)

*"Everything you paste into a dispatch prompt stays resident in your context. Hand artifacts over as files."*

**Adaptation for Kovix:** When the execution agent needs the spec or plan, it should read them from files in the workspace rather than having them pasted into the prompt. Currently Kovix passes the spec inline to `planningService` — this is fine for now (specs are short) but would matter for large plans.

---

## Patterns NOT worth adapting

### Subagent dispatch triad (controller/implementer/reviewer)

The full isolated-subagent-per-task model assumes the host can spawn isolated LLM contexts with their own conversation history and model selection. Kovix is provider-agnostic and IPC-based — it doesn't control subagent dispatch. The **prompt patterns** from this (two-stage review, status codes, "don't trust the report") are worth adapting, but the **dispatch mechanics** are not.

### Auto-trigger bootstrap ("1% chance → must invoke")

Superpowers uses dynamic skill routing where the agent decides which skill to invoke based on context. Kovix has explicit stage transitions (idea → refine → spec → plan → preflight → execute → done) controlled by the UI, not by the agent. This is a deliberate design choice — the user drives the flow, not the LLM.

### Freeform spec format

Superpowers uses freeform Markdown for specs (no must/should/wont). Kovix's structured `RefinementSpec` (must/should/wont/doneCriteria) is **better** for this use case because it's machine-parseable and maps directly to milestone `satisfies` fields. Don't downgrade to freeform.

---

## What superpowers does NOT give Kovix

1. **Credit / effort estimation.** Superpowers sizes tasks by "2-5 minutes" and picks model tiers, but never budgets credits upfront. Kovix's `estimatedCredits` field on milestones is already ahead here.

2. **Retry / backoff engine.** Superpowers handles errors via the status-code protocol ("change something before retrying"), not exponential backoff. Kovix's providers (Ollama, CloudProvider) already have their own retry logic — don't replace it.

3. **Rigid spec schema.** Superpowers uses freeform Markdown. Kovix's structured spec is better for automated plan generation.

---

## Key prompt-engineering insight

From `writing-skills/SKILL.md` (the most transferable single insight):

> *"Testing revealed that when a description summarizes the skill's workflow, an agent may follow the description instead of reading the full skill content. A description saying 'code review between tasks' caused an agent to do ONE review, even though the skill's flowchart clearly showed TWO reviews. When the description was changed to just 'Use when executing implementation plans with independent tasks' (no workflow summary), the agent correctly read the flowchart."*

**Lesson for Kovix:** When writing system prompts for `refinementService` and `planningService`, describe **when** to do things, not **how**. If the prompt over-describes the workflow, the LLM may shortcut it. Keep the "how" in the step-by-step instructions and the "when" in the role description.

---

## Recommended next steps (prioritized)

1. **Add spec self-review to `refinementService`** — cheapest, highest quality ROI. After `emit_spec` is called, run a second LLM pass with the 4-check checklist and revise before returning to the UI.

2. **Add "No Placeholders" validation to `planningService`** — reject plans containing TBD/TODO/vague-language and retry. Low cost, catches a real failure mode.

3. **Add `consumes`/`produces` to `PlanMilestone`** — makes milestones independently verifiable and gives the execution agent clearer contracts.

4. **Add `DONE_WITH_CONCERNS` status to execution** — more granular than current `completed`/`failed`. Lets the UI surface "this finished but had issues" without a hard failure.

5. **Add "It's OK to stop" to the AgentLoop system prompt** — one line, reduces silent low-quality output.

6. **Disk-persist execution progress** — so a crash mid-execution doesn't lose place. Currently the session is in-memory only.
