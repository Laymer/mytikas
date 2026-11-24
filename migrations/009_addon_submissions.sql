CREATE TABLE addon_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL UNIQUE,
  notes text NOT NULL CHECK (octet_length(notes) <= 2048 AND notes ~ '[^[:space:]]'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archive bytea CHECK (
    archive IS NULL OR (
      octet_length(archive) BETWEEN 1 AND 8000000 AND
      encode(sha256(archive), 'hex') = sha256
    )
  ),
  submitted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','stored','review','blocked','closed','published')),
  archive_id bigint UNIQUE,
  pr_number bigint,
  detail text,
  curseforge_file_id bigint,
  CHECK (archive IS NOT NULL OR archive_id IS NOT NULL)
);
