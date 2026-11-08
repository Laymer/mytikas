-- A webhook-wide cooldown also covers submissions created during a Discord rate limit.
CREATE TABLE discord_delivery_state (
 id integer PRIMARY KEY CHECK (id=1),
 not_before timestamptz NOT NULL DEFAULT now()
);
INSERT INTO discord_delivery_state(id) VALUES (1);
