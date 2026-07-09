# Kovix — Live Demo Script

> A literal, step-by-step script for demoing Kovix live. Follow it in order. Each step
> has an **Action** (what to do), an **Expected** (what should appear), and a **Timing**
> (how long it takes). Total runtime: ~8-15 minutes depending on LLM latency.

The demo idea: **"Create a Node.js project with a hello world script and a README."** It
is deliberately small. The point is to show all six stages of the Build mode flow in
~10 minutes, not to produce a deep codebase. The agent will scaffold a `package.json`,
write a `hello.js` that prints "Hello, world!", and write a short `README.md`. You can
verify everything on disk at the end.

---

## Pre-demo checklist (5 minutes before you start)

Run through this before the audience is watching. Each item has a fallback if it fails.

- [ ] **Provider is configured.** Run `npm start`, click the gear icon, confirm the
  provider dropdown shows your provider (e.g. "Anthropic Claude"), the API key field
  shows `••••••••` (masked), and the model field shows your model. If not, see the
  Quick Start section of `README.md` and configure it now. **Fallback**: if the key is
  rejected, switch to a backup provider (Ollama local if you have it running, or a
  second cloud key).
- [ ] **Test connection succeeds.** In the settings modal, click **Test connection**.
  You should see a green "OK" result within ~5 seconds. **Fallback**: if it fails, check
  the error message — most common causes are an expired key, a typo'd model ID, or
  network egress blocking. Fix before demoing.
- [ ] **`npm install` is done.** `node_modules/` should exist. **Fallback**: run
  `npm install` in a separate terminal while you talk.
- [ ] **Terminal is open** in the repo root. You'll need it to launch Kovix and to
  inspect the build directory at the end.
- [ ] **Window is wide enough.** The Build-mode UI is centered at max-width 720px; a
  window ~1100px wide gives comfortable margins. The stage indicator at the top should
  be fully visible.
- [ ] **No other Kovix windows are open.** Kovix uses a single in-memory session; a
  second window would share state and confuse the demo. Close any extras.
- [ ] **Optional but recommended: a second monitor** with a terminal for the disk
  inspection at the end. Lets you keep Kovix fullscreen on the main monitor.

If any of these fail and you cannot fix them in 2 minutes, **demo in DEMO_MODE instead**
(see Troubleshooting below). It returns deterministic fake data with no LLM calls —
useful for showing the UI flow when the LLM is misbehaving.

---

## Step 1 — Launch Kovix (10 seconds)

- **Action**: In your terminal, run:
  ```bash
  npm start
  ```
- **Expected**: The window opens on the **Idea** screen. The heading reads "What do you
  want to build?" with a subtitle "Describe your idea in a sentence or two. Kovix will
  refine it with you into a clear spec." Below the heading is a card with a textarea
  labeled "Your idea" and a disabled **Start refinement** button. Underneath are three
  example-idea chips ("file watcher CLI", "markdown journal", "echo server"). The
  topbar shows the Kovix brand on the left and a provider chip + gear icon on the right.
  The provider chip should read e.g. "Anthropic Claude · claude-sonnet-4-20250514".
- **Timing**: ~5 seconds for the bundle build (esbuild), ~3 seconds for Electron to
  paint. If the window takes more than 15 seconds to appear, something is wrong — check
  the terminal output for build errors.

---

## Step 2 — Type the idea (15 seconds)

- **Action**: Click in the textarea and type:
  ```
  Create a Node.js project with a hello world script and a README
  ```
  Then click the **Start refinement** button (it enables as soon as you type).
- **Expected**: The screen transitions to **Refining**. The idea you typed appears in a
  grey banner at the top ("Your idea: Create a Node.js project..."). Below the banner,
  an empty conversation area appears with a single assistant bubble containing the first
  clarifying question (it streams in token-by-token). At the bottom, a sticky answer box
  with a textarea and a **Send** button.
- **Timing**: The first question takes ~10-20 seconds to arrive (one LLM round-trip).
  You'll see the question stream in character-by-character.

**What to point out while the audience waits**: The stage indicator at the top now shows
the second dot highlighted (Refine). The first dot (Idea) is green. Mention that the
LLM is constrained to ask **exactly one question per turn** — this is enforced both in
the system prompt and by a server-side check, so it can't dump a list of questions on
you.

---

## Step 3 — Refinement loop (1-3 minutes)

The LLM will ask 3-5 questions. Answer each briefly. Suggested answers (tailor to the
actual questions, but keep them short):

- **Q**: "Should the hello world script use CommonJS or ES modules?"
  - **A**: "ES modules. Use `import` syntax and add `"type": "module"` to package.json."
- **Q**: "Should the script print to stdout or write to a file?"
  - **A**: "Stdout. Just `console.log('Hello, world!')`."
- **Q**: "What should the README cover?"
  - **A**: "Project name, what it does, how to run it with `node hello.js`."
- **Q**: "Should there be a start script in package.json?"
  - **A**: "Yes, `npm start` should run `node hello.js`."

- **Action**: For each question, type your answer in the bottom textarea and either
  click **Send** or press **Cmd/Ctrl+Enter**.
- **Expected**: After each answer, a new assistant bubble appears with the next question.
  Your answers appear in blue (user) bubbles; the LLM's questions appear in white
  (assistant) bubbles. The current question is highlighted with a blue ring. After 3-5
  rounds, the LLM calls the `emit_spec` tool and the screen auto-advances to **Spec
  Approval**.
- **Timing**: ~10-20 seconds per round (one LLM call). Total: 1-3 minutes for 3-5
  rounds. The service forces finalization at 5 rounds if the LLM hasn't emitted a spec
  by then.

**What to point out**: The conversation reads naturally. The LLM doesn't echo your
answers back or preface questions with "Got it" — those behaviors are explicitly
forbidden in the system prompt. If a question seems to combine two questions, that's a
bug worth noting (the server-side check should have caught it).

---

## Step 4 — Spec approval (30 seconds)

- **Action**: Review the spec. It has four sections, color-coded:
  - **must** (red) — hard requirements. Should include things like "package.json with
    `type: module`", "hello.js that prints Hello, world!", "README.md with project
    name and run instructions".
  - **should** (blue) — nice-to-haves. Maybe "npm start script".
  - **wont** (amber) — non-goals. Maybe "No tests", "No dependencies".
  - **doneCriteria** (green) — verifiable checks. Should include "Running `node hello.js`
    prints `Hello, world!` to stdout" and "README.md exists and is non-empty".
  
  You can edit any item inline (click it, type), add items (the dashed input at the
  bottom of each section), or remove items (the × button on the right). For the demo,
  leave it as-is unless something is obviously wrong.
  
  Click **Approve spec & generate plan**.
- **Expected**: A green banner appears: "Spec approved and locked. Kovix is generating a
  plan…". The spec fields become read-only (greyed out). After ~10-20 seconds, the
  screen transitions to **Plan**.
- **Timing**: ~10-20 seconds for the plan-generation LLM call.

**What to point out**: The spec is now immutable. The "approved and locked" semantics
are intentional — once you commit, the plan is generated against exactly this spec, no
drift. If you want to change something, you have to click **Start over** and re-refine.

---

## Step 5 — Plan review (30 seconds)

- **Expected**: The Plan screen shows:
  - A blue summary banner at the top (e.g. "Scaffold a Node.js ES-module project with
    a hello-world script and a README").
  - A stack of milestone cards, each with:
    - An index number (1, 2, 3, ...).
    - A name (e.g. "Scaffold project structure", "Write hello.js", "Write README.md",
      "Verify output").
    - A description (1-2 sentences).
    - A type badge: **Read** (grey), **Create** (blue), **Edit** (amber), **Run**
      (green).
    - A "major" badge if `isMajor` is true (file-creating or command-running
      milestones).
    - A "satisfies" line listing which spec requirements this milestone covers.
    - An estimated-credits number.
    - A colored left border coded by type.
- **Action**: Briefly walk through the milestones. Point out that each "satisfies" entry
  is copied verbatim from the spec, so coverage is mechanically checkable. Then click
  **Approve plan & continue**.
- **Timing**: ~30 seconds to walk through; the click is instant.

**What to point out**: For a small demo, you should see 3-5 milestones. If the plan has
only 1 or has 10+, that's worth noting as a planning-quality issue. The fallback
synthesizer (in `planningService.ts`) would produce one milestone per spec `must` item
if the LLM completely failed — you'd see "Fallback plan synthesized from spec" in the
summary.

---

## Step 6 — Pre-flight configuration (30 seconds)

- **Expected**: The Pre-flight screen shows a card with three fields:
  1. **Milestone pause mode** — a 2x2 grid of options. The default is **Stop at major
     milestones** (radio checked).
  2. **Credit limit (optional)** — a number input, default 0 (no cap).
  3. **Run verification after each milestone** — a toggle, default on.
- **Action**: For the demo, **change the pause mode to "Stop at every milestone"**.
  This is more visual — the agent will pause after each milestone, giving you a chance
  to talk through what it just did. Leave the credit limit at 0. Leave verification on.
  
  Click **Start execution**.
- **Expected**: The screen transitions to **Execute**. The topbar shows "Executing
  build" with a subtitle "The agent is working through your milestones." A thin progress
  bar appears (0% filled). Below it, the milestone cards from the plan reappear, now
  with status badges. The first milestone's badge flips to **Running** (blue).
- **Timing**: ~5 seconds for the transition. The first milestone starts running
  immediately.

**What to point out**: The pause mode you picked determines how often you'll get to
intervene. "Stop at every milestone" is the most interactive. "Full auto" would run
straight through with no pauses (good for headless verification, bad for a live demo
where you want to narrate).

---

## Step 7 — Execute, pause, resume (3-8 minutes)

This is the main event. For each milestone, the agent will:

1. Flip the milestone's status badge to **Running** (blue).
2. Stream tokens into an event log at the bottom of the milestone card (monospace,
   max-height 120px, scrolls).
3. Call tools (the log shows `tool_start: write_file`, `tool_result: write_file OK`,
   etc.).
4. When it proposes a file write, the staging layer fires an approval callback (the
   callback auto-approves in this phase — see LIMITATIONS.md). The file lands on disk in
   the per-build workspace.
5. If verification is on, after the milestone completes, the verification harness runs
   `npm test` / `npm run build` / `npm run typecheck` (whichever exists in the build's
   `package.json`). The result appears as a green "PASS" or red "FAIL" badge.
6. The milestone's status flips to **Completed** (green) and the next one starts.
7. Because you picked "Stop at every milestone," a yellow **pause banner** appears with
   **Resume** and **Skip milestone** buttons.

- **Action for each pause**: Talk through what just happened (which files were written,
  whether verification passed), then click **Resume**.
- **Expected**: Each milestone takes ~30-90 seconds (one or more LLM round-trips + tool
  calls + verification). For a 4-milestone plan with pauses, budget 3-8 minutes total.
- **Timing**: ~30-90s per milestone + ~10s per pause interaction.

**What to point out**:
- The **progress bar** at the top fills as milestones complete.
- The **credits used** counter ticks up (it's a heuristic: chars/4 ≈ tokens; see
  LIMITATIONS.md).
- The **event log** in each card shows the agent's tool calls. You'll see `write_file`
  for `package.json`, `hello.js`, `README.md`, and possibly `run_command` for
  verification.
- The **per-build workspace** path is logged to your terminal when execution starts:
  `[kovix:exec] build workspace: /tmp/kovix-builds/build-1700000000000`. Note this path
  — you'll use it in step 8.

If the agent writes an unexpected file or does something weird, that's worth narrating
honestly: "That's not what I expected — let's see what it did." Then inspect the build
dir in step 8.

---

## Step 8 — Inspect the build on disk (1 minute)

When all milestones complete, the screen auto-advances to **Done**. The Done screen
shows a green summary banner, the build directory path (monospace, grey background), and
a **Start a new build** button.

- **Action**: In your terminal, `cd` to the build directory path shown on the Done
  screen. (It's under `os.tmpdir()/kovix-builds/build-<timestamp>/` — on Linux that's
  `/tmp/kovix-builds/...`, on macOS `/var/folders/.../kovix-builds/...`.)
  
  ```bash
  cd /tmp/kovix-builds/build-1700000000000   # use the actual path
  ls -la
  cat package.json
  cat hello.js
  node hello.js      # should print "Hello, world!"
  cat README.md
  ```
- **Expected**: You should see `package.json` (with `"type": "module"` and a `start`
  script), `hello.js` (with `console.log('Hello, world!')`), and `README.md` (with
  project name + run instructions). Running `node hello.js` prints `Hello, world!`.
- **Timing**: ~30 seconds to walk through.

**What to point out**: The files are in a **per-build workspace**, not in the Kovix repo
itself. Kovix never writes to your actual project directory in this phase — every build
gets a fresh sandbox under the OS temp dir. This is intentional: it keeps the demo
reproducible and prevents the agent from trashing your real code.

---

## Step 9 — Wrap-up (1 minute)

- **Action**: Back in the Kovix window, click **Start a new build** to show the Idea
  screen again. Or just close the window.
- **Expected**: The session resets to a fresh Idea screen. The provider settings are
  unchanged.
- **Timing**: instant.

**Things to mention in your closing remarks**:
- The six-stage flow is fixed — every build goes through it. No skipping ahead.
- The staging layer is the security boundary: the agent never writes to disk without
  going through it. (Note: in this phase the approval auto-fires; a future "manual
  approval" toggle would surface a diff view before applying.)
- Sessions are in-memory: closing the window loses the build state. Settings persist.
- 14 providers in the registry; 3 verified end-to-end (Anthropic, Ollama, OpenRouter).
  See `PROVIDERS.md`.
- The `verify:e2e` script automates exactly what you just did — useful for CI or for
  confirming a code change didn't break the flow.

---

## Troubleshooting

### The LLM hangs (no response after 60+ seconds)

The agent loop has a 60-second per-round timeout. If it fires, you'll see an error in
the terminal and the UI will show a recoverable error. **What to do**:
1. Click **Resume** if paused, or wait — the agent may retry.
2. If it's truly stuck, click **Abort execution** (red button at the bottom of the
   Execute screen). The session stays in the Execute state; you can inspect what was
   written so far.
3. Check the terminal output for the actual error (network timeout, rate limit, etc.).
4. If it's a rate limit, switch to a different provider in settings and start a new
   build.

### The API key is rejected (Test connection fails)

**What to do**:
1. In the settings modal, click **Show** next to the API key field and verify it's
   correct (no leading/trailing whitespace, no copy-paste artifacts).
2. Check the error message — Anthropic keys start with `sk-ant-`, OpenRouter with
   `sk-or-`. A 401 means the key is wrong or revoked; a 403 means the key is valid but
   lacks permission.
3. If you have a backup key, paste it, **Test connection**, **Save**.
4. If you have Ollama running locally, switch provider to "Ollama (local)" — no key
   needed.

### The agent writes unexpected files

This is rare for the demo idea (it's small enough that the LLM rarely surprises), but
can happen. **What to do**:
1. Don't panic — the files are in a per-build sandbox under `/tmp/kovix-builds/`, not in
   your real project.
2. Let the build complete (or abort it), then `cd` to the build dir and inspect what
   was actually written.
3. If the agent wrote something actively bad (e.g. tried to run a destructive command),
   that's a security-layer bug worth reporting — the workspace guard and terminal
   blocklist should have caught it. Note the command in the event log and file an issue.

### The refinement loop won't converge (5+ rounds, no spec)

The service forces finalization at 5 rounds. If you're still seeing questions after
that, something is wrong with the LLM's tool-call compliance. **What to do**:
1. Let it run — the service will accept whatever spec it eventually emits, even if
   partially filled.
2. If it loops forever (shouldn't happen, but), close the window and start fresh. The
   session is in-memory; a restart clears it.

### Demo in DEMO_MODE (fallback for when the LLM is misbehaving)

If the live LLM path is broken and you still need to show the UI flow, run:

```bash
KOVIX_DEMO=1 npm start
```

This makes the refinement and planning IPC handlers return deterministic fake data (3
canned questions, a canned spec, a canned 4-milestone plan) with no LLM calls. The
Execute stage still runs the real agent loop, so it will fail without a working
provider — but you can walk through Idea → Refine → Spec → Plan → Pre-flight without
needing a key. The fake data is clearly themed around the "file watcher CLI" demo idea,
so you may want to type that as your idea for consistency.

`DEMO_MODE` is for screenshots and UI walkthroughs, **not** a substitute for real
verification. The `verify:e2e` script is the only thing that proves the full real-LLM
path works.

### The screenshot scripts don't run

The screenshot capture scripts (`scripts/capture-screenshots.sh`,
`scripts/capture-phase2-screenshots.sh`) require `Xvfb` and a Linux environment. They
won't run on macOS or Windows. **What to do**: take screenshots manually with your OS's
screenshot tool, or skip them — they're for the docs, not the demo.

---

## Timing summary

| Step | Time | Running total |
|---|---|---|
| 1. Launch | 10s | 0:10 |
| 2. Type idea | 15s | 0:25 |
| 3. Refinement loop | 1-3 min | 1:25-3:25 |
| 4. Spec approval | 30s | 1:55-3:55 |
| 5. Plan review | 30s | 2:25-4:25 |
| 6. Pre-flight config | 30s | 2:55-4:55 |
| 7. Execute + pauses | 3-8 min | 5:55-12:55 |
| 8. Inspect disk | 1 min | 6:55-13:55 |
| 9. Wrap-up | 1 min | 7:55-14:55 |

Budget 15 minutes total to leave room for questions. If the LLM is fast, you'll finish
in 8; if it's slow, you'll use the full 15.
