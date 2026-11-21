CREATE TABLE addon_files (
  id uuid PRIMARY KEY,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  filename text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  notes text NOT NULL CHECK (octet_length(notes) <= 2048),
  file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  byte_size integer GENERATED ALWAYS AS (octet_length(content)) STORED,
  sha256 text GENERATED ALWAYS AS (encode(sha256(content), 'hex')) STORED
);
