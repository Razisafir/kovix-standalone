# Contributing to Kovix

Thanks for your interest in contributing to Kovix. This guide is short on
purpose — Kovix is small and we want to keep it that way.

## License implications for contributors

Kovix is licensed under **PolyForm Noncommercial 1.0.0** — see
[LICENSE](./LICENSE). By opening a pull request you agree that:

- Your contribution will be licensed under PolyForm Noncommercial 1.0.0, with
  the same copyright attribution as the existing code (`Copyright (c) 2025
  Razisafir`).
- You have the right to license your contribution under those terms, and your
  contribution is not encumbered by a more restrictive license (e.g. an
  employer's proprietary code, GPL-licensed code, or code you don't have the
  rights to).
- Your contribution is not for a Commercial Use as defined in Section 2.3 of
  the LICENSE. If you're being paid to contribute, or your contribution is
  part of a commercial product, stop and open a `Commercial license inquiry`
  issue first.

We will not accept contributions that ask to relicense the project under a
more permissive license (MIT, Apache 2.0, etc.) or that introduce a
commercial feature.

## Before you start

1. **Read [LIMITATIONS.md](./LIMITATIONS.md).** If your contribution is for
   something already documented as a known limitation, open an issue first
   — don't just send a PR. Some limitations are intentional (e.g. no swarm
   mode, no manual-approval diff view) and a PR for them will be declined.
2. **Open an issue** for anything beyond a bugfix or doc improvement. Use the
   issue template, describe the problem and the proposed approach, and wait
   for a `accepted` label before starting work. PRs without a linked issue
   for non-trivial changes will be asked to open one.
3. **Check existing issues and PRs** (open and closed) to make sure you're
   not duplicating work.

## Local setup

```bash
git clone https://github.com/Razisafir/kovix-standalone.git
cd kovix-standalone
npm install
npm run typecheck   # should pass with zero errors
npm start           # opens the Electron window on the Idea screen
```

See [README.md](./README.md) for first-run setup (provider configuration,
API key storage, etc.).

## Workflow

1. Branch from `main`:
   ```bash
   git checkout -b fix/<short-description>     # for bug fixes
   git checkout -b docs/<short-description>    # for doc-only changes
   git checkout -b feat/<short-description>    # for accepted features only
   ```
2. Make your changes. Keep commits focused; one logical change per commit.
3. **Run the verification scripts.** At minimum:
   ```bash
   npm run typecheck
   npm run verify:settings     # requires a configured provider in the UI
   ```
   If your change touches the agent loop, refinement, planning, staging, or
   any provider path, also run:
   ```bash
   npx tsx test/verify.ts --provider <provider> --api-key <key>
   npm run verify:e2e          # if you have an Anthropic key configured
   ```
4. Update [CHANGELOG.md](./CHANGELOG.md) under the `## Unreleased` section.
5. Push and open a pull request against `main`. Use the PR template.
6. Respond to review feedback. Be patient — reviews are thorough.

## What we will and won't accept

**Will accept:**
- Bug fixes that don't change the contract.
- Doc improvements (README, LIMITATIONS, PROVIDERS, code comments).
- New provider implementations that follow the existing stub pattern.
- Performance improvements that don't sacrifice readability.
- Test improvements that increase coverage of verified paths.

**Will decline:**
- Features already documented in [LIMITATIONS.md](./LIMITATIONS.md) as
  intentionally missing.
- Commercial features (paywalls, paid SaaS integrations, telemetry-for-hire).
- Anything that lets the agent write to disk without going through the
  staging layer — see [LIMITATIONS.md](./LIMITATIONS.md#manual-approval-mode).
- Anything that logs API keys or removes secret redaction.
- Relicensing requests.
- Large unsolicited features without a prior accepted issue.

## Code style

- TypeScript strict mode (`tsconfig.json` has `"strict": true`). Don't relax
  it.
- Native ESM (`"type": "module"`). Use `import` not `require`.
- 2-space indent, single quotes for strings, no semicolons (matches the
  existing code).
- No new dependencies unless absolutely necessary. The agent core has zero
  runtime deps on purpose — keep it that way.

## Reporting issues

Use the issue templates in [.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/).
Bug reports should include:

- Kovix version (`git describe --tags` or the version in `package.json`).
- Provider and model.
- Steps to reproduce.
- Expected vs actual behavior.
- Logs (with any API keys redacted — see [SECURITY.md](./SECURITY.md)).

## Security issues

See [SECURITY.md](./SECURITY.md). Do not open a public issue for security
vulnerabilities — report them privately.
