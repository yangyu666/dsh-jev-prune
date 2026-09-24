# Contributing

Thanks for improving `dsh-jev-prune`. The repository targets a pre-release DSH runtime, so small host-shape assumptions can have large effects. Keep changes narrow and make those assumptions testable.

## Start from current `main`

```bash
git fetch origin
git switch main
git pull --ff-only
git switch -c <type>/<short-name>
npm ci
```

Do not build a PR on an older feature branch. DSH-facing fixes often touch the same hook and event-shape code, and stale branches caused earlier contributions to conflict after review.

## Validate changes

Run the checks that match CI:

```bash
npm run check
npm run smoke
npm run coverage
```

- `check.js` covers pure helpers and safety invariants.
- `smoke_apply.mjs` runs the real `apply()` wiring against DSH-shaped fakes.
- Coverage is measured for `jev.js`, `prune.js`, `receipt.js`, and `state.js`; CI enforces minimum line, branch, and function coverage.
- CI runs the unit suite on Ubuntu and Windows with Node 22 and 24. The integration job uses the locked DSH 0.1.5-rc.2 fixture.

When changing a host assumption, also run `jev_probe_shapes` in a real DSH session when possible and include the observed shape in the PR description without secrets or full session content.

## Pull requests

Keep one coherent concern per PR. Explain the concrete failure trigger, the new behaviour, and the validation performed. Update README/configuration tables when defaults or user-visible behaviour change.

Before opening a PR:

- Rebase or merge the latest `main` and resolve conflicts locally.
- Add a regression that fails for the old implementation for behavioural fixes.
- Preserve tool-call pairing, recent-node protection, evidence guards, and fallback behaviour.
- Confirm every unit-matrix, coverage, and integration check passes.
- Link the issue with `Fixes #N` only when the PR fully resolves it; use `Refs #N` for partial work.

## Reporting issues

Use the issue templates and include the DSH version, Node version, relevant plugin configuration, and a redacted status/heartbeat excerpt. Never post API keys or complete private session logs.
