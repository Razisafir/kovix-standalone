<!--
Thank you for the PR! Read CONTRIBUTING.md first.
By opening this PR you agree your contribution is licensed under
PolyForm Noncommercial 1.0.0 with the same copyright attribution as the
existing code (Copyright (c) 2025 Razisafir). If your contribution is for
a Commercial Use as defined in LICENSE section 2.3, stop and open a
"Commercial license inquiry" issue instead.
-->

## Summary

<!-- One paragraph. What does this PR change and why? -->

## Linked issue

<!-- Required for non-trivial changes. Use `Fixes #123` / `Closes #123`
to auto-close on merge. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] Documentation
- [ ] New provider implementation (follows existing stub pattern)
- [ ] Test improvement
- [ ] Other (please describe)

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and
      [LIMITATIONS.md](../LIMITATIONS.md).
- [ ] This change is NOT for a Commercial Use as defined in LICENSE
      section 2.3.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm run verify:settings` passes (if the change touches settings or
      the agent core).
- [ ] `npx tsx test/verify.ts --provider <provider> --api-key <key>`
      passes (if the change touches the agent loop, refinement, planning,
      staging, or any provider path).
- [ ] [CHANGELOG.md](../CHANGELOG.md) `## Unreleased` section updated.
- [ ] No new runtime dependencies added (the agent core is zero-dep on
      purpose).
- [ ] No API keys, real secrets, or sensitive file contents in the diff.

## Notes for reviewer

<!-- Anything non-obvious? Anything you want feedback on? -->
