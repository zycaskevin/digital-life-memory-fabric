# GB10 Nancy multi-source DLMF activation candidate

Status: repository deployment candidate. The units are user-systemd sidecars and do not replace Nancy's existing Hermes living-memory ingress/timer.

## Authority and safety

- DLMF remains Canonical Memory Authority.
- AKF remains a separate Knowledge Authority; these workers do not write AKF.
- Default `DLMF_MULTI_SOURCE_WRITE_MODE=reference_only` produces no Canonical Memory writes.
- `distill` is an explicit activation flag and must be canary-verified before broad enablement.
- The ChatGPT inbox is only an authenticated local receiving boundary. It does **not** provide direct ChatGPT cloud-history access.
- Codex only reads the configured local session journal root.

## Services

- `digital-life-dl-nancy-codex-memory-sync.service/.timer` — Codex delta polling every five minutes.
- `digital-life-dl-nancy-chatgpt-capture-inbox.service` — loopback-only authenticated capture receiver.
- `digital-life-dl-nancy-chatgpt-memory-sync.service/.timer` — ChatGPT capture delta polling every five minutes.
- `digital-life-dl-nancy-multi-source-nightly.service/.timer` — nightly replay of the same delta/checkpoint paths, not a historical full import.

## Preflight

Build and verify the exact candidate first:

```bash
npm run check
node --check scripts/codex-incremental-sync-worker.mjs
node --check scripts/chatgpt-capture-sync-worker.mjs
node --check scripts/chatgpt-capture-inbox-server.mjs
node --check scripts/multi-source-nightly-consolidation.mjs
```

Render the templates to `~/.config/systemd/user` only after the environment file is owner-private and all placeholders are replaced. Keep the environment file outside Git.

Before timers are enabled, run both workers with `--preflight --reference-only`, then baseline the existing source roots with `--baseline-current --reference-only`. Baseline establishes observation checkpoints without distilling historical content.

## Activation sequence

1. Start ChatGPT capture inbox and verify `/health` + `/ready`.
2. Enable Codex and ChatGPT timers in `reference_only` mode.
3. Run at least one real Codex reference-only UAT and one authenticated ChatGPT inbox fixture UAT.
4. Create a separate canary schema/bank or otherwise approved isolated DLMF scope.
5. Explicitly switch only the canary runner to `DLMF_MULTI_SOURCE_WRITE_MODE=distill`; verify receipts and canonical effects.
6. Broad production distillation is a separate evidence-gated action.

## Rollback

Disable the new timers/inbox and remove only the rendered sidecar units. Preserve checkpoints, capture snapshots, DLMF receipts, and evidence. Do not rewrite existing Hermes memory history or delete canonical records as a rollback mechanism.
