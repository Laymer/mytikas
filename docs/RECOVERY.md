# Backup and recovery

Back up before upgrades and after each showcase session. Keep `.env.public` and the tunnel token separately from database backups; a database backup contains password hashes, email addresses, sessions and application text. Files belong outside Git and public artifacts. The backup helper creates files with mode 600, refuses overwrites and removes incomplete output after failure.

```sh
node scripts/public.mjs backup backups/before-upgrade.dump
```

The public database has no host port. Restore through the existing database container; this works while web/worker/tunnel are stopped and does not route visitors to the restored copy:

```sh
node scripts/restore.mjs backups/before-upgrade.dump --public
```

The command prints a new database name such as `mytikas_restore_...`. It verifies the custom-format archive first, creates a fresh target and restores in one transaction. It does not change the running application's database selection. Use the copy for inspection and recovery validation first. Restore failures leave an empty target for inspection; they do not overwrite the source. Restore omits original ownership and ACLs, so apply the intended runtime grants after restoring into managed PostgreSQL.

For native PostgreSQL 18 client tools, privately set `RESTORE_DATABASE_URL` to an administrative PostgreSQL connection (createdb privilege required) and run:

```sh
node scripts/restore.mjs backups/before-upgrade.dump
```

Keep credentials out of shell history: use a private environment file and Node's `--env-file` option. TLS is explicit: `DATABASE_TLS=verify-full`, optionally `DATABASE_CA_FILE=/private/provider-ca.pem`. URL SSL parameters are rejected. Client tools use environment credentials, never command-line passwords. `PG_BIN_DIR` optionally selects the PostgreSQL client binary directory.

To replace the public database, first stop exposure and application writers. The following replacement is destructive and forcibly disconnects existing target sessions; it is only appropriate after validating the backup and retaining a fresh backup of the current database:

```sh
node scripts/public.mjs stop
# Start only the database, leaving web/worker/tunnel stopped.
docker compose --project-name mytikas-public --env-file .env.public -f compose.public.yaml up -d db
node scripts/restore.mjs backups/before-upgrade.dump --public --database mytikas_public --replace
node scripts/public.mjs up
```

Without `--replace`, any existing target is refused. `--replace` requires an explicit target name. System databases are always refused. Public helper commands preserve the volume. Never use `down --volumes` as a recovery step.

## Verified recovery drill

`tests/recovery.ts` starts isolated PostgreSQL, registers an applicant, dumps the database, restores into a fresh database, runs migrations, starts the restored application and authenticates with the original password. It compares applications, immutable submissions/events, users, rules and outbox records. It verifies restrictive backup permissions, overwrite refusal, system-database refusal and explicit replacement of only the isolated restored target. Run with PostgreSQL 18 `pg_dump`, `pg_restore` and `psql` on PATH:

```sh
node --import tsx tests/recovery.ts
```

The native drill was executed locally using PostgreSQL 18.6 client tools. Public-container restore and off-laptop/cloud recovery still require their own operational rehearsal; passing the native drill is not live cutover evidence.

## Encrypted off-laptop copy

Encrypt the dump before transferring it to private storage on another device. With GnuPG installed, `gpg --symmetric --cipher-algo AES256 backups/before-upgrade.dump` prompts for a passphrase without putting it in arguments. Store that passphrase separately. Transfer only the encrypted `.gpg` file, verify its checksum at the destination, and rehearse decrypting a copy into a private directory followed by a fresh-target restore. Keep at least one known-good backup from before the latest migration. This copy procedure requires a user-managed destination and has not been exercised against a live backup here.

## Incidents and rollback

- **Failed migration:** stop rollout, keep the old image available, inspect redacted migration errors and preserve the backup. Migrations run under an advisory lock in one transaction. Never edit applied SQL. Investigate checksum mismatches against the tested source; `ADOPT_MIGRATION_CHECKSUMS=1` is only for reviewed legacy adoption, not a mismatch bypass.
- **Application rollback:** restore the preceding immutable image for web and worker, recreate the tunnel with the web container, and check schema readiness. Use the old image only when compatible with the current schema. A schema rollback requires restoring the backup and loses writes made since it; keep traffic stopped until that boundary is accepted.
- **Session-secret rotation:** update the private environment file and recreate app/worker/tunnel with `public up`. Existing sessions become invalid; users sign in again. Preserve database credentials unless deliberately rotating them.
- **Database-password rotation:** changing the Compose environment alone does not change the existing PostgreSQL role. Stop application writers, change the role password using an interactive private PostgreSQL session, update `.env.public`, then recreate services and check readiness. Never put the new password in command arguments or logs.
- **Webhook/tunnel rotation:** revoke the old credential in its provider, update the private webhook environment or tunnel-token file, and recreate affected services. Keep the tunnel token out of `.env` interpolation and command arguments.
- **Outbox recovery:** delivery is at least once. A crash after Discord accepts a request but before its database acknowledgement may produce a duplicate. Compare submission IDs/revisions when reviewing duplicates. Expired leases recover automatically. A `FAILED` job remains visible to staff; after fixing the webhook/rate issue, an operator can explicitly reset only a reviewed job to `PENDING`, set attempts to zero and clear its lease. This may duplicate a previously accepted message. Do not reset all jobs or delete immutable submissions.
- **Worker health:** `node dist/worker-health.js` checks the local process ID file against a heartbeat younger than 45 seconds. Temporary Discord/Armory errors do not kill the process; inspect delivery status and lane-failure logs as well. Notification and Armory scheduling are independent. SIGTERM stops new claims and drains; a 30-second deadline exits with failure, inside the 45-second container grace period.

## One-time upgrade of existing local/demo databases

The original two migrations had no checksum column. Back up each existing stack before upgrading (`./mytikas.sh backup` or `./mytikas.sh demo backup`). Compare the applied migration names and original SQL against the audited repository version. Only after confirming they match, run the appropriate one-shot adoption command from the repository directory:

```sh
# Normal local stack; database must be running.
docker compose --project-name mytikas --env-file .env -f compose.yaml run --rm --build -e ADOPT_MIGRATION_CHECKSUMS=1 migrate

# Seeded demo stack; separate environment, project and database.
docker compose --project-name mytikas-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml run --rm --build -e ADOPT_MIGRATION_CHECKSUMS=1 migrate
```

Then resume with `./mytikas.sh up` or `./mytikas.sh demo up`. The one-shot flag is not saved. Prefixing the helper with `ADOPT_MIGRATION_CHECKSUMS=1` is insufficient because Compose does not forward that ambient variable. Fresh public databases need no adoption. A recorded non-null checksum mismatch always fails, even when adoption is enabled; investigate instead of rewriting migration files.

## Email and roster state

Migration 004 tables (`email_tokens`, `email_jobs`, `email_limits`, `class_jobs`, `rosters`, `roster_slots`) are included in full database dumps. Preserve `EMAIL_OUTBOX_KEY` separately with the protected environment secrets, alongside SMTP settings. The machine transfer allowlist includes these settings. Losing the key makes pending mail unreadable; cancel affected jobs and request new links only after installing a new key. Never include decrypted payloads in recovery logs.

Restore the database, matching application version and original outbox key together, then reapply runtime grants. Expired leases recover automatically and expired link payloads are discarded. SMTP acknowledgement can be lost during a crash, so duplicate delivery is possible; consumed tokens cannot be reused. Restore testing must verify activation exemptions, session versions, membership history, roster revisions and cleared assignments, in addition to the existing application checks. Keep backups encrypted and access-controlled: restored snapshots may contain old token jobs and passwords.

Migration 004 changes the schema contract. Rolling back only the image to a pre-004 version is unsupported: its readiness check rejects the additional migration. Quiesce writers and retain a pre-upgrade database snapshot before rollout. Rollback requires restoring that snapshot with the matching old image, grants and secrets; changes made after the snapshot would be lost. Prefer a forward fix when new registrations or roster changes have already been accepted. The cloud rehearsal now verifies this explicit snapshot-based rollback against the previous published image.
