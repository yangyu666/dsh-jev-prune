# Porting contract

This document describes the host surface required to run `dsh-jev-prune` outside the tested DSH 0.1.5-rc.2 bundle. Start by loading the plugin and calling `jev_probe_shapes` in a disposable session. Compare the result with the assumptions below before enabling writes.

## Services

The adapter in `index.js` consumes these services:

| Service | Required behaviour |
|---|---|
| `toolResultPruner` | Exposes synchronous `pruneSession(session)`, `measureContent(blocks)`, `pruneContent(blocks)`, and a token estimator through its context. The plugin replaces `pruneSession`. |
| `compaction` | Exposes async `compactRegion(startSeq, endSeq, agent, signal)` and `summarize(input, agent, signal)`. The plugin temporarily wraps `summarize` to inject a deterministic receipt. |
| `tools` | Registers `jev_prune_status`, `jev_prune_now`, `jev_compact_now`, `jev_restore`, and `jev_probe_shapes`. Missing tools must not disable pruning. |
| `commands` | Optionally registers `/jev`. |
| `llm` | `resolveModelInfo(provider, model)` returns `context.contextWindow` for ratio pressure gates. |
| `tokenMeter` | `measure(session)` returns `totalTokens` and preferably per-node token entries. Required for ratio pressure comparisons and receipt-size checks. |

`@deepseek-ai/dsh-llm` is optional at module-load time. If its `freezeMessage` export cannot be loaded, the plugin uses a shallow-copy fallback.

## Hook semantics

The host must provide waterfall-style `agent/pre-step` hooks with `next()` chaining. Registration with the prepend flag must run the judge hook before the host's normal compaction hook; otherwise synchronous pruning sees stale verdicts.

The event payload must expose `agent`, optional `signal`, and `agent.session`. Cancellation signals are passed to judge and compaction calls.

## Session and event shape

The active session must provide:

- `surface.nodes`: ordered active seq values.
- `eventAt(seq)`: returns an event whose `event.seq` equals the requested seq.
- `deriveEventMessage(event)`: returns the DSH message represented by an event.
- `append(type, data, options)`: appends an event and applies `surfaceOp`.

The plugin recognizes:

- `assistant/message` with `data.message.content[]` blocks of type `tool-call`; call identity may be in `id`, `callId`, or compatible fields handled by `state.js`.
- `tool/result` with `data.message.source.callId` and a `tool-result` content block.
- Replacement events with `sourceEventSeqs` and `{ surfaceOp: { op: 'replace', startSeq, endSeq } }`.
- `compaction/summary` and checkpoint events carrying `shadowedRange`, `shadowedSeqs`, and a compaction identifier.

Old events must remain addressable through `eventAt` after a surface replacement. Evidence scanning and verdict inheritance depend on that append-only log.

## Compaction protocol

`compactRegion` must reject or avoid unbalanced tool pairs and must dynamically dispatch through its current `summarize` method. If it captures a private summarizer before the plugin wraps the method, deterministic receipt injection cannot work and layer 2 must remain disabled.

The return value should expose `shadowedSeqs` and `compactionId`. Missing optional fields reduce observability but should not corrupt the surface.

## Porting checklist

1. Install the plugin with `compactReceipts: false` and `dryRun: true`.
2. Run `jev_probe_shapes`; verify event types, content block names, call IDs, and tool names.
3. Run `node check.js` and `node smoke_apply.mjs` against the target dependency tree.
4. Confirm the judge hook runs before the host calls `pruneSession`.
5. Enable layer 1 and inspect `jev_prune_status` plus the heartbeat file.
6. Enable layer 2 in dry-run mode; confirm selected ranges begin and end on balanced cuts.
7. Perform one real receipt compaction and verify its provider is `jev-receipt` and the original events remain restorable.

Document every adapter needed for a new host version. Do not silently coerce unknown event shapes into the tested DSH format.
