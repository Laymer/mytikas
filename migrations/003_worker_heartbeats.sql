-- Each process has its own heartbeat; health checks select the local process ID file.
CREATE TABLE worker_heartbeats (
 id uuid PRIMARY KEY,
 updated_at timestamptz NOT NULL DEFAULT now()
);
