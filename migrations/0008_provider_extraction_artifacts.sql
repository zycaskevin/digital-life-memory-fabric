BEGIN;

ALTER TABLE memory_distillation_receipts
  ADD COLUMN provider_extraction_ref text,
  ADD COLUMN provider_extraction_checksum text,
  ADD CONSTRAINT memory_distillation_receipts_provider_extraction_pair_check CHECK (
    (provider_extraction_ref IS NULL AND provider_extraction_checksum IS NULL)
    OR (
      nullif(btrim(provider_extraction_ref), '') IS NOT NULL
      AND provider_extraction_checksum ~ '^sha256:[0-9a-f]{64}$'
    )
  );

CREATE FUNCTION validate_distillation_receipt_provider_extraction_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.provider_extraction_ref IS NOT NULL THEN
    IF NEW.provider_extraction_ref IS DISTINCT FROM OLD.provider_extraction_ref
      OR NEW.provider_extraction_checksum IS DISTINCT FROM OLD.provider_extraction_checksum
    THEN
      RAISE EXCEPTION 'provider extraction artifact binding is immutable once recorded';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_distillation_receipts_provider_extraction_immutable
BEFORE UPDATE ON memory_distillation_receipts
FOR EACH ROW EXECUTE FUNCTION validate_distillation_receipt_provider_extraction_binding();

INSERT INTO dlfm_schema_migrations (migration_name)
VALUES ('0008_provider_extraction_artifacts.sql');

COMMIT;
