BEGIN;

ALTER TABLE insight_promotion_records
  ADD COLUMN approval_evidence_ids text[] NOT NULL
    DEFAULT ARRAY['legacy:approval-verifier-only']::text[];

ALTER TABLE insight_promotion_records
  ALTER COLUMN approval_evidence_ids DROP DEFAULT,
  ADD CONSTRAINT insight_promotion_records_approval_evidence_required
    CHECK (
      cardinality(approval_evidence_ids) > 0
      AND array_position(approval_evidence_ids, '') IS NULL
    ),
  ADD CONSTRAINT insight_promotion_records_approved_by_identified
    CHECK (
      jsonb_typeof(approved_by) = 'object'
      AND approved_by->>'lifeDid' = life_did
      AND (
        nullif(btrim(approved_by->>'agentId'), '') IS NOT NULL
        OR nullif(btrim(approved_by->>'runtimeId'), '') IS NOT NULL
        OR nullif(btrim(approved_by->>'deviceId'), '') IS NOT NULL
      )
    ),
  ADD CONSTRAINT insight_promotion_records_event_scope_key
    UNIQUE (
      promotion_id, insight_id, tenant_id, life_did, memory_namespace
    );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM insight_promotion_records
     GROUP BY insight_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'migration 0007 requires manual review: one reflective insight has multiple promotion records';
  END IF;
END;
$$;

CREATE UNIQUE INDEX insight_promotion_records_insight_once_idx
  ON insight_promotion_records (insight_id);

CREATE TABLE insight_promotion_events (
  event_id text PRIMARY KEY CHECK (event_id LIKE 'promevt_%'),
  promotion_id text NOT NULL,
  insight_id text NOT NULL,
  tenant_id text NOT NULL,
  life_did text NOT NULL,
  memory_namespace text NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('approved','candidate_linked','committed','rejected')
  ),
  status text NOT NULL CHECK (status IN ('approved','committed','rejected')),
  approved_by jsonb NOT NULL,
  approval_evidence_ids text[] NOT NULL CHECK (
    cardinality(approval_evidence_ids) > 0
    AND array_position(approval_evidence_ids, '') IS NULL
  ),
  eligibility jsonb NOT NULL,
  candidate_id text,
  canonical_memory_id text,
  occurred_at timestamptz NOT NULL,
  UNIQUE (promotion_id, event_type),
  FOREIGN KEY (
    promotion_id, insight_id, tenant_id, life_did, memory_namespace
  ) REFERENCES insight_promotion_records (
    promotion_id, insight_id, tenant_id, life_did, memory_namespace
  ) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_id) REFERENCES memory_candidates(candidate_id) ON DELETE RESTRICT,
  FOREIGN KEY (canonical_memory_id) REFERENCES memory_heads(memory_id) ON DELETE RESTRICT,
  CHECK (
    jsonb_typeof(approved_by) = 'object'
    AND approved_by->>'lifeDid' = life_did
    AND (
      nullif(btrim(approved_by->>'agentId'), '') IS NOT NULL
      OR nullif(btrim(approved_by->>'runtimeId'), '') IS NOT NULL
      OR nullif(btrim(approved_by->>'deviceId'), '') IS NOT NULL
    )
  ),
  CHECK (
    (event_type = 'approved' AND status = 'approved'
      AND candidate_id IS NULL AND canonical_memory_id IS NULL)
    OR
    (event_type = 'candidate_linked' AND status = 'approved'
      AND candidate_id IS NOT NULL AND canonical_memory_id IS NULL)
    OR
    (event_type = 'committed' AND status = 'committed'
      AND candidate_id IS NOT NULL AND canonical_memory_id IS NOT NULL)
    OR
    (event_type = 'rejected' AND status = 'rejected'
      AND candidate_id IS NULL AND canonical_memory_id IS NULL)
  )
);

CREATE INDEX insight_promotion_events_scope_idx
  ON insight_promotion_events (
    tenant_id, life_did, memory_namespace, promotion_id, occurred_at
  );

CREATE FUNCTION validate_insight_promotion_record_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.insight_id IS DISTINCT FROM NEW.insight_id
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.life_did IS DISTINCT FROM NEW.life_did
      OR OLD.memory_namespace IS DISTINCT FROM NEW.memory_namespace
      OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
      OR OLD.promotion_policy_version IS DISTINCT FROM NEW.promotion_policy_version
      OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
      OR OLD.approval_evidence_ids IS DISTINCT FROM NEW.approval_evidence_ids
      OR OLD.eligibility IS DISTINCT FROM NEW.eligibility
      OR OLD.memory_type IS DISTINCT FROM NEW.memory_type
      OR OLD.semantic_key IS DISTINCT FROM NEW.semantic_key
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'insight promotion immutable fields cannot change';
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status
      AND NOT (OLD.status = 'approved' AND NEW.status = 'committed')
    THEN
      RAISE EXCEPTION 'insight promotion status transition is not monotonic';
    END IF;

    IF OLD.candidate_id IS NOT NULL
      AND OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
    THEN
      RAISE EXCEPTION 'insight promotion candidate linkage cannot change';
    END IF;

    IF OLD.canonical_memory_id IS NOT NULL
      AND OLD.canonical_memory_id IS DISTINCT FROM NEW.canonical_memory_id
    THEN
      RAISE EXCEPTION 'insight promotion canonical linkage cannot change';
    END IF;

    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'insight promotion update time cannot regress';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER insight_promotion_records_monotonic
BEFORE UPDATE ON insight_promotion_records
FOR EACH ROW EXECUTE FUNCTION validate_insight_promotion_record_transition();

CREATE FUNCTION append_insight_promotion_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_event_type text;
  resolved_event_id text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.status IS NOT DISTINCT FROM NEW.status
    AND OLD.candidate_id IS NOT DISTINCT FROM NEW.candidate_id
    AND OLD.canonical_memory_id IS NOT DISTINCT FROM NEW.canonical_memory_id
  THEN
    RETURN NEW;
  END IF;

  resolved_event_type := CASE
    WHEN NEW.status = 'rejected' THEN 'rejected'
    WHEN NEW.status = 'committed' THEN 'committed'
    WHEN NEW.candidate_id IS NOT NULL THEN 'candidate_linked'
    ELSE 'approved'
  END;
  resolved_event_id := 'promevt_' || md5(
    NEW.promotion_id || ':' || resolved_event_type || ':' ||
    coalesce(NEW.candidate_id, '') || ':' || coalesce(NEW.canonical_memory_id, '')
  );

  INSERT INTO insight_promotion_events (
    event_id, promotion_id, insight_id, tenant_id, life_did, memory_namespace,
    event_type, status, approved_by, approval_evidence_ids, eligibility,
    candidate_id, canonical_memory_id, occurred_at
  ) VALUES (
    resolved_event_id, NEW.promotion_id, NEW.insight_id,
    NEW.tenant_id, NEW.life_did, NEW.memory_namespace,
    resolved_event_type, NEW.status, NEW.approved_by,
    NEW.approval_evidence_ids, NEW.eligibility,
    NEW.candidate_id, NEW.canonical_memory_id, NEW.updated_at
  ) ON CONFLICT (promotion_id, event_type) DO NOTHING;

  RETURN NEW;
END;
$$;

INSERT INTO insight_promotion_events (
  event_id, promotion_id, insight_id, tenant_id, life_did, memory_namespace,
  event_type, status, approved_by, approval_evidence_ids, eligibility,
  candidate_id, canonical_memory_id, occurred_at
)
SELECT
  'promevt_' || md5(
    promotion_id || ':' ||
    CASE
      WHEN status = 'rejected' THEN 'rejected'
      WHEN status = 'committed' THEN 'committed'
      WHEN candidate_id IS NOT NULL THEN 'candidate_linked'
      ELSE 'approved'
    END || ':' || coalesce(candidate_id, '') || ':' || coalesce(canonical_memory_id, '')
  ),
  promotion_id, insight_id, tenant_id, life_did, memory_namespace,
  CASE
    WHEN status = 'rejected' THEN 'rejected'
    WHEN status = 'committed' THEN 'committed'
    WHEN candidate_id IS NOT NULL THEN 'candidate_linked'
    ELSE 'approved'
  END,
  status, approved_by, approval_evidence_ids, eligibility,
  candidate_id, canonical_memory_id, updated_at
FROM insight_promotion_records;

CREATE TRIGGER insight_promotion_records_append_event
AFTER INSERT OR UPDATE ON insight_promotion_records
FOR EACH ROW EXECUTE FUNCTION append_insight_promotion_event();

CREATE FUNCTION reject_insight_promotion_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'insight promotion events are append-only';
END;
$$;

CREATE TRIGGER insight_promotion_events_append_only
BEFORE UPDATE OR DELETE ON insight_promotion_events
FOR EACH ROW EXECUTE FUNCTION reject_insight_promotion_event_mutation();

CREATE FUNCTION validate_reflective_insight_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'new reflective insights must start pending';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.life_did IS DISTINCT FROM NEW.life_did
    OR OLD.memory_namespace IS DISTINCT FROM NEW.memory_namespace
    OR OLD.proposition IS DISTINCT FROM NEW.proposition
    OR OLD.epistemic_status IS DISTINCT FROM NEW.epistemic_status
    OR OLD.supporting_memory_ids IS DISTINCT FROM NEW.supporting_memory_ids
    OR OLD.supporting_evidence_ids IS DISTINCT FROM NEW.supporting_evidence_ids
    OR OLD.contradicting_memory_ids IS DISTINCT FROM NEW.contradicting_memory_ids
    OR OLD.confidence IS DISTINCT FROM NEW.confidence
    OR OLD.derivation_provider IS DISTINCT FROM NEW.derivation_provider
    OR OLD.derivation_model IS DISTINCT FROM NEW.derivation_model
    OR OLD.derivation_run_id IS DISTINCT FROM NEW.derivation_run_id
    OR OLD.canonical_write_performed IS DISTINCT FROM NEW.canonical_write_performed
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'reflective insight immutable fields cannot change';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'reflective insight update time cannot regress';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status
    AND NOT (
      (OLD.status = 'pending' AND NEW.status IN ('accepted','rejected','superseded'))
      OR (OLD.status = 'accepted' AND NEW.status = 'superseded')
    )
  THEN
    RAISE EXCEPTION 'reflective insight status transition is not monotonic';
  END IF;

  IF NEW.status = 'accepted' THEN
    IF coalesce((NEW.promotion_eligibility->>'eligible')::boolean, false) IS NOT TRUE
      OR coalesce((NEW.promotion_eligibility->>'evidenceClosure')::boolean, false) IS NOT TRUE
      OR coalesce((NEW.promotion_eligibility->>'requiresExplicitApproval')::boolean, false) IS NOT TRUE
    THEN
      RAISE EXCEPTION 'accepted reflective insight must be evidence-closed and eligible';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM insight_promotion_records promotion
       WHERE promotion.insight_id = NEW.insight_id
         AND promotion.tenant_id = NEW.tenant_id
         AND promotion.life_did = NEW.life_did
         AND promotion.memory_namespace = NEW.memory_namespace
         AND promotion.status IN ('approved','committed')
    ) THEN
      RAISE EXCEPTION 'accepted reflective insight requires a governed promotion record';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reflective_insights_governed_status
BEFORE INSERT OR UPDATE ON reflective_insights
FOR EACH ROW EXECUTE FUNCTION validate_reflective_insight_status_transition();

INSERT INTO dlfm_schema_migrations (migration_name)
VALUES ('0007_insight_promotion_governance.sql');

COMMIT;
