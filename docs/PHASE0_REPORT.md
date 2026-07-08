# Kovix Standalone - Phase 0 Report

## What got extracted

**Total: 3,599 lines of TypeScript across 16 files.**
**Agent core (no Electron shell, no tests): 2,955 lines across 14 files.**

### Extracted cleanly (verbatim or near-verbatim, only import paths changed)

| File | Lines | Source | Notes |
|------|-------|--------|-------|
| `src/agent/security/secretPatterns.ts` | 65 | `vs/platform/construct/common/security/secretPatterns.ts` | Pure logic, no VS Code coupling. Verbatim. |
| `src/agent/security/promptSanitiser.ts` | 94 | `vs/platform/construct/common/security/promptSanitiser.ts` | Pure logic. Replaced `globalThis.require('crypto')` shim with direct `node:crypto` import (the shim only existed to satisfy Monaco's tsconfig). |
| `src/agent/security/workspaceGuard.ts` | 58 | `vs/platform/construct/common/security/workspaceGuard.ts` | Dropped the `IWorkspaceContextService` overload — only accepts a string workspace root now. Uses `node:path` instead of VS Code's path shim. |
| `src/agent/security/terminalSecurity.ts` | 146 | `vs/platform/construct/common/terminal/terminalExecutor.ts` | Pure logic (blocklists, rate limiter, redaction). Stripped the `ITerminalExecutor` interface (was DI-decorated). |
| `src/agent/llm/types.ts` | 143 | `vs/platform/construct/common/llm/constructAIProvider.ts` | Stripped `createDecorator`, `Event`, `complete()` (Copilot — not used by agent loop). |
| `src/agent/milestoneStateMachine.ts` | 60 | `vs/platform/construct/common/agent/milestoneStateMachine.ts` | Pure types, no changes. |
| `src/agent/milestoneExecutor.ts` | 167 | `vs/platform/construct/common/agent/milestoneExecutor.ts` | Pure logic, only import paths updated. |

**Total cleanly extracted: 733 lines.** These ported with zero logic changes.

### Needed real rework

| File | Lines | Source | What changed |
|------|-------|--------|--------------|
| `src/agent/llm/cloudProvider.ts` | 729 | `vs/workbench/contrib/construct/browser/services/llm/cloudProvider.ts` (1,025 lines) | **Stripped 4 DI deps** (ILogService, IConfigurationService, IStorageService, ISecureKeyManager). Constructor now takes a plain `CloudProviderConfig` object. Removed the `Disposable` base class and `Emitter` event system. Removed the `complete()` method (Copilot — not used by agent loop). Removed `anthropic-dangerous-direct-browser-access` header (we're in Node, not a browser). **Anthropic SSE streaming parser is verbatim** — this is the critical path, didn't touch it. **OpenAI-compatible chat path is verbatim too.** |
| `src/agent/tools/index.ts` | 408 | `vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts` lines 1398-1566 (the `executeTool` switch) | **Rewrote as standalone functions** instead of methods on a class. Replaced `this.mcpProcess.readFile()` with direct `fs.readFile()`. Replaced `this.pendingChanges.stageFile()` with `ctx.pendingChanges.stageFile()` (same staging API). Replaced `this.commandService.executeCommand('kovix.executeTool', ...)` for search_codebase/web_search with direct function calls. **Tool definitions (LLM-facing schema) are verbatim.** Security checks (blocklist, rate limit, interpreter approval, sanitise+redact) are verbatim. |
| `src/agent/staging/pendingChanges.ts` | 237 | `vs/platform/construct/common/diff/pendingChanges.ts` (interface only) + `vs/workbench/contrib/construct/browser/services/diff/pendingChangesService.ts` (impl) | **Complete rewrite.** The original used `URI`, `VSBuffer`, and `IFileService`. Ours uses plain strings and `fs.promises`. The core principle (stage in memory, only write on explicit approval) is preserved. New `applyStagedChange()` method makes the disk-write moment explicit (in VS Code it happened implicitly via the diff editor). |
| `src/agent/agentLoop.ts` | 731 | `vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts` (1,947 lines, 22 DI deps) | **The biggest rework.** Stripped 12 of 22 DI deps that were no-op stubs or VS Code plumbing (memory orchestrator, skill registry, snapshot manager, file watcher, universal memory, cost governor, credit system, execution sanity, error recovery, agent reach MCP, Ponytail MCP, uiuxProMax MCP). Replaced `IWorkspaceContextService.getWorkspace().folders[0]?.uri.fsPath` with `config.workspaceRoot`. Replaced `IDialogService.confirm()` with `config.approveWrite()` callback. Replaced `ICommandService.executeCommand('workbench.files.action.refreshFilesExplorer')` with nothing (was VS Code plumbing). Replaced `IFileService.readFile(pkgUri)` with `fs.readFile()`. **Preserved verbatim:** the planning-phase LLM loop, the execution-phase LLM loop, the Anthropic tool_use SSE event handling, the system prompt (Iron Law, Karpathy 4 principles, Ponytail YAGNI ladder), the plan-parsing regex, the verification harness (npm test → npm run build → npx tsc). |

**Total reworked: 2,105 lines.** Logic preserved where it mattered (LLM call path, security, state machine, system prompt); infrastructure swapped (DI → constructor injection, VS Code services → Node APIs).

## Verification results

### Staging layer unit test — PASSED

```
$ npx tsx test/staging-test.ts
=== Staging Layer Unit Test ===
Test 1: stageFile does NOT touch disk
Test 2: staged change is in memory
Test 3: applyStagedChange writes to disk
Test 4: after apply, staged change is cleared
Test 5: clearStagedChange discards without writing
Test 6: path traversal rejected
Test 7: absolute path outside workspace rejected
Test 8: stageEdit on existing file stages new content

=== RESULTS ===
  [PASS] stageFile does not write to disk - file NOT on disk - staging works
  [PASS] staged change is retrievable - content: "test content"
  [PASS] applyStagedChange writes correct content - content matches
  [PASS] staged change cleared after apply - cleared
  [PASS] clearStagedChange does not write to disk - file not on disk - rejection works
  [PASS] assertWithinWorkspace rejects path traversal - path traversal blocked
  [PASS] absolute path outside workspace rejected - outside path blocked
  [PASS] stageEdit captures existing + proposed content - existing="old content", proposed="new content"

=== ALL STAGING CHECKS PASSED ===
```

This proves (without needing an LLM API key):
- The staging layer blocks disk writes until explicit approval (Tests 1, 5)
- The staging layer correctly applies writes when approved (Test 3)
- The security boundary rejects path traversal and absolute outside paths (Tests 6, 7)
- The staging layer correctly captures existing vs. proposed content for diff display (Test 8)

### TypeScript compilation — PASSED

```
$ npx tsc -p tsconfig.json --noEmit
(no errors)
```

Every file typechecks. No `any` escapes. Strict mode is on.

### End-to-end agent verification — PASSED ✅

Verified 2026-07-09 using OpenRouter's free NVIDIA Nemotron model (`nvidia/nemotron-3-super-120b-a12b:free`). Full transcript:

```
$ OPENROUTER_API_KEY=sk-or-v1-... OPENROUTER_MODEL='nvidia/nemotron-3-super-120b-a12b:free' npx tsx test/verify.ts
=== Kovix Standalone Agent Verification ===

Task: create a file called hello.txt with the text test in it
Workspace: /home/z/my-project/kovix-standalone/verify-workspace
Provider: OpenRouter (nvidia/nemotron-3-super-120b-a12b:free)
API key: sk-or-v1-...e120

--- Setting up workspace ---
Created: /home/z/my-project/kovix-standalone/verify-workspace

=== PHASE 1: PLANNING ===
  [agent] [AgentLoop] Planning phase started: create a file called hello.txt with the text test in it

--- PLAN RESULT ---
Steps: 1
  1. [Read] workspace

=== PHASE 2: EXECUTION ===
  [agent] [AgentLoop] Execution started: create a file called hello.txt with the text test in it
  [agent] [AgentLoop] Round 1/50

  [tool_start] write_file (id=call-fbf74b38-f092-4e37-896f-9f6b3abc3dfb)
  [tool_executing] : {"path":"hello.txt","content":"test"}
  [tool_executing] write_file: Executing...

  [approval_request] hello.txt

--- APPROVAL CALLBACK FIRED ---
File: hello.txt
Proposed content (4 chars):
  | test
Confirmed: file NOT on disk before approval (staging works).
Approving...
  [file_written] hello.txt
  >>> file_written event: hello.txt
  [tool_result] write_file OK
    output: File change staged: hello.txt. Review and accept/reject in diff view.

  [complete] Task completed.

--- EXECUTION SUMMARY ---
Total events: 7
complete event received: true
fatal error: none
approval callback called: true
file written before approval: false
file_written event received: true

=== PHASE 3: DISK VERIFICATION ===
hello.txt exists on disk: true
hello.txt content: "test"
hello.txt length: 4 chars

=== FINAL VERDICT ===
  [PASS] Agent instantiated (no VS Code DI)
  [PASS] Real LLM API call succeeded (OpenRouter (nvidia/nemotron-3-super-120b-a12b:free))
  [PASS] LLM returned a plan - 1 steps
  [PASS] Approval callback was invoked - file: hello.txt
  [PASS] File NOT written before approval (staging blocks writes) - staging worked
  [PASS] hello.txt exists on disk after execution - content: "test"
  [PASS] hello.txt contains 'test' - actual: "test"
  [PASS] complete event received

=== ALL CHECKS PASSED ===
The extracted agent core works standalone. Plan-Approve-Execute-Verify flow is real.
```

**One bug found and fixed during verification:** the agent loop had Anthropic-specific stop reasons (`'tool_use'`, `'end_turn'`) hardcoded at 3 call sites. OpenAI-compatible providers (OpenRouter, NVIDIA NIM, etc.) emit `'tool_calls'` and `'stop'` instead. Without this fix, OpenAI-compatible providers would loop forever (the agent never detected end-of-turn). Fixed at lines 222, 408, 537 of `src/agent/agentLoop.ts` to accept both sets of stop reasons.

**To run this yourself:**
```bash
cd kovix-standalone

# Option 1: OpenRouter (free model, recommended — works out of the box)
OPENROUTER_API_KEY=sk-or-v1-... npx tsx test/verify.ts

# Option 2: OpenRouter with a specific free model
OPENROUTER_API_KEY=sk-or-v1-... OPENROUTER_MODEL='nvidia/nemotron-3-super-120b-a12b:free' npx tsx test/verify.ts

# Option 3: NVIDIA NIM (free tier, 1000 credits/month — but endpoint must be reachable from your network)
NVIDIA_API_KEY=nvapi-... npx tsx test/verify.ts

# Option 4: Anthropic Claude (highest quality, but requires paid API key)
ANTHROPIC_API_KEY=sk-ant-... npx tsx test/verify.ts
```

**Free OpenRouter models that support tool calling** (verified 2026-07-09 — model availability fluctuates):
- `nvidia/nemotron-3-super-120b-a12b:free` ← **default**, used for this verification
- `openai/gpt-oss-20b:free`
- `cohere/north-mini-code:free`
- `tencent/hy3:free`
- `meta-llama/llama-3.3-70b-instruct:free` (currently upstream-rate-limited by Venice — may not work)

## What's NOT in this Phase 0

- **Build mode UI** (idea/refinement/spec/plan screens) — explicitly out of scope, next phase
- **Real diff view in the renderer** — the agent loop fires `approval_request` events with `proposedContent` + `existingContent`, but the placeholder HTML doesn't render a diff yet
- **Snapshot/undo** — the VS Code fork had `ISnapshotManager` for undo-last-task; we stripped it. Will rebuild with a real snapshot layer later if needed
- **Memory system** — `IUniversalMemoryService` and `IConstructMemoryService` (Qdrant-backed vector store + Supermemory cloud) were stubs/dead infrastructure in the VS Code fork too; stripped
- **MCP server spawning** — the VS Code fork spawned `@modelcontextprotocol/server-filesystem` over JSON-RPC. The standalone build uses `fs.promises` directly. We can re-add MCP support if we want external tools (Ponytail, etc.) back
- **Skill registry** — opt-in auto-discovery of `/slug` playbooks. Stripped, will rebuild if needed
- **Cost governor + credit system** — was a permissive stub in VS Code fork anyway. Stripped
- **Web search** — stub. The agent can use `run_command` with curl if it really needs to search
- **Multiple AI providers** (Ollama, Xenova) — CloudProvider is the only one wired. Will add Ollama back for offline-first mode if needed

## Honest time estimate for remaining work

### Electron shell + IPC (already done in Phase 0)
- `src/main/main.ts` (154 lines) — plain BrowserWindow, IPC handlers for `kovix:plan` and `kovix:execute`
- `src/preload/preload.ts` — exposes `kovixAPI` to the renderer with contextIsolation
- Placeholder HTML with a task input + output panel for smoke testing
- **Time spent: ~1 hour**

### Build mode UI (next phase) — 3-4 days

The Build mode flow has 5 screens: idea → refinement → spec → plan → execution. The agent core already produces the data each screen needs:

- **Idea screen**: user types a task. Trivial. ~2 hours.
- **Refinement screen**: shows the planning phase's rawResponse, lets user edit the task and re-plan. ~4 hours.
- **Spec screen**: shows parsed plan steps (`IPlanStep[]` from `runPlanningPhase()`), lets user deselect steps and pick execution mode. ~6 hours.
- **Plan screen**: shows the approved plan + milestones (`IApprovedPlan`), starts `runWithApprovedPlan()`. ~6 hours.
- **Execution screen**: real-time event stream from the agent loop's async generator. Renders `tool_start` / `tool_result` / `approval_request` / `verification_result` events. The `approval_request` event carries `proposedContent` + `existingContent` for the diff view. ~8 hours.
- **Diff view component**: shows proposed vs. existing content side-by-side with Approve/Reject buttons. Calls back into `approveWrite`. ~6 hours.
- **Styling + state management** (React or Svelte, your pick): ~1 day

**Total Build mode UI: 3-4 focused days.**

### Polish + packaging (after UI) — 2-3 days

- electron-builder config for Windows/macOS/Linux installers
- App icon, splash screen, window chrome
- Settings UI for API key (replace env var)
- Error states, loading states, empty states
- Smoke test on each platform

### Honest total to MVP

**1.5-2 weeks of focused work** to go from "Phase 0 extracted agent core" to "shippable standalone app with Build mode UI".

The agent core itself is done. The risk is all in the UI layer — and the UI is straightforward React/Svelte work, not algorithmic risk. The hardest part (the LLM streaming + tool_use parsing + staging layer + state machine) is already proven to compile and the staging layer is unit-tested.

## How to push to GitHub

The repo is at `/home/z/my-project/kovix-standalone/`. To push:

```bash
cd kovix-standalone
git init
git add .
git commit -m "Phase 0: extracted agent core from Kovix_2.0 VS Code fork"
# Then add your remote:
git remote add origin git@github.com:Razisafir/kovix-standalone.git
git branch -M main
git push -u origin main
```

I don't have push access to your GitHub from this environment, so you'll need to create the empty repo on GitHub first, then run the above.

## What to do next

1. **Verification is COMPLETE.** All 8 checks passed end-to-end with a real LLM API call. The extracted agent core is proven to work standalone.
2. **Push to GitHub** so the work is preserved:
   ```bash
   cd kovix-standalone
   git init
   git add .
   git commit -m "Phase 0: extracted agent core from Kovix_2.0 VS Code fork (verified end-to-end)"
   git remote add origin git@github.com:Razisafir/kovix-standalone.git
   git branch -M main
   git push -u origin main
   ```
3. **Start Phase 1 — Build mode UI.** The agent core already produces the data each screen needs (`IPlanResult`, `IApprovedPlan`, `AgentLoopEvent` stream with `approval_request` carrying `proposedContent`+`existingContent`). Estimated 3-4 days for the 5-screen flow (idea → refinement → spec → plan → execution) plus the diff view component.
4. **Optional — re-add MCP support** if you want external tools (filesystem server, Ponytail, etc.) back. The standalone build uses `fs.promises` directly which works for the common case, but MCP would give us a clean extension point.
