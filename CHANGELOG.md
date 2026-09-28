# Changelog

## 0.1.0 — 2026-09-28

First published release. Both layers are active by default; nothing needs to be turned on.

### Layer 1 — Jev-judged result trimming

- **`budget` mode (default)**: *how much* to trim comes from the pressure-gap ratio, *which* results come from Jev's ranking; the legacy fixed threshold stays available as `keepMode: 'absolute'`
- **Result excerpts**: the judge's state carries a bounded, informativeness-picked excerpt per result (error/evidence lines → salient identifiers and assignments → middle-line fallback) instead of a blind `ok, N chars` line
- **Token-estimate constants calibrated** against a real BPE tokenizer over 22 sample classes (mean absolute error 20.5% → 10.7%; the old formula over-estimated pure English by +37% and Unix paths by +44%, tightening both gates); `npm run check` asserts accuracy against a holdout set (MAE ≤ 15%)
- **Judge retries with backoff** and per-batch isolation: a network hiccup or `429`/`5xx` retries instead of voiding the whole round; other `4xx` fails fast; one failed batch no longer discards the rest
- **Pressure gates fail closed in the same direction** for both layers (unresolvable threshold ⇒ neither acts); with an absolute-count `softLimit` the gate is simply un-armed when the meter is missing, and judging proceeds
- **Out-of-range configuration never reaches the runtime** — schema validation throws loudly, direct-injection paths fall back to defaults with `configWarnings`
- **The judge hook is prepended** ahead of the base bundle's `compaction-basic`, so `pruneSession` always consumes this round's verdicts instead of the previous round's

### Layer 2 — deterministic receipts

- **Small-population degradation**: when the read-only quantile population is too small for ordering to mean anything, the mode degrades to an absolute floor (both axes < `floorThreshold` 0.2) instead of silently doing nothing; a single sample still never acts
- **Receipt ownership token (fence)**: a concurrent compaction cannot steal the pending receipt, and a lost receipt is reported (`fenceLost`) rather than claimed as success
- **Parallel-batch support**: for a mixed batch, each eligible `tool/result` body is replaced individually through DSH's single-node `replace` protocol (envelopes and tool pairing intact); fully eligible batches use `compactRegion`
- **Blocked passes explain themselves**: the skip reason plus per-category exclusion counts land in the status report and heartbeat
- **Receipts carry the assistant's visible text verbatim** (`text` blocks only, `reasoning` drafts excluded, zero model generation; `receiptTextChars`, default 400, `0` disables) — without this, a long task could lose the model's own progress notes and stop early
- **Independent `compactPreserveRecent` recency boundary** for layer 2; an empty two-axis intersection degrades to the absolute floor; `compactQuantile: 0` is a hard off

### Meta

- Bilingual README (English / 简体中文) with measured three-arm results on a 37-step long task
- CI across 4 Node/OS matrix jobs plus coverage; smoke test ships in the package
