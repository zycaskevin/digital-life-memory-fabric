BEGIN;

ALTER TABLE semantic_review_cases
  DROP CONSTRAINT IF EXISTS semantic_review_cases_latest_disposition_check;

ALTER TABLE semantic_review_cases
  ADD CONSTRAINT semantic_review_cases_latest_disposition_check CHECK (
    latest_disposition IS NULL OR latest_disposition IN (
      'approved_as_classified','confirmed_contradiction','confirmed_unrelated',
      'misclassified','invalid_candidate','needs_more_evidence','policy_superseded'
    )
  );

ALTER TABLE semantic_review_events
  DROP CONSTRAINT IF EXISTS semantic_review_events_disposition_check;

ALTER TABLE semantic_review_events
  ADD CONSTRAINT semantic_review_events_disposition_check CHECK (
    disposition IS NULL OR disposition IN (
      'approved_as_classified','confirmed_contradiction','confirmed_unrelated',
      'misclassified','invalid_candidate','needs_more_evidence','policy_superseded'
    )
  );

INSERT INTO dlfm_schema_migrations (migration_name)
VALUES ('0009_semantic_review_policy_supersession.sql');

COMMIT;
