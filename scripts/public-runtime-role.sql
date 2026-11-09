-- Public-profile one-shot role provisioning; run only as the database owner.
-- Disable query/error-statement logging before reading or executing credentials.
\set ECHO none
\set VERBOSITY terse
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_duration = off;
\getenv runtime_password RUNTIME_DATABASE_PASSWORD
SELECT :'runtime_password' ~ '^[0-9a-f]{64}$' AS valid_password \gset
\if :valid_password
\else
  DO $$ BEGIN RAISE EXCEPTION 'Invalid generated runtime password format; review private configuration'; END $$;
\endif
-- Serialize provisioning and preserve the password if the role already exists.
BEGIN;
SELECT pg_advisory_xact_lock(101) AS role_lock \gset
SELECT format('CREATE ROLE mytikas_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mytikas_runtime') \gexec
\unset runtime_password
SELECT EXISTS (
 SELECT 1 FROM pg_roles r WHERE r.rolname='mytikas_runtime'
 AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND NOT r.rolinherit
 AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
 AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner=r.oid)
 AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
 AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba=r.oid)
) AS safe_runtime_role \gset
\if :safe_runtime_role
\else
  DO $$ BEGIN RAISE EXCEPTION 'Runtime role has unsafe privileges or ownership'; END $$;
\endif
\set runtime_role mytikas_runtime
\set database mytikas_public
\ir /scripts/runtime-grants.sql
COMMIT;
