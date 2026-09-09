BEGIN;

CREATE TABLE IF NOT EXISTS dlfm_schema_migrations (
  migration_name text PRIMARY KEY CHECK (length(migration_name) > 0),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE memory_distillation_receipts
  ADD CONSTRAINT memory_distillation_receipts_review_scope_key
  UNIQUE (receipt_id, tenant_id, life_did, memory_namespace);

ALTER TABLE memory_curation_records
  ADD CONSTRAINT memory_curation_records_review_scope_key
  UNIQUE (record_id, receipt_id, tenant_id, life_did, memory_namespace);

CREATE TABLE semantic_review_cases (
  case_id text PRIMARY KEY CHECK (case_id LIKE 'semrev_%'),
  curation_record_id text NOT NULL UNIQUE,
  receipt_id text NOT NULL,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('pending_review','canary_sample')),
  semantic_key text NOT NULL CHECK (length(semantic_key) > 0),
  semantic_policy_version text NOT NULL CHECK (length(semantic_policy_version) > 0),
  memory_type text NOT NULL CHECK (
    memory_type IN ('preference','technical_fact','transient_state','project_state','relationship','event','commitment','habit','general_fact')
  ),
  semantic_relation text CHECK (
    semantic_relation IS NULL OR semantic_relation IN (
      'equivalent','existing_subsumes_candidate','candidate_subsumes_existing',
      'contradicts','unrelated'
    )
  ),
  trigger_reason_codes text[] NOT NULL CHECK (cardinality(trigger_reason_codes) > 0),
  status text NOT NULL CHECK (status IN ('pending','deferred','resolved')),
  version integer NOT NULL CHECK (version >= 1),
  latest_decision_id text,
  latest_idempotency_key text,
  latest_disposition text CHECK (
    latest_disposition IS NULL OR latest_disposition IN (
      'approved_as_classified','confirmed_contradiction','confirmed_unrelated',
      'misclassified','invalid_candidate','needs_more_evidence'
    )
  ),
  reviewer jsonb,
  decision_evidence_ids text[],
  decision_reason_codes text[],
  decided_at timestamptz,
  canonical_write_performed boolean NOT NULL DEFAULT false
    CHECK (canonical_write_performed = false),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'pending' AND updated_at = created_at)
    OR (status IN ('deferred','resolved') AND decided_at = updated_at)
  ),
  CHECK (
    reviewer IS NULL OR (
      jsonb_typeof(reviewer) = 'object'
      AND reviewer->>'lifeDid' = life_did
      AND (
        nullif(btrim(reviewer->>'agentId'), '') IS NOT NULL
        OR nullif(btrim(reviewer->>'runtimeId'), '') IS NOT NULL
        OR nullif(btrim(reviewer->>'deviceId'), '') IS NOT NULL
      )
    )
  ),
  CHECK (
    decision_evidence_ids IS NULL
    OR decision_evidence_ids @> ARRAY['curation:' || curation_record_id]
  ),
  UNIQUE (case_id, tenant_id, life_did, memory_namespace),
  FOREIGN KEY (receipt_id, tenant_id, life_did, memory_namespace)
    REFERENCES memory_distillation_receipts (
      receipt_id, tenant_id, life_did, memory_namespace
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    curation_record_id, receipt_id, tenant_id, life_did, memory_namespace
  ) REFERENCES memory_curation_records (
    record_id, receipt_id, tenant_id, life_did, memory_namespace
  ) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND version = 1
      AND latest_decision_id IS NULL AND latest_idempotency_key IS NULL
      AND latest_disposition IS NULL AND reviewer IS NULL
      AND decision_evidence_ids IS NULL AND decision_reason_codes IS NULL
      AND decided_at IS NULL)
    OR
    (status IN ('deferred','resolved') AND version >= 2
      AND latest_decision_id LIKE 'semdec_%'
      AND length(latest_idempotency_key) > 0
      AND latest_disposition IS NOT NULL AND reviewer IS NOT NULL
      AND cardinality(decision_evidence_ids) > 0
      AND cardinality(decision_reason_codes) > 0
      AND decided_at IS NOT NULL)
  )
);

CREATE INDEX semantic_review_cases_scope_status_idx
  ON semantic_review_cases (
    tenant_id, life_did, memory_namespace, status, created_at, case_id
  );
CREATE INDEX semantic_review_cases_receipt_idx
  ON semantic_review_cases (receipt_id, case_id);

CREATE TABLE semantic_review_events (
  event_id text PRIMARY KEY CHECK (event_id LIKE 'semevt_%'),
  case_id text NOT NULL,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('enqueued','deferred','resolved')),
  case_version integer NOT NULL CHECK (case_version >= 1),
  decision_id text,
  idempotency_key text,
  disposition text CHECK (
    disposition IS NULL OR disposition IN (
      'approved_as_classified','confirmed_contradiction','confirmed_unrelated',
      'misclassified','invalid_candidate','needs_more_evidence'
    )
  ),
  reviewer jsonb,
  evidence_ids text[],
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  decided_at timestamptz,
  occurred_at timestamptz NOT NULL,
  CHECK (event_type = 'enqueued' OR decided_at = occurred_at),
  CHECK (
    reviewer IS NULL OR (
      jsonb_typeof(reviewer) = 'object'
      AND reviewer->>'lifeDid' = life_did
      AND (
        nullif(btrim(reviewer->>'agentId'), '') IS NOT NULL
        OR nullif(btrim(reviewer->>'runtimeId'), '') IS NOT NULL
        OR nullif(btrim(reviewer->>'deviceId'), '') IS NOT NULL
      )
    )
  ),
  UNIQUE (case_id, case_version),
  FOREIGN KEY (case_id, tenant_id, life_did, memory_namespace)
    REFERENCES semantic_review_cases (
      case_id, tenant_id, life_did, memory_namespace
    ) ON DELETE RESTRICT,
  CHECK (
    (event_type = 'enqueued' AND case_version = 1
      AND decision_id IS NULL AND idempotency_key IS NULL
      AND disposition IS NULL AND reviewer IS NULL
      AND evidence_ids IS NULL AND decided_at IS NULL)
    OR
    (event_type IN ('deferred','resolved') AND case_version >= 2
      AND decision_id LIKE 'semdec_%' AND length(idempotency_key) > 0
      AND disposition IS NOT NULL AND reviewer IS NOT NULL
      AND cardinality(evidence_ids) > 0 AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX semantic_review_events_scope_idempotency_idx
  ON semantic_review_events (tenant_id, life_did, memory_namespace, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX semantic_review_events_case_idx
  ON semantic_review_events (case_id, case_version);

CREATE FUNCTION reject_semantic_review_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'semantic review events are append-only';
END;
$$;

CREATE TRIGGER semantic_review_events_append_only
BEFORE UPDATE OR DELETE ON semantic_review_events
FOR EACH ROW EXECUTE FUNCTION reject_semantic_review_event_mutation();

INSERT INTO dlfm_schema_migrations (migration_name)
VALUES ('0006_semantic_review_queue.sql');

COMMIT;
