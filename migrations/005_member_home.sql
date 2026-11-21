ALTER TABLE applications DROP CONSTRAINT applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK(status IN
 ('PENDING_EMAIL','SUBMITTED','APPROVED','REJECTED','REOPENED','JOINED','REMOVED','BLACKLISTED'));
CREATE TABLE blacklist_reports (
 message_id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL,
 reporter_id text NOT NULL, reported_at timestamptz NOT NULL, character_name text NOT NULL,
 character_key text NOT NULL, reason text NOT NULL, voided_at timestamptz,
 voided_by uuid REFERENCES users, correction text
);
CREATE INDEX blacklist_active ON blacklist_reports(character_key) WHERE voided_at IS NULL;
CREATE TABLE blacklist_checkpoint(channel_id text PRIMARY KEY, last_id text NOT NULL);
CREATE TABLE blacklist_checks(character_key text PRIMARY KEY, scan_day date NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(), result text NOT NULL, present boolean NOT NULL DEFAULT false);
CREATE TABLE blacklist_warnings(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 character_key text NOT NULL, character_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 after_id text, delivered_id text);
CREATE TABLE addon_releases(version text PRIMARY KEY, published_at timestamptz NOT NULL,
 notes text NOT NULL, sha256 text NOT NULL, archive bytea NOT NULL);
CREATE TABLE discord_links(user_id uuid PRIMARY KEY REFERENCES users, discord_id text NOT NULL UNIQUE, username text NOT NULL);
CREATE TABLE discord_states(user_id uuid PRIMARY KEY REFERENCES users, session_hash text NOT NULL,
 state text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE integration_health(lane text PRIMARY KEY, succeeded_at timestamptz NOT NULL);
