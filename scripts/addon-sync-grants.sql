-- Invoked independently in the app and archive clusters. The worker cannot own tables.
\set ECHO none
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_duration = off;
\getenv password SYNC_PASSWORD
BEGIN;
SELECT pg_advisory_xact_lock(523246120) AS locked \gset
SELECT format('CREATE ROLE mytikas_sync LOGIN NOINHERIT PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mytikas_sync') \gexec
-- Cluster roles are provisioned separately after a pg_restore --no-privileges.
SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
 AND rolcanlogin AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = pg_roles.oid)
 AND NOT EXISTS (SELECT FROM pg_class WHERE relowner = pg_roles.oid)
 AND NOT EXISTS (SELECT FROM pg_namespace WHERE nspowner = pg_roles.oid)
 AND NOT EXISTS (SELECT FROM pg_database WHERE datdba = pg_roles.oid)
 AS safe FROM pg_roles WHERE rolname='mytikas_sync' \gset
\if :safe
\else
 DO $$ BEGIN RAISE EXCEPTION 'Unsafe synchronizer login'; END $$;
\endif
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mytikas_sync;
\if :archive
 GRANT SELECT, INSERT, UPDATE(pr_number, merge_commit, release_id, receipt_checked_at, curseforge_file_id) ON archives TO mytikas_sync;
 GRANT USAGE, SELECT ON SEQUENCE archives_id_seq TO mytikas_sync;
\else
 GRANT SELECT(id, version, notes, sha256, archive, status, archive_id, pr_number, detail, curseforge_file_id),
   UPDATE(archive, status, archive_id, pr_number, detail, curseforge_file_id)
   ON addon_submissions TO mytikas_sync;
 GRANT SELECT, INSERT ON addon_releases TO mytikas_sync;
\endif
COMMIT;
