# Changelog

All notable changes to Kovix are documented in this file. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [PolyForm Noncommercial 1.0.0](./LICENSE).

## [1.0.0] — 2025-07-10

First public release of Kovix as a standalone Electron app. The agent core
was extracted from the Kovix_2.0 VS Code extension and rewritten as a plain
TypeScript module with constructor injection instead of 22 DI dependencies.
The shell around it is brand new: one main process, one preload bridge, one
inline renderer walking the six Build-mode screens.

### Added

- **6-stage Build mode flow**: Idea → Refinement → Spec Approval → Plan →
  Pre-flight → Execute → Done. Each stage is a separate screen with a single
  primary action; you cannot skip ahead.
- **14-provider LLM registry** (`src/agent/llm/providerFactory.ts`). All
  providers implement the same `IConstructAIProvider` interface, so the
  refinement, planning, and agent-loop code is provider-agnostic.
- **Refinement service** that enforces one-question-per-turn, a minimum of
  3 turns, a hard cap of 5 turns, and rejects premature `emit_spec` calls
  (`src/agent/refinement/refinementService.ts`).
- **Planning service** that turns an approved spec into a flat ordered
  milestone list via a single `emit_plan` tool call, with server-side
  enforcement against text-only responses and empty arrays
  (`src/agent/planning/planningService.ts`).
- **Staging layer** — the security boundary. File writes are held in memory
  until `applyStagedChange()` is called (`src/agent/staging/
  pendingChanges.ts`).
- **Pause/resume milestone state machine** with four modes: stop-at-every,
  stop-at-major (default), full-auto, and custom picks
  (`src/agent/milestoneStateMachine.ts`).
- **Security layer** ported from the VS Code fork: secret patterns, prompt
  sanitiser, workspace guard, terminal security (`src/agent/security/`).
- **Settings store** with safeStorage encryption, masked preview, and
  env-var fallback (`src/main/settingsStore.ts`).
- **Lead-agent orchestration** — sequential milestone delegation with a
  lead/worker UI surface (`src/agent/leadAgent/leadAgentService.ts`).
- **AGENT_PRINCIPLES** injection — Iron Law of verification, Karpathy 4
  principles, Ponytail YAGNI ladder — into all LLM prompts
  (`src/agent/agentPrinciples.ts`, `docs/AGENT_PRINCIPLES.md`).
- **Workspace folder picker** — pick any folder as the build workspace
  instead of the default `os.tmpdir()` location.
- **Back buttons** on every Build-mode screen so you can revise a spec or
  plan after approving it (within the constraints of the immutable-spec
  contract).
- **Four verification scripts**: `npm run verify` (agent core 8-check
  end-to-end), `npm run verify:refine` (refinement loop), `npm run
  verify:settings` (settings store), `npm run verify:e2e` (full Phase 2
  flow, 10 checks).
- **PolyForm Noncommercial 1.0.0 license** — replaces the earlier MIT
  placeholder. Permits personal learning, research, teaching, and
  contributions back to this project; prohibits any commercial use.
- **Contributor guide** ([CONTRIBUTING.md](./CONTRIBUTING.md)), **security
  policy** ([SECURITY.md](./SECURITY.md)), **issue and PR templates**
  ([.github/](./.github/)), and **demo script** ([DEMO.md](./DEMO.md)).

### Verified

- **Anthropic Claude** provider path: idea → refinement → spec → plan →
  pre-flight → execute → done, with real LLM calls, real staged writes,
  real disk writes, real verification.
- **Ollama** local provider: interface-level verified (status check + chat
  path ported from the VS Code fork).
- **OpenRouter** provider: verified via free-tier models (rate-limited; see
  [PROVIDERS.md](./PROVIDERS.md)).
- **Settings store**: safeStorage encryption round-trip, masked preview,
  cleanup — driven by `npm run verify:settings`.

### Known limitations

Documented honestly in [LIMITATIONS.md](./LIMITATIONS.md). The short list:

- 11 of 14 providers are interface-ready stubs, unverified against real
  APIs.
- Sessions are in-memory only — close the window and the build state is
  gone (settings persist).
- The staging layer fires its approval event for the UI but auto-approves
  the actual disk write. No manual-approval diff view yet.
- Swarm mode is not implemented. Single agent only.
- The `verify:e2e` script is mechanically complete but has not been run
  with a real Anthropic key in the sandbox where this release was prepared.
  Run it locally to confirm the full real-LLM path on your machine.

### License

This release is the first to ship under **PolyForm Noncommercial 1.0.0**.
Earlier internal revisions carried an MIT placeholder for development
convenience; v1.0.0 is the first public, contractually-fixed release.
