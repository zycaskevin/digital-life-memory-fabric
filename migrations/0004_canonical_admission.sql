BEGIN;

ALTER TABLE memory_candidates
  ADD COLUMN canonical_admission jsonb,
  ADD CONSTRAINT memory_candidates_canonical_admission_shape_check CHECK (
    canonical_admission IS NULL OR (
      canonical_admission->>'outcome' = 'canonical_candidate'
      AND length(COALESCE(canonical_admission->>'admissionPolicyVersion', '')) > 0
      AND length(COALESCE(canonical_admission->>'curationProvider', '')) > 0
      AND canonical_admission->>'curationRecordId' LIKE 'cur_%'
    )
  );

ALTER TABLE memory_distillation_receipts
  DROP CONSTRAINT IF EXISTS memory_distillation_receipts_status_check,
  DROP CONSTRAINT IF EXISTS memory_distillation_receipts_canonicalization_outcome_check;

ALTER TABLE memory_distillation_receipts
  ADD COLUMN curated_at timestamptz,
  ADD COLUMN admission_policy_version text NOT NULL DEFAULT 'legacy_unreviewed',
  ADD COLUMN curation_provider text NOT NULL DEFAULT 'legacy_unreviewed',
  ADD COLUMN curation_provider_version text,
  ADD COLUMN provider_unit_count integer NOT NULL DEFAULT 0 CHECK (provider_unit_count >= 0),
  ADD COLUMN curation_decision_count integer NOT NULL DEFAULT 0 CHECK (curation_decision_count >= 0),
  ADD COLUMN curation_outcomes jsonb NOT NULL DEFAULT '{"supporting_evidence_only":0,"rejected":0,"pending_review":0,"canonical_candidate":0}'::jsonb,
  ADD COLUMN curation_coverage_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN admission_complete boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT memory_distillation_receipts_curation_count_check CHECK (
    curation_decision_count <= provider_unit_count
  ),
  ADD CONSTRAINT memory_distillation_receipts_status_check CHECK (
    status IN (
      'pending','ingested','archived','distilled','curated',
      'canonicalized','awaiting_review','complete','failed'
    )
  ),
  ADD CONSTRAINT memory_distillation_receipts_canonicalization_outcome_check CHECK (
    canonicalization_outcome IN (
      'pending','committed','no_memory_worthy_content','rejected','superseded','pending_review'
    )
  );

UPDATE memory_distillation_receipts
SET prune_eligible = false,
    retention_state = CASE
      WHEN raw_archive_ref IS NOT NULL AND raw_archive_checksum IS NOT NULL THEN 'preserved'
      ELSE 'hot'
    END,
    admission_complete = false,
    curation_coverage_complete = false,
    admission_policy_version = 'legacy_unreviewed',
    curation_provider = 'legacy_unreviewed';

ALTER TABLE memory_distillation_receipts
  ALTER COLUMN admission_policy_version DROP DEFAULT,
  ALTER COLUMN curation_provider DROP DEFAULT;

CREATE TABLE memory_curation_records (
  record_id text PRIMARY KEY,
  receipt_id text NOT NULL REFERENCES memory_distillation_receipts(receipt_id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  provider_name text NOT NULL,
  provider_run_id text NOT NULL,
  provider_unit_ref text NOT NULL,
  provider_unit_text text NOT NULL,
  provider_unit_fingerprint text NOT NULL,
  provider_epistemic_status text NOT NULL CHECK (
    provider_epistemic_status IN ('observed','user_asserted','system_observed','inferred','synthesized','uncertain')
  ),
  curation_provider text NOT NULL,
  curation_provider_version text,
  admission_policy_version text NOT NULL,
  outcome text NOT NULL CHECK (
    outcome IN ('supporting_evidence_only','rejected','pending_review','canonical_candidate')
  ),
  attributed_epistemic_status text NOT NULL CHECK (
    attributed_epistemic_status IN ('observed','user_asserted','system_observed','inferred','synthesized','uncertain')
  ),
  durability text NOT NULL CHECK (
    durability IN ('transient','session_scoped','time_bounded','durable','identity_long_term','unknown')
  ),
  memory_worthy boolean NOT NULL,
  semantic_disposition text NOT NULL CHECK (
    semantic_disposition IN ('novel','duplicate','merge_required')
  ),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  target_memory_id text,
  candidate_id text REFERENCES memory_candidates(candidate_id) ON DELETE RESTRICT,
  canonical_memory_id text REFERENCES memory_heads(memory_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (receipt_id, provider_unit_ref)
);

CREATE INDEX memory_curation_records_receipt_idx
  ON memory_curation_records (receipt_id, provider_unit_ref);
CREATE INDEX memory_curation_records_review_idx
  ON memory_curation_records (tenant_id, life_did, memory_namespace, created_at)
  WHERE outcome = 'pending_review';
CREATE INDEX memory_curation_records_outcome_idx
  ON memory_curation_records (outcome, created_at);

COMMIT;
