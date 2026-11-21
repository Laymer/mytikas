-- Run as migration owner in the target DB after every migration:
-- psql -X -v ON_ERROR_STOP=1 -v runtime_role=mytikas_runtime -v database=mytikas -f scripts/runtime-grants.sql
-- Create the LOGIN role securely beforehand; never give it membership in the owner role.
-- This explicit grant list deliberately does not grant privileges on future tables.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT CONNECT ON DATABASE :"database" TO :"runtime_role";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"runtime_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"runtime_role";
GRANT SELECT ON migrations TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON applications, discord_jobs TO :"runtime_role";
-- Public registration, first-admin bootstrap and account-management fields only.
GRANT SELECT (id, email, password_hash, role, created_at, email_verified_at, activation_exempt, auth_version, recovery_email),
  INSERT (email, password_hash, role, activation_exempt),
  UPDATE (email, password_hash, role, email_verified_at, auth_version) ON users TO :"runtime_role";
GRANT SELECT, INSERT ON rules, submissions, events, role_events TO :"runtime_role";
GRANT SELECT, UPDATE ON discord_delivery_state TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, auth_limits, worker_heartbeats, email_tokens, email_jobs, email_limits, class_jobs TO :"runtime_role";
GRANT SELECT, UPDATE ON rosters, roster_slots TO :"runtime_role";
GRANT USAGE ON SEQUENCE rules_id_seq, events_id_seq, role_events_id_seq TO :"runtime_role";
-- Migration 005 member integration tables
GRANT SELECT, INSERT ON addon_releases TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON blacklist_reports, blacklist_checkpoint, blacklist_checks, blacklist_warnings TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_links, discord_states TO :"runtime_role";
GRANT USAGE ON SEQUENCE blacklist_warnings_id_seq TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON integration_health TO :"runtime_role";
-- Admins may change visibility after publication. The bytes remain immutable.
GRANT SELECT, INSERT ON addon_files TO :"runtime_role";
GRANT UPDATE (visibility) ON addon_files TO :"runtime_role";
