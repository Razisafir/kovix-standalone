# Security Policy

Kovix runs an autonomous agent that can read files, write files, and run
shell commands on the machine where it executes. Security is taken
seriously. This document explains the security model, the supported
versions, and how to report a vulnerability.

## Supported versions

Kovix is pre-alpha. Only the latest tagged release on `main` receives
security fixes.

| Version | Supported          |
|---------|--------------------|
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Security model (short version)

Kovix's security boundary is the **staging layer** (`src/agent/staging/
pendingChanges.ts`). Every file write the agent proposes is held in memory
until `applyStagedChange()` is called. The agent itself never writes to disk
directly. Any code change that bypasses the staging layer is a critical
regression.

The other relevant boundaries:

- **API key storage.** Keys are encrypted with Electron's `safeStorage`
  (Keychain on macOS, DPAPI on Windows, libsecret on Linux) and written to
  `app.getPath('userData')/kovix-settings.json` with mode `0600`. If
  `safeStorage` is unavailable, the store falls back to plaintext with
  `0600` permissions and logs a warning. Keys are never sent to the
  renderer, never logged, and never committed to the repository (see
  `.gitignore`).
- **Prompt sanitisation + secret redaction.** `src/agent/security/`
  contains the ported-from-VS-Code-fork redaction logic. The agent's
  system prompt is sanitised before being sent to the LLM. Don't undo
  this.
- **Tool security.** `src/agent/tools/` enforces a path blocklist, a rate
  limiter, and interpreter approval on `run_command`. Don't weaken these
  checks.
- **Workspace guard.** `src/agent/security/workspaceGuard.ts` keeps file
  operations inside the configured build workspace
  (`os.tmpdir()/kovix-builds/build-<timestamp>/`).

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.** If you
believe you have found a security issue — a way for the agent to bypass the
staging layer, write outside the build workspace, leak an API key, escape
the prompt sanitiser, or otherwise break the model above — report it
privately.

To report:

1. Open a **private** GitHub Security Advisory on the repository
   (`https://github.com/Razisafir/kovix-standalone/security/advisories/new`).
   This keeps the report private to the maintainer and to anyone you invite.
2. Include:
   - A description of the vulnerability and its impact.
   - The affected version (`git describe --tags`).
   - A minimal reproduction (steps or a script).
   - Any suggested fix you have.
3. Do not include live API keys, real secrets, or sensitive file contents
   in the report. Redact them.

You should receive an acknowledgement within 72 hours. If you do not, open
a public issue with no details saying only `private security advisory
pending — please check` and the maintainer will follow up.

## Coordinated disclosure

We ask for a 90-day window from the initial report before public disclosure.
If a fix is taking longer than expected, we will communicate that and agree
on a new date. Credit will be given in the release notes and the
[CHANGELOG.md](./CHANGELOG.md) entry unless you ask to remain anonymous.

## Out of scope

The following are not considered security vulnerabilities under this policy:

- Bugs in third-party LLM provider APIs (Anthropic, OpenAI, OpenRouter,
  Ollama, etc.). Report those to the provider.
- The 11 unverified provider stubs failing when given malformed input —
  those are documented as unverified in [PROVIDERS.md](./PROVIDERS.md).
- A user running Kovix with an LLM provider they don't trust — that's a
  user choice, not a bug.
- A user explicitly configuring a build workspace outside `os.tmpdir()` and
  then being surprised the agent wrote files there.
- Anything that requires the attacker to have already compromised the
  user's machine (e.g. they have write access to the Kovix settings file).

## Acknowledgements

Past security-relevant contributions are listed in
[CHANGELOG.md](./CHANGELOG.md). If you report a vulnerability and wish to
be credited, you will be added there.
