BEGIN;

CREATE TABLE memory_candidates (
  candidate_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  origin jsonb NOT NULL,
  candidate_type text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  memory_class text NOT NULL CHECK (memory_class IN ('episode','semantic_assertion','preference','relationship_fact')),
  memory_kind text NOT NULL,
  proposed_text text NOT NULL,
  proposed_payload jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  proposed_operation text NOT NULL CHECK (proposed_operation IN ('create','update','supersede','tombstone','restore','merge')),
  base_memory_id text,
  base_revision integer,
  status text NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','CONFLICT','EXPIRED')),
  created_at timestamptz NOT NULL,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  CONSTRAINT memory_candidates_validity CHECK (
    valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from
  ),
  CONSTRAINT memory_candidates_base_contract CHECK (
    (proposed_operation = 'create' AND base_memory_id IS NULL AND base_revision IS NULL)
    OR
    (proposed_operation <> 'create' AND base_memory_id IS NOT NULL AND base_revision >= 1)
  )
);

CREATE TABLE memory_heads (
  memory_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  memory_class text NOT NULL CHECK (memory_class IN ('episode','semantic_assertion','preference','relationship_fact')),
  memory_kind text NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  status text NOT NULL CHECK (status IN ('active','tombstoned','superseded')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (memory_id, tenant_id, life_did, memory_namespace)
);

CREATE TABLE memory_namespace_sequences (
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  last_commit_seq bigint NOT NULL CHECK (last_commit_seq >= 0),
  PRIMARY KEY (tenant_id, life_did, memory_namespace)
);

CREATE TABLE memory_revisions (
  memory_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  memory_class text NOT NULL CHECK (memory_class IN ('episode','semantic_assertion','preference','relationship_fact')),
  memory_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','tombstoned','superseded')),
  canonical_text text NOT NULL,
  canonical_payload jsonb,
  content_hash text NOT NULL,
  author jsonb NOT NULL,
  provenance jsonb NOT NULL,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  committed_at timestamptz NOT NULL,
  commit_seq bigint NOT NULL CHECK (commit_seq >= 1),
  PRIMARY KEY (memory_id, revision),
  FOREIGN KEY (memory_id, tenant_id, life_did, memory_namespace)
    REFERENCES memory_heads(memory_id, tenant_id, life_did, memory_namespace),
  CONSTRAINT memory_revisions_validity CHECK (
    valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from
  )
);

CREATE TABLE memory_evidence (
  evidence_id bigserial PRIMARY KEY,
  memory_id text NOT NULL,
  revision integer NOT NULL,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  FOREIGN KEY (memory_id, revision)
    REFERENCES memory_revisions(memory_id, revision)
    ON DELETE RESTRICT,
  UNIQUE (memory_id, revision, source_type, source_ref)
);

CREATE TABLE memory_changes (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  commit_seq bigint NOT NULL CHECK (commit_seq >= 1),
  memory_id text NOT NULL REFERENCES memory_heads(memory_id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('create','update','supersede','tombstone','restore','merge')),
  base_revision integer,
  new_revision integer NOT NULL CHECK (new_revision >= 1),
  idempotency_key text NOT NULL,
  author jsonb NOT NULL,
  committed_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  UNIQUE (tenant_id, life_did, memory_namespace, commit_seq),
  UNIQUE (tenant_id, life_did, memory_namespace, idempotency_key)
);

CREATE TABLE memory_outbox (
  outbox_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  commit_seq bigint NOT NULL CHECK (commit_seq >= 1),
  memory_id text NOT NULL REFERENCES memory_heads(memory_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','update','supersede','tombstone','restore','merge')),
  status text NOT NULL CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  FOREIGN KEY (memory_id, revision)
    REFERENCES memory_revisions(memory_id, revision)
    ON DELETE RESTRICT,
  UNIQUE (tenant_id, life_did, memory_namespace, commit_seq)
);

CREATE TABLE provider_materializations (
  provider_name text NOT NULL,
  memory_id text NOT NULL REFERENCES memory_heads(memory_id) ON DELETE RESTRICT,
  provider_id text,
  canonical_revision integer NOT NULL CHECK (canonical_revision >= 1),
  materialized_revision integer NOT NULL DEFAULT 0 CHECK (materialized_revision >= 0),
  status text NOT NULL CHECK (status IN ('CURRENT','LAGGING','FAILED','UNAVAILABLE','REBUILDING')),
  last_error text,
  last_attempt timestamptz,
  PRIMARY KEY (provider_name, memory_id)
);

CREATE TABLE device_checkpoints (
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  device_id text NOT NULL,
  last_applied_commit_seq bigint NOT NULL DEFAULT 0 CHECK (last_applied_commit_seq >= 0),
  last_sync_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, life_did, memory_namespace, device_id)
);

CREATE TABLE memory_conflicts (
  conflict_id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES memory_candidates(candidate_id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  memory_id text NOT NULL REFERENCES memory_heads(memory_id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision >= 1),
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  detected_at timestamptz NOT NULL
);

CREATE INDEX memory_heads_scope_idx
  ON memory_heads (tenant_id, life_did, memory_namespace, status);
CREATE INDEX memory_revisions_scope_commit_idx
  ON memory_revisions (tenant_id, life_did, memory_namespace, commit_seq);
CREATE INDEX memory_changes_scope_commit_idx
  ON memory_changes (tenant_id, life_did, memory_namespace, commit_seq);
CREATE INDEX memory_outbox_pending_idx
  ON memory_outbox (status, created_at)
  WHERE status IN ('PENDING','FAILED');
CREATE INDEX memory_candidates_pending_idx
  ON memory_candidates (tenant_id, life_did, memory_namespace, created_at)
  WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION next_memory_commit_seq(
  p_tenant_id text,
  p_life_did text,
  p_memory_namespace text
) RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO memory_namespace_sequences (
    tenant_id, life_did, memory_namespace, last_commit_seq
  ) VALUES (
    p_tenant_id, p_life_did, p_memory_namespace, 1
  )
  ON CONFLICT (tenant_id, life_did, memory_namespace)
  DO UPDATE SET last_commit_seq = memory_namespace_sequences.last_commit_seq + 1
  RETURNING last_commit_seq;
$$;

COMMIT;
