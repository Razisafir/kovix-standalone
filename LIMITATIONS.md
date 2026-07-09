# Kovix — Known Limitations

> Honest list of what's NOT done, what's rough, and what's intentional. Read this before
> opening an issue or PR. If something is missing here that you discovered, please file
> an issue so it can be added.

Kovix is pre-alpha. The verified paths work; everything else is here. Each entry below
explains what's missing, why it matters, and (where relevant) when it'll be addressed.

---

## Swarm mode

**Not implemented. Single agent only.**

Kovix runs one agent loop per build. There is no concept of multiple agents
collaborating on a single build, no agent-to-agent messaging, no work distribution. The
milestone executor (`src/agent/milestoneExecutor.ts`) iterates milestones sequentially
in one agent instance. The original VS Code fork had a "swarm" concept in the roadmap
but it was never implemented there either; the standalone extraction did not include it.

Why it matters: for large builds, a single agent is a serial bottleneck. Swarm mode
would let independent milestones run in parallel. This is on the post-1.0 roadmap, not
before.

---

## Provider stubs

**11 of 14 providers are interface-ready but unverified.**

The provider registry in `src/agent/llm/providerFactory.ts` (lines 69-182) lists 14
providers. As of this release:

| Status | Providers |
|---|---|
| **Verified end-to-end** | anthropic, ollama, openrouter |
| **Interface-ready, unverified** | openai, nvidia, together, groq, mistral, deepseek, gemini, lmstudio, litellm, xenova, custom |

The 11 unverified providers are thin wrappers around `CloudProvider` (in
`src/agent/llm/cloudProvider.ts`) with provider-specific defaults (baseUrl, default
model). They compile cleanly and implement the `IConstructAIProvider` interface, but
they have **not** been exercised against a real API. The stub pattern means they will
likely work, but "likely" is not "verified."

To move one from UNTESTED to VERIFIED, see [PROVIDERS.md](./PROVIDERS.md) — the process
is `npx tsx test/verify.ts --provider <name> --api-key <key>`, and if all 8 checks
pass, flip the `verified` flag in the registry.

Why it matters: a user who picks e.g. "Groq" from the settings dropdown expects it to
work. If Groq's API isn't actually OpenAI-compatible in some subtle way (tool-call
format, streaming quirks, header requirements), the build will fail mid-flow with a
confusing error. The honest position is: use Anthropic for anything that matters, use
the others experimentally.

(Note: the task brief for this doc said "13 unverified, all except Anthropic." That is
stale — `openrouter` is also verified end-to-end via free-tier models, and `ollama` is
verified at the interface level. The table above reflects the actual code state.)

---

## Packaging / installers

**No .dmg, .exe, .AppImage, .deb, or any other distributable. Must run from source.**

There is no `electron-builder` config, no `forge` config, no packaging script in
`package.json`. The only way to run Kovix is:

```bash
git clone https://github.com/Razisafir/kovix-standalone.git
cd kovix-standalone
npm install
npm start
```

The `npm start` script runs `npm run build:bundle` (esbuild of main + preload to
`dist/`) and then `electron .`. There is no production build with bundled dependencies,
no code signing, no auto-update.

Why it matters: you cannot hand Kovix to a non-developer end user yet. Distributable
installers are a 1.0 release blocker. The work involved is: pick a packager
(electron-builder is the default choice), define per-platform build config, set up code
signing certs (macOS notarization in particular is a known pain), and add CI to produce
the artifacts on tag pushes.

---

## Multi-platform builds

**Only tested on Linux headless. macOS and Windows untested.**

The development environment for this release was a Linux sandbox. The verification
scripts (`verify`, `verify:refine`, `verify:settings`, `verify:e2e`) were run
headlessly under Xvfb. The screenshot capture scripts (`scripts/capture-screenshots.sh`,
`scripts/capture-phase2-screenshots.sh`) require `Xvfb` and are Linux-only.

macOS-specific concerns:
- `safeStorage` should work (Keychain), but has not been confirmed in this release.
- The `--no-sandbox` Electron flag used in `verify:e2e` may behave differently on macOS.
- Apple's notarization requirement for distribution is not addressed (see Packaging
  above).

Windows-specific concerns:
- `safeStorage` should work (DPAPI), but has not been confirmed.
- The screenshot scripts use bash-isms that won't run on Windows without WSL.
- Path handling in `src/agent/staging/pendingChanges.ts` uses `node:path` which is
  cross-platform, but no Windows test has confirmed it.

Why it matters: a macOS or Windows user who clones the repo and runs `npm start` will
probably hit platform-specific issues (font rendering, safeStorage behavior, path
separators in edge cases). Bug reports with platform info are welcome.

---

## Credit tracking

**Heuristic, not real provider usage metadata.**

The "credits used" counter on the Execute screen is computed as
`Math.ceil(event.text.length / 4)` per token event (see `src/main/main.ts` around line
854). This is the standard "4 characters ≈ 1 token" approximation, summed across all
LLM responses in the build. It is **not** the actual token count reported by the
provider's usage metadata, and it is **not** a real cost in dollars.

The credit cap in the pre-flight config (when set to non-zero) aborts execution if this
heuristic estimate exceeds the cap. So a credit cap of 1000 will abort after roughly
4000 characters of LLM output, which is a very rough proxy for ~1000 tokens.

Why it matters: the credit counter is a relative-progress indicator, not a budget. You
cannot use it to predict your API bill. Real credit tracking would require parsing the
`usage` field from each provider's response (Anthropic returns `input_tokens` and
`output_tokens`; OpenAI-compatible providers return a `usage` object) and summing those.
The agent loop currently discards this metadata. Adding it is a moderate refactor —
the `IConstructAIProvider` interface's `AIStreamEvent` type would need a `done` event
variant carrying usage info, and every provider would need to populate it.

---

## No disk persistence for half-finished builds

**Closing the window loses session state. Settings persist.**

The `BuildSession` (defined in `src/main/sessionStore.ts`) is an in-memory object held
by the main process. It is never written to disk. If you close the Kovix window mid-
build — or if the app crashes, or if the OS kills the process — the session is gone.
Reopening the window lands you on a fresh Idea screen.

The settings (provider, model, API key) ARE persisted, via `src/main/settingsStore.ts`:
the file lives at `app.getPath('userData')/kovix-settings.json`, the key is encrypted
with safeStorage, the file mode is `0600`. So you don't have to reconfigure on restart.

Why it matters: a user who refines a complex spec, approves a plan, and then
accidentally closes the window loses all of that work. There is no "resume last build"
option. The intentional design choice (documented in `sessionStore.ts` lines 11-18) is
that adding disk persistence for half-finished builds is a separate feature with its
own UX decisions about resumption: do you re-prompt for spec approval? Do you re-run
the agent from the current milestone or the start? Do you diff the on-disk state
against the planned state? None of this is trivial. It's on the roadmap, not in this
release.

---

## Manual approval mode

**The staging layer auto-approves writes. There is no manual-approval diff view yet.**

The staging layer (`src/agent/staging/pendingChanges.ts`) holds proposed writes in
memory until `applyStagedChange()` is called. The agent loop's `approveWrite` callback
(see `src/agent/agentLoop.ts` lines 80-85) is the gate: it receives the file path,
proposed content, and existing content, and returns `true` to apply or `false` to
reject.

In this release, the `kovix:exec:start` IPC handler in `src/main/main.ts` (around line
756) wires `approveWrite` to a callback that **always returns `true`** — with a comment
explaining: *"approveWrite: true (auto-approve for now — the staging layer still FIRES
the approval_request event so the UI can show it; the actual disk write just happens
immediately. A future 'manual approval' preflight toggle would change this to a
renderer-driven callback.)"*

The `approval_request` event still fires (so the UI could show it), and the callback
still verifies that the file is NOT on disk before approval (it logs a VIOLATION if it
is — the staging layer is working correctly). But the user never sees a diff and never
gets to say "no." Writes land on disk immediately.

Why it matters: the staging layer is the security boundary, but in this phase it's a
one-way gate. A future "manual approval" preflight toggle would surface a diff view to
the user before each write, letting them reject or edit. This is a meaningful UX
addition (diff rendering, edit-in-place, batch approve/reject) and is planned for a
later phase. Until then, the agent can write anything to the per-build sandbox without
user review mid-execution. The sandbox (under `os.tmpdir()/kovix-builds/`) limits the
blast radius, but it's not the same as a human-in-the-loop gate.

---

## End-to-end verification not yet run with a real key

**The `verify:e2e` script is mechanically complete but has NOT been run with a real
Anthropic key in the sandbox where this release was prepared.**

The script (`test/verify-end-to-end.ts`) and its in-process driver
(`runEndToEndVerification` in `src/main/main.ts`, lines ~1465-1900) are complete: they
resolve the provider config from the settings store, run the real refinement loop, lock
the spec, generate the real plan, configure preflight, run the real agent loop with
real staged writes and real disk writes, run real verification, and print a 10-check
pass/fail verdict. The code path is exercised by the `verify:settings` and `verify`
scripts for their respective subsets.

However: the sandbox where this release was prepared did not have a real Anthropic API
key available (per project rules: never invent, reuse, or ask for credentials). The
full real-LLM e2e path — refinement → spec → plan → execute → verify, all with real
Claude calls — has therefore not been confirmed end-to-end in this environment.

Why it matters: there could be a regression in the e2e driver specifically (not in the
unit-verified pieces) that only surfaces when all stages run in sequence with a real
LLM. The most likely failure modes are: the e2e driver's replicated
`executeSubTask`/`runVerification` generators diverge from the production code path,
or the milestone executor's pause/resume wiring doesn't handle the auto-resume used in
headless mode. **You must run `npm run verify:e2e` locally with a configured Anthropic
key to confirm the full path works on your machine before relying on it.**

---

## Demo mode is not a substitute for real verification

**`KOVIX_DEMO=1` returns deterministic fake data without LLM calls. Useful for
screenshots; proves nothing about the real path.**

When the `KOVIX_DEMO` environment variable is set (see `src/main/main.ts` line 351),
the `kovix:refine:start`, `kovix:refine:continue`, and `kovix:plan:generate` IPC
handlers return canned data: three pre-written clarifying questions (about a file
watcher CLI), a pre-written spec, and a pre-written 4-milestone plan. No LLM is called.
The Execute stage still runs the real agent loop, so it will fail without a working
provider — but the pre-execution stages are fully faked.

This exists so the screenshot capture scripts (`scripts/capture-screenshots.sh`,
`scripts/capture-phase2-screenshots.sh`) can produce deterministic UI screenshots
without an API key. It is also useful for walking an audience through the UI flow when
the live LLM is misbehaving (see `DEMO.md` Troubleshooting).

Why it matters: a contributor who runs `KOVIX_DEMO=1 npm start`, sees the UI flow work,
and concludes "Kovix works" is wrong. Demo mode proves the UI renders and the IPC
handlers fire; it does not prove the refinement service, the planning service, the
agent loop, the staging layer, or any provider actually works. The only proof of the
real path is `npm run verify:e2e` (or `verify` / `verify:refine` / `verify:settings`
for the subsets) with a real API key. Do not conflate the two.

---

## Summary table

| Limitation | Severity | When addressed |
|---|---|---|
| Swarm mode | Feature gap | Post-1.0 roadmap |
| 11 unverified provider stubs | Quality gap | As users verify each; flip the `verified` flag |
| No installers / packaging | Release blocker for 1.0 | 1.0 release |
| macOS / Windows untested | Quality gap | Before 1.0 |
| Credit tracking is heuristic | Quality gap | Moderate refactor, post-1.0 |
| No session persistence | Feature gap | Separate phase, post-1.0 |
| No manual approval mode | Feature gap | Later phase |
| `verify:e2e` not run with real key in this sandbox | Verification gap | User must run locally |
| Demo mode misused as verification | Documentation / UX | Mitigated by this doc |
