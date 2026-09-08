BEGIN;

ALTER TABLE memory_candidates
  DROP CONSTRAINT IF EXISTS memory_candidates_canonical_admission_shape_check,
  ADD COLUMN memory_type text,
  ADD COLUMN speaker_provenance text,
  ADD COLUMN semantic_key text;

UPDATE memory_candidates
SET memory_type = CASE
      WHEN candidate_type = 'preference_candidate' OR memory_class = 'preference' THEN 'preference'
      WHEN candidate_type = 'relationship_candidate' OR memory_class = 'relationship_fact' THEN 'relationship'
      WHEN candidate_type = 'project_state_candidate' THEN 'project_state'
      WHEN candidate_type = 'commitment_candidate' THEN 'commitment'
      WHEN candidate_type = 'habit_candidate' THEN 'habit'
      WHEN candidate_type = 'event_candidate' OR memory_class = 'episode' THEN 'event'
      ELSE 'general_fact'
    END,
    speaker_provenance = CASE
      WHEN producer->>'kind' = 'user' THEN 'user'
      WHEN producer->>'kind' = 'system' THEN 'system'
      ELSE 'unknown'
    END,
    semantic_key = CASE
      WHEN base_memory_id IS NOT NULL THEN 'legacy:' || base_memory_id
      ELSE 'legacy:' || candidate_fingerprint
    END;

ALTER TABLE memory_candidates
  ALTER COLUMN memory_type SET NOT NULL,
  ALTER COLUMN speaker_provenance SET NOT NULL,
  ALTER COLUMN semantic_key SET NOT NULL,
  ADD CONSTRAINT memory_candidates_memory_type_check CHECK (
    memory_type IN ('preference','technical_fact','transient_state','project_state','relationship','event','commitment','habit','general_fact')
  ),
  ADD CONSTRAINT memory_candidates_speaker_provenance_check CHECK (
    speaker_provenance IN ('user','assistant','system','tool','mixed','unknown')
  ),
  ADD CONSTRAINT memory_candidates_semantic_key_check CHECK (length(semantic_key) > 0),
  ADD CONSTRAINT memory_candidates_canonical_admission_shape_check CHECK (
    canonical_admission IS NULL OR (
      length(COALESCE(canonical_admission->>'admissionPolicyVersion', '')) > 0
      AND length(COALESCE(canonical_admission->>'curationProvider', '')) > 0
      AND canonical_admission->>'curationRecordId' LIKE 'cur_%'
      AND (
        (canonical_admission->>'outcome' = 'canonical_candidate' AND proposed_operation = 'create')
        OR
        (
          canonical_admission->>'outcome' = 'canonical_merge'
          AND proposed_operation = 'merge'
          AND canonical_admission->>'targetMemoryId' = base_memory_id
          AND length(COALESCE(canonical_admission->>'semanticPolicyVersion', '')) > 0
          AND canonical_admission->>'semanticRelation' IN (
            'equivalent','existing_subsumes_candidate','candidate_subsumes_existing'
          )
        )
      )
    )
  );

ALTER TABLE memory_heads
  ADD COLUMN memory_type text,
  ADD COLUMN semantic_key text;

UPDATE memory_heads
SET memory_type = CASE
      WHEN memory_class = 'preference' THEN 'preference'
      WHEN memory_class = 'relationship_fact' THEN 'relationship'
      WHEN memory_class = 'episode' THEN 'event'
      ELSE 'general_fact'
    END,
    semantic_key = 'legacy:' || memory_id;

ALTER TABLE memory_heads
  ALTER COLUMN memory_type SET NOT NULL,
  ALTER COLUMN semantic_key SET NOT NULL,
  ADD CONSTRAINT memory_heads_memory_type_check CHECK (
    memory_type IN ('preference','technical_fact','transient_state','project_state','relationship','event','commitment','habit','general_fact')
  ),
  ADD CONSTRAINT memory_heads_semantic_key_check CHECK (length(semantic_key) > 0);

CREATE UNIQUE INDEX memory_heads_scope_semantic_key_idx
  ON memory_heads (tenant_id, life_did, memory_namespace, semantic_key);

ALTER TABLE memory_revisions
  ADD COLUMN memory_type text,
  ADD COLUMN speaker_provenance text,
  ADD COLUMN semantic_key text;

UPDATE memory_revisions
SET memory_type = CASE
      WHEN memory_class = 'preference' THEN 'preference'
      WHEN memory_class = 'relationship_fact' THEN 'relationship'
      WHEN memory_class = 'episode' THEN 'event'
      ELSE 'general_fact'
    END,
    speaker_provenance = 'unknown',
    semantic_key = 'legacy:' || memory_id;

ALTER TABLE memory_revisions
  ALTER COLUMN memory_type SET NOT NULL,
  ALTER COLUMN speaker_provenance SET NOT NULL,
  ALTER COLUMN semantic_key SET NOT NULL,
  ADD CONSTRAINT memory_revisions_memory_type_check CHECK (
    memory_type IN ('preference','technical_fact','transient_state','project_state','relationship','event','commitment','habit','general_fact')
  ),
  ADD CONSTRAINT memory_revisions_speaker_provenance_check CHECK (
    speaker_provenance IN ('user','assistant','system','tool','mixed','unknown')
  ),
  ADD CONSTRAINT memory_revisions_semantic_key_check CHECK (length(semantic_key) > 0);

CREATE INDEX memory_revisions_scope_semantic_key_idx
  ON memory_revisions (tenant_id, life_did, memory_namespace, semantic_key, revision);

ALTER TABLE memory_curation_records
  DROP CONSTRAINT IF EXISTS memory_curation_records_outcome_check,
  ADD COLUMN attributed_epistemic_basis text NOT NULL DEFAULT 'provider_declared',
  ADD COLUMN memory_type text NOT NULL DEFAULT 'general_fact',
  ADD COLUMN speaker_provenance text NOT NULL DEFAULT 'unknown',
  ADD COLUMN semantic_key text NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN semantic_policy_version text NOT NULL DEFAULT 'legacy_unreviewed',
  ADD COLUMN semantic_relation text,
  ADD CONSTRAINT memory_curation_records_outcome_check CHECK (
    outcome IN ('supporting_evidence_only','rejected','pending_review','canonical_candidate','canonical_merge')
  ),
  ADD CONSTRAINT memory_curation_records_epistemic_basis_check CHECK (
    attributed_epistemic_basis IN ('dlmf_semantic_policy','provider_declared','direct_source_quote','system_record','derived','unknown')
  ),
  ADD CONSTRAINT memory_curation_records_memory_type_check CHECK (
    memory_type IN ('preference','technical_fact','transient_state','project_state','relationship','event','commitment','habit','general_fact')
  ),
  ADD CONSTRAINT memory_curation_records_speaker_provenance_check CHECK (
    speaker_provenance IN ('user','assistant','system','tool','mixed','unknown')
  ),
  ADD CONSTRAINT memory_curation_records_semantic_relation_check CHECK (
    semantic_relation IS NULL OR semantic_relation IN (
      'equivalent','existing_subsumes_candidate','candidate_subsumes_existing',
      'contradicts','unrelated'
    )
  );

UPDATE memory_curation_records AS record
SET memory_type = candidate.memory_type,
    speaker_provenance = candidate.speaker_provenance,
    semantic_key = candidate.semantic_key
FROM memory_candidates AS candidate
WHERE record.candidate_id = candidate.candidate_id;

ALTER TABLE memory_curation_records
  ALTER COLUMN attributed_epistemic_basis DROP DEFAULT,
  ALTER COLUMN memory_type DROP DEFAULT,
  ALTER COLUMN speaker_provenance DROP DEFAULT,
  ALTER COLUMN semantic_key DROP DEFAULT,
  ALTER COLUMN semantic_policy_version DROP DEFAULT;

ALTER TABLE memory_distillation_receipts
  ADD COLUMN semantic_policy_version text NOT NULL DEFAULT 'legacy_unreviewed',
  ALTER COLUMN curation_outcomes SET DEFAULT '{"supporting_evidence_only":0,"rejected":0,"pending_review":0,"canonical_candidate":0,"canonical_merge":0}'::jsonb;

UPDATE memory_distillation_receipts
SET curation_outcomes = curation_outcomes || '{"canonical_merge":0}'::jsonb;

ALTER TABLE memory_distillation_receipts
  ALTER COLUMN semantic_policy_version DROP DEFAULT;

CREATE TABLE reflective_insights (
  insight_id text PRIMARY KEY CHECK (insight_id LIKE 'insight_%'),
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  proposition text NOT NULL CHECK (length(proposition) > 0),
  epistemic_status text NOT NULL CHECK (epistemic_status IN ('inferred','synthesized','uncertain')),
  supporting_memory_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  supporting_evidence_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  contradicting_memory_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  derivation_provider text NOT NULL CHECK (length(derivation_provider) > 0),
  derivation_model text NOT NULL CHECK (length(derivation_model) > 0),
  derivation_run_id text NOT NULL CHECK (length(derivation_run_id) > 0),
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  promotion_eligibility jsonb NOT NULL,
  canonical_write_performed boolean NOT NULL DEFAULT false CHECK (canonical_write_performed = false),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX reflective_insights_scope_status_idx
  ON reflective_insights (tenant_id, life_did, memory_namespace, status, created_at);

CREATE TABLE insight_promotion_records (
  promotion_id text PRIMARY KEY CHECK (promotion_id LIKE 'prom_%'),
  insight_id text NOT NULL REFERENCES reflective_insights(insight_id),
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  promotion_policy_version text NOT NULL CHECK (length(promotion_policy_version) > 0),
  approved_by jsonb NOT NULL,
  eligibility jsonb NOT NULL,
  memory_type text NOT NULL CHECK (
    memory_type IN ('preference','technical_fact','transient_state','project_state','relationship','event','commitment','habit','general_fact')
  ),
  semantic_key text NOT NULL CHECK (length(semantic_key) > 0),
  status text NOT NULL CHECK (status IN ('approved','committed','rejected')),
  candidate_id text REFERENCES memory_candidates(candidate_id),
  canonical_memory_id text REFERENCES memory_heads(memory_id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, life_did, memory_namespace, idempotency_key),
  CHECK (
    status <> 'committed'
    OR (candidate_id IS NOT NULL AND canonical_memory_id IS NOT NULL)
  )
);

CREATE INDEX insight_promotion_records_scope_status_idx
  ON insight_promotion_records (
    tenant_id, life_did, memory_namespace, status, created_at
  );

COMMIT;
