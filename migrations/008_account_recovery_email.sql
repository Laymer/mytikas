-- Only a trusted operator may set a separate mailbox for password recovery.
ALTER TABLE users ADD COLUMN recovery_email text CHECK (
  recovery_email = lower(btrim(recovery_email))
  AND char_length(recovery_email) <= 254
  AND recovery_email ~ '^[^@[:space:][:cntrl:]<>,;:"]+@[^@[:space:][:cntrl:]<>,;:"]+\.[^@[:space:][:cntrl:]<>,;:"]+$'
);
