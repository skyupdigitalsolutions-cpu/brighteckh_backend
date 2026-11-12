-- 022_file_uploads.sql
--
-- G4 (frontend build, 12 Nov 2026): every photo/evidence gate (BR-02 unit photo, BR-03 inspection
-- media, BR-06 GRN photo, BR-09 case evidence, BR-11 packing photo) takes a caller-supplied
-- `file_uri`, but nothing stored the file. This adds the metadata table behind POST /api/uploads.
-- The bytes live on the API host's disk (UPLOAD_DIR); this row is the authority for who may read
-- them (company scope) and what they are (type, size, SHA-256).
--
-- ADDITIVE ONLY: no existing table, trigger or function is changed. The existing media endpoints
-- still accept any file_uri; they do NOT require it to reference this table.

CREATE TABLE file_uploads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES legal_entities(id),
  uploaded_by_id uuid NOT NULL REFERENCES employees(id),
  original_name  varchar(255) NOT NULL CHECK (NULLIF(btrim(original_name),'') IS NOT NULL),
  content_type   varchar(100) NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  sha256         char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key    text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_uploads_company_created_idx ON file_uploads (company_id, created_at DESC);

-- The uploader must belong to the company the file is filed under.
CREATE OR REPLACE FUNCTION file_uploads_guard_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = NEW.uploaded_by_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'uploader does not belong to this company';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_file_uploads_guard_insert BEFORE INSERT ON file_uploads
  FOR EACH ROW EXECUTE FUNCTION file_uploads_guard_insert();

-- Append-only: an upload is evidence; it is never edited or deleted through the database.
CREATE OR REPLACE FUNCTION file_uploads_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'file_uploads is append-only';
END $$;
CREATE TRIGGER trg_file_uploads_immutable BEFORE UPDATE OR DELETE ON file_uploads
  FOR EACH ROW EXECUTE FUNCTION file_uploads_immutable();

COMMENT ON TABLE file_uploads IS
  'Uploaded file metadata (G4). Bytes on API-host disk under UPLOAD_DIR/storage_key. Read access is company-scoped. Append-only.';
