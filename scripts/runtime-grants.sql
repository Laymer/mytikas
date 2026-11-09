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
GRANT SELECT, INSERT, UPDATE ON users, applications, discord_jobs TO :"runtime_role";
GRANT SELECT, INSERT ON rules, submissions, events, role_events TO :"runtime_role";
GRANT SELECT, UPDATE ON discord_delivery_state TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, auth_limits, worker_heartbeats TO :"runtime_role";
GRANT USAGE ON SEQUENCE rules_id_seq, events_id_seq, role_events_id_seq TO :"runtime_role";
