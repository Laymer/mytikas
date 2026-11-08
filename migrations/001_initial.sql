CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','MODERATOR','ADMIN')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expire);
CREATE TABLE rules (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
 prototype boolean NOT NULL DEFAULT false, actor_id uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES users,
 character_name text NOT NULL, character_key text NOT NULL UNIQUE,
 status text NOT NULL CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','REOPENED','JOINED')),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_check_at timestamptz, check_result text, next_check_at timestamptz, check_token uuid, check_started_at timestamptz,
 joined_via text CHECK (joined_via IN ('ARMORY','MANUAL'))
);
CREATE INDEX applications_due ON applications(next_check_at) WHERE status = 'APPROVED';
CREATE TABLE submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL REFERENCES applications,
 revision integer NOT NULL, character_name text NOT NULL, character_key text NOT NULL,
 motivation text NOT NULL CHECK (char_length(btrim(motivation)) BETWEEN 1 AND 300),
 rules_id integer NOT NULL REFERENCES rules, accepted_at timestamptz NOT NULL DEFAULT now(),
 actor_id uuid NOT NULL REFERENCES users, UNIQUE(application_id, revision)
);
CREATE TABLE events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, application_id uuid NOT NULL REFERENCES applications,
 actor_id uuid REFERENCES users, from_status text, to_status text NOT NULL,
 method text NOT NULL, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE role_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES users,
 actor_id uuid NOT NULL REFERENCES users, old_role text NOT NULL, new_role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE discord_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submission_id uuid NOT NULL UNIQUE REFERENCES submissions,
 status text NOT NULL CHECK (status IN ('PENDING','DELIVERED','DISABLED','FAILED')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE INDEX discord_jobs_due ON discord_jobs(available_at) WHERE status = 'PENDING';
CREATE TABLE auth_limits (key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE FUNCTION prevent_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'History is immutable'; END;
$$;
CREATE TRIGGER immutable_rules BEFORE UPDATE OR DELETE ON rules FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
CREATE TRIGGER immutable_submissions BEFORE UPDATE OR DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
CREATE TRIGGER immutable_role_events BEFORE UPDATE OR DELETE ON role_events FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
INSERT INTO rules(content, prototype) VALUES (E'PROTOTYPE RULES — draft for local testing; replace before opening recruitment.\n\n1. Treat fellow players respectfully. Harassment and discrimination are not welcome.\n2. Do not cheat, exploit, bot, or use prohibited automation.\n3. Follow guild leadership and agreed group instructions. Raise concerns respectfully.\n\nStaff verify character ownership during review or invitation. An armory match confirms membership only.', true);
