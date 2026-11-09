# Public laptop operations

The public deployment is a separate Compose project (`mytikas-public`), private environment (`.env.public`) and persistent volume (`mytikas-public_public-postgres-data`). It publishes no host ports. Normal development and the seeded demo keep their existing projects and credentials. Never run the demo seed against this database.

Use a Node.js 24 shell inside WSL2, with Docker Desktop running and WSL integration enabled for that distribution. Keep the checkout in the Linux filesystem so restrictive file permissions work. Laptop sleep, Windows restart, WSL shutdown and Docker shutdown interrupt application access; GitHub Pages remains available. Configure power/startup settings manually if desired; these scripts do not change them.

```sh
node scripts/public.mjs init
```

This preserves existing credentials and creates independent random database-owner, runtime-database and session secrets. For an older `.env.public`, `init` appends only the missing `RUNTIME_DATABASE_PASSWORD`, preserving all previous bytes and credentials; it never replaces an existing runtime key. Run `init` once when upgrading an earlier public profile. Open `.env.public` in a private editor to set the staff webhook. Paste the named Cloudflare Tunnel token into `.public/tunnel-token`, retaining mode 600. The token is mounted as a file and never passed in command arguments. The generated UID/GID lets the unprivileged connector read that file. Both files and `.public/` are excluded from Git and build context.

Create a remotely managed named tunnel in Cloudflare with exactly one public hostname: `app.mytikas.monster`, service `http://127.0.0.1:8080`. Do not add a Cloudflare Access login policy for applicants. The connector shares the application network namespace, so loopback reaches Express; only this immediate peer is trusted. Cloudflare supplies the original client IP for authentication limits. See [Cloudflare's token-file parameter](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/). The connector is pinned to `2026.10.7`; update deliberately after testing.

```sh
node scripts/public.mjs doctor
node scripts/public.mjs up
node scripts/public.mjs admin
node scripts/public.mjs status
node scripts/public.mjs logs
node scripts/public.mjs backup
node scripts/public.mjs stop
```

`doctor` checks local prerequisites and private files; it cannot prove the remote DNS/tunnel route is correct. `up` removes the old tunnel before updating the app, waits for owner migrations, explicit runtime grants and app health, then recreates the tunnel in the new namespace. Always use `up` after rebuilding; avoid replacing `app` alone. Startup can succeed locally before DNS is configured; verify `https://app.mytikas.monster/api/availability` separately. Bootstrap an administrator, sign in and publish the actual guild rules before sharing recruitment links.

`backup [path]` produces a private custom-format PostgreSQL dump and refuses overwrites. Failed dumps are removed. Back up before upgrades and after showcase sessions; copy backups to encrypted off-laptop storage. Backups contain account data and password hashes, so do not commit or share them publicly. Restore instructions and a tested recovery drill remain release prerequisites.

`down` removes this project's containers and network while preserving its data volume. There is intentionally no volume-deletion option. `stop` immediately removes public access while preserving containers and data. Restart Docker/WSL as needed and run `up` to recover. Never delete the public volume as a troubleshooting step.

The application and worker connect as `mytikas_runtime`, a non-owner role without superuser, role/database creation or schema creation privileges. The existing `POSTGRES_PASSWORD` belongs to the database owner and is passed only to PostgreSQL, migrations and the one-shot `runtime-grants` service. After migrations, that service creates the missing runtime role from the generated 64-character hexadecimal secret and applies `scripts/runtime-grants.sql`. It never changes an existing role's password, and refuses an existing role with unsafe privileges, memberships or ownership. Password-bearing provisioning SQL is executed only after statement/error-statement/duration logging is disabled in that session; credentials are passed through private environment variables, never command arguments. Do not enable additional statement-auditing extensions for this provisioning session without reviewing their handling of credentials.

Secrets are immutable once PostgreSQL initializes: changing only `POSTGRES_PASSWORD` in the file does not update database credentials. Coordinate database credential rotation with PostgreSQL and take a backup first. To rotate the runtime credential, stop the public application/tunnel, choose a fresh 64-character hexadecimal password privately, change the `mytikas_runtime` password through an owner `psql` session using its hidden `\password mytikas_runtime` prompt, update `RUNTIME_DATABASE_PASSWORD` in the private environment, then run `up`. Do not put the password into shell/SQL command arguments or logs. Changing only the environment does not rotate the database role: the grants service preserves the existing password and application readiness fails until the credentials agree. Rotating `SESSION_SECRET` signs everyone out. Rotate the tunnel token in Cloudflare, replace its file privately, then run `up`. Replace the webhook in Discord and the private environment before running `up`.

Local validation covers Compose structure and helper behavior with a fake Docker executable, including isolation, credential preservation, tunnel/app replacement order, no-volume-deletion arguments and backup failures. `node tests/public-container.mjs` additionally builds the real containers in a randomized isolated project, verifies migration/web/worker readiness and absence of published ports, verifies runtime app/worker privileges and denied DDL/history/migration writes, checks provisioning preserves an existing password even when configuration differs, then recreates app/worker and verifies database persistence before deleting only its test volume. It does not start a tunnel or send live notifications. Live tunnel connectivity, WSL restart and external acceptance must be recorded separately; no fixture test establishes these outcomes.

Backup and fresh-target restore commands, recovery drill evidence, and rotation procedures: [Recovery](RECOVERY.md).

The same commands are available through the main helper: `./mytikas.sh public init`, `./mytikas.sh public doctor`, `./mytikas.sh public up` and the other public subcommands delegate to the isolated Node helper.
