BEGIN;

ALTER TABLE memory_candidates
  ADD COLUMN epistemic_status text,
  ADD COLUMN producer jsonb,
  ADD COLUMN source_experience_refs jsonb,
  ADD COLUMN candidate_fingerprint text,
  ADD COLUMN distillation_policy_version text,
  ADD COLUMN provider_run_id text;

UPDATE memory_candidates
SET epistemic_status = 'uncertain',
    producer = '{"kind":"runtime","id":"legacy-migration"}'::jsonb,
    source_experience_refs = CASE
      WHEN source_id IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(jsonb_build_object('sourceType', source_type, 'sourceId', source_id))
    END,
    candidate_fingerprint = 'legacy:' || candidate_id
WHERE epistemic_status IS NULL;

ALTER TABLE memory_candidates
  ALTER COLUMN epistemic_status SET NOT NULL,
  ALTER COLUMN producer SET NOT NULL,
  ALTER COLUMN source_experience_refs SET NOT NULL,
  ALTER COLUMN candidate_fingerprint SET NOT NULL,
  ADD CONSTRAINT memory_candidates_epistemic_status_check CHECK (
    epistemic_status IN ('observed','user_asserted','system_observed','inferred','synthesized','uncertain')
  );

CREATE INDEX memory_candidates_fingerprint_idx
  ON memory_candidates (tenant_id, life_did, memory_namespace, candidate_fingerprint);

ALTER TABLE memory_revisions
  ADD COLUMN epistemic_status text,
  ADD COLUMN producer jsonb,
  ADD COLUMN source_experience_refs jsonb,
  ADD COLUMN semantic_fingerprint text;

UPDATE memory_revisions
SET epistemic_status = 'uncertain',
    producer = '{"kind":"runtime","id":"legacy-migration"}'::jsonb,
    source_experience_refs = CASE
      WHEN provenance->>'sourceId' IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(
        jsonb_build_object(
          'sourceType', COALESCE(provenance->>'sourceType', 'legacy'),
          'sourceId', provenance->>'sourceId'
        )
      )
    END,
    semantic_fingerprint = 'legacy:' || content_hash
WHERE epistemic_status IS NULL;

UPDATE memory_revisions
SET provenance = provenance || jsonb_build_object(
  'candidateFingerprint', semantic_fingerprint,
  'producer', producer,
  'sourceExperienceRefs', source_experience_refs
);

ALTER TABLE memory_revisions
  ALTER COLUMN epistemic_status SET NOT NULL,
  ALTER COLUMN producer SET NOT NULL,
  ALTER COLUMN source_experience_refs SET NOT NULL,
  ALTER COLUMN semantic_fingerprint SET NOT NULL,
  ADD CONSTRAINT memory_revisions_epistemic_status_check CHECK (
    epistemic_status IN ('observed','user_asserted','system_observed','inferred','synthesized','uncertain')
  );

CREATE INDEX memory_revisions_semantic_fingerprint_idx
  ON memory_revisions (tenant_id, life_did, memory_namespace, semantic_fingerprint);

CREATE TABLE memory_distillation_receipts (
  receipt_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  idempotency_key text NOT NULL,
  ingested_at timestamptz,
  archived_at timestamptz,
  distilled_at timestamptz,
  canonicalized_at timestamptz,
  raw_archive_ref text,
  raw_archive_checksum text,
  provider text NOT NULL,
  provider_run_id text,
  distillation_policy_version text NOT NULL,
  canonicalization_policy_version text NOT NULL,
  retention_policy_version text NOT NULL,
  adapter_version text NOT NULL,
  provider_version text,
  candidate_ids text[] NOT NULL DEFAULT '{}',
  canonical_memory_ids text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (
    status IN ('pending','ingested','archived','distilled','canonicalized','complete','failed')
  ),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonicalization_outcome text NOT NULL CHECK (
    canonicalization_outcome IN ('pending','committed','no_memory_worthy_content','rejected','superseded')
  ),
  retention_state text NOT NULL CHECK (
    retention_state IN ('hot','preserved','prune_eligible')
  ),
  prune_eligible boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL CHECK (attempts >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, life_did, memory_namespace, idempotency_key)
);

CREATE INDEX memory_distillation_receipts_source_idx
  ON memory_distillation_receipts (
    tenant_id, life_did, memory_namespace, source_type, source_id, updated_at DESC
  );
CREATE INDEX memory_distillation_receipts_prune_idx
  ON memory_distillation_receipts (prune_eligible, updated_at)
  WHERE status = 'complete';

COMMIT;
