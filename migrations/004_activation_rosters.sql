ALTER TABLE users ADD COLUMN email_verified_at timestamptz,
 ADD COLUMN activation_exempt boolean NOT NULL DEFAULT false,
 ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
UPDATE users SET activation_exempt=true;
ALTER TABLE applications DROP CONSTRAINT applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK(status IN ('PENDING_EMAIL','SUBMITTED','APPROVED','REJECTED','REOPENED','JOINED','REMOVED'));
ALTER TABLE applications ADD COLUMN armory_class text, ADD COLUMN class_override text,
 ADD COLUMN class_checked_at timestamptz, ADD COLUMN class_result text;
CREATE TABLE email_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 purpose text NOT NULL CHECK(purpose IN ('VERIFY','RESET')), digest text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 token_id uuid REFERENCES email_tokens, payload text,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DELIVERED','CANCELLED','FAILED')),
 expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_jobs_due ON email_jobs(available_at) WHERE status='PENDING';
CREATE TABLE email_limits (key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL, last_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE class_jobs (
 application_id uuid PRIMARY KEY REFERENCES applications, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz
);
INSERT INTO class_jobs(application_id) SELECT id FROM applications WHERE status='JOINED';
CREATE FUNCTION queue_joined_class() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='JOINED' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
 INSERT INTO class_jobs(application_id) VALUES (NEW.id) ON CONFLICT(application_id) DO UPDATE SET available_at=now(), attempts=0, lease_token=NULL, lease_until=NULL;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER joined_class AFTER INSERT OR UPDATE OF status ON applications FOR EACH ROW EXECUTE FUNCTION queue_joined_class();
CREATE TABLE rosters (size integer PRIMARY KEY CHECK(size IN (10,20,40)), revision integer NOT NULL DEFAULT 0);
INSERT INTO rosters(size) VALUES(10),(20),(40);
CREATE TABLE roster_slots (
 roster_size integer NOT NULL REFERENCES rosters, position integer NOT NULL CHECK(position>=0 AND position<roster_size),
 role text NOT NULL CHECK(role IN ('TANK','HEALER','DPS')), application_id uuid REFERENCES applications,
 PRIMARY KEY(roster_size,position), UNIQUE(roster_size,application_id)
);
INSERT INTO roster_slots(roster_size,position,role)
 SELECT size,p,CASE WHEN p<CASE size WHEN 10 THEN 2 WHEN 20 THEN 3 ELSE 4 END THEN 'TANK'
 WHEN p<CASE size WHEN 10 THEN 5 WHEN 20 THEN 8 ELSE 15 END THEN 'HEALER' ELSE 'DPS' END
 FROM rosters CROSS JOIN LATERAL generate_series(0,size-1) p;
