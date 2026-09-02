BEGIN;

ALTER TABLE memory_outbox
  ADD COLUMN claimed_by text,
  ADD COLUMN claim_token text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz;

ALTER TABLE memory_outbox
  ADD CONSTRAINT memory_outbox_claim_lease_contract CHECK (
    (
      status = 'PROCESSING'
      AND claimed_by IS NOT NULL
      AND length(btrim(claimed_by)) > 0
      AND claim_token IS NOT NULL
      AND length(btrim(claim_token)) > 0
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      status <> 'PROCESSING'
      AND claimed_by IS NULL
      AND claim_token IS NULL
      AND lease_expires_at IS NULL
    )
  );

CREATE INDEX memory_outbox_ready_scope_idx
  ON memory_outbox (
    tenant_id,
    life_did,
    memory_namespace,
    next_attempt_at,
    created_at,
    outbox_id
  )
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX memory_outbox_expired_lease_scope_idx
  ON memory_outbox (
    tenant_id,
    life_did,
    memory_namespace,
    lease_expires_at,
    created_at,
    outbox_id
  )
  WHERE status = 'PROCESSING';

CREATE INDEX memory_outbox_unfinished_memory_revision_idx
  ON memory_outbox (memory_id, revision)
  WHERE status <> 'DONE';

CREATE INDEX provider_materializations_memory_provider_idx
  ON provider_materializations (memory_id, provider_name);

COMMIT;
