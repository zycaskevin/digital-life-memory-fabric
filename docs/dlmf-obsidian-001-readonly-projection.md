# DLMF-OBSIDIAN-001 — Read-only Obsidian Memory Projection

**Date:** 2026-09-15  
**Status:** MVP implemented and verified against the Direct3700 Canonical Store  
**Canonical authority:** DLMF PostgreSQL only

## Purpose

DLMF needs a human-readable, visual way to inspect Canonical Memory without introducing another source of truth. This MVP projects current Canonical Memory into native Obsidian Markdown so Obsidian's own Graph View and Local Graph can be used immediately.

Obsidian is **not** a database, memory authority, synchronization authority, or editing surface for Canonical Memory.

Architecture:

```text
DLMF PostgreSQL Canonical Store
        │
        │ read-only projection
        ▼
ObsidianMemoryProjection
        │
        ├── Memories/*.md
        ├── Concepts/*.md
        ├── People/*.md
        ├── Projects/*.md   (when project_state memories exist)
        ├── Sources/*.md
        └── dlmf-manifest.json
        │
        ▼
Obsidian native Graph / Local Graph
```

## Read-only contract

`ObsidianMemoryProjection` does not receive the full write-capable store contract. Its source type is a compile-time `Pick` containing only:

- `listChangesAfter`
- `getHeads`
- `getRevisions`

The projection can write only files beneath the selected vault root. It has no Canonical transaction/commit/tombstone/update interface.

## Stable memory notes

Each active Canonical Memory has exactly one stable path:

```text
Memories/<dlmf_memory_id>.md
```

A revision update rewrites that same note. It never creates a second note for the same memory identity.

Frontmatter includes:

- `dlmf_id`
- `revision`
- `status`
- `class`
- `kind`
- `type`
- `epistemic`
- `speaker`
- `semantic_key`
- `commit_seq`
- `committed_at`
- `content_hash`
- machine-readable `dlmf_edges`

The note body contains Canonical text followed by typed Obsidian `[[wikilinks]]`.

## Graph semantics

The projection contract reserves these edge types:

- `related_to`
- `supports`
- `contradicts`
- `supersedes`
- `belongs_to_project`
- `concerns`
- `derived_from`

The MVP deliberately does **not** create semantic-similarity edges from embeddings or arbitrary text resemblance.

Edges currently emitted only when DLMF has deterministic structural evidence:

- memory → source: `derived_from`
- source → memory: `supports`
- memory → memory type/class/speaker: `concerns`
- memory → memory kind: `related_to`
- `project_state` memory → deterministic memory-kind project grouping: `belongs_to_project`

`contradicts` and `supersedes` remain reserved until an explicit Canonical relationship edge is available. The exporter does not infer them from prose.

Both memory-note edges and supporting-node reverse edges are stored in `dlmf-manifest.json`, so the graph can later be consumed by retrieval logic rather than existing only as an Obsidian UI effect.

## Tombstone behavior

Only current `active` heads are written beneath `Memories/`.

When a previously active memory becomes tombstoned or superseded:

1. its generated active note is removed on the next export;
2. it is listed in the manifest's `excluded` collection with revision and status;
3. supporting nodes that are no longer referenced are cleaned up;
4. arbitrary human-created files outside DLMF generated roots are never removed.

Unit tests verify this behavior with a real tombstone transition.

## Deterministic export

The manifest contains no generation timestamp. Notes, paths, edge order, and supporting-node IDs are stable.

The exporter compares desired content against existing files and rewrites only changed generated files. Cleanup is constrained to paths previously owned by the DLMF manifest and to these generated roots only:

- `Memories/`
- `Concepts/`
- `People/`
- `Projects/`
- `Sources/`

This allows re-export without duplicate notes and prevents DLMF from deleting unrelated Obsidian content.

## Commands

Export:

```bash
npm run projection:obsidian:export
```

Verify graph and manifest:

```bash
npm run projection:obsidian:verify
```

The default generated vault is:

```text
/srv/workspace/dlmf-qwen-ab/obsidian-vault
```

`obsidian-vault/` is gitignored so personal Canonical Memory is not accidentally committed to the repository.

## Direct3700 verification — 2026-09-15

Authoritative source schema:

`dlmf_pilot_hermes_adapter_direct1000_shadow_v3`

Scope:

- tenant: `arthurverse-hermes-migration-pilot`
- life DID: `did:arthurverse:nancy`
- namespace: `pilot.hermes-historical-migration.direct1000-v1`

Verified projection:

- active Canonical Memory notes: **224**
- excluded inactive heads: **0**
- supporting graph nodes: **192**
  - sources: 186
  - concepts: 5
  - people: 1
  - projects: 0 (the current active set contains no `project_state` head)
- max Canonical commit sequence: **232**
- machine-readable/rendered structural edges:
  - `derived_from`: 231
  - `supports`: 231
  - `related_to`: 448 including reverse supporting-node links
  - `concerns`: 1,344 including reverse supporting-node links
  - `belongs_to_project`: 0 in the current data set
  - `contradicts`: 0 (reserved; not inferred)
  - `supersedes`: 0 (reserved; not inferred)
- duplicate memory IDs: none
- duplicate note paths: none
- missing graph targets: none
- inactive memory leakage: none
- verification result: **PASS**

After the manifest gained machine-readable reverse supporting edges, one manifest rewrite was expected. The following re-export produced:

- written: **0**
- unchanged: **417**
- removed: **0**

This is the accepted idempotent Direct3700 Obsidian projection baseline.

## Test coverage

`DLMF-OBSIDIAN-001` regression coverage verifies:

1. stable memory-ID filenames;
2. visible revision/status metadata;
3. native `[[wikilinks]]` and typed edges;
4. shared source nodes and reverse `supports` edges;
5. deterministic second export;
6. a memory revision updates the same note rather than duplicating it;
7. tombstoned memory leaves the active graph;
8. orphan generated supporting nodes are cleaned up;
9. human-created notes remain untouched;
10. manifest contains no run timestamp and is machine-readable.

Current full test gate:

- 194 tests total
- 186 passed
- 0 failed
- 8 skipped integration tests
- TypeScript typecheck: PASS
- build: PASS

## Next boundary

This MVP is intentionally not an Obsidian plugin. A future `DLMF Memory Explorer` plugin may add sync/search/review/provenance/revision history/contradiction workflows only after the native-vault projection proves useful in real use.
