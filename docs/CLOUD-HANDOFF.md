# Cloud handoff

The same Node.js 24 image runs web (`node dist/server.js`), worker (`node dist/worker.js`) and a one-shot migration (`node dist/migrate.js`). `compose.cloud.yaml` describes these processes against externally managed PostgreSQL; it creates neither a database nor a laptop volume and requires no Docker socket inside a container. Use an immutable, tested image reference such as `registry.example/mytikas@sha256:…` for `MYTIKAS_IMAGE`. A tested image has been published and pulled/run against a fresh isolated database; see [exact source and digest evidence](VERIFICATION.md). A managed-provider upgrade/rollback rehearsal remains pending.

Inject `DATABASE_URL` for the runtime role, `MIGRATION_DATABASE_URL` for the owner, a persistent random `SESSION_SECRET` of at least 32 characters, the optional official Discord webhook, `APP_ORIGIN=https://app.mytikas.monster`, and `PUBLIC_SITE_ORIGIN=https://mytikas.monster` through the provider's private secret mechanism. The Compose template accepts these from a private environment file or shell and maps the migration credential only into the one-shot service. Protect the deployer's environment because Compose must interpolate its configuration even when a service is not started. Never commit an environment file, print expanded Compose configuration, or put credentials into the image.

The cloud template requires verified PostgreSQL TLS. Supply the server's trusted CA as `DATABASE_CA_HOST_FILE`; it is mounted read-only into each process. Match the database hostname to its certificate. `DATABASE_TLS=verify-full` fails on untrusted or mismatched certificates. Do not append `sslmode` or other `ssl*` options to the connection URL; ambiguous TLS settings are rejected. For a provider using public system roots, a custom deployment can omit `DATABASE_CA_FILE`. Local isolated test databases explicitly use `DATABASE_TLS=disable`; do not copy that setting into managed-cloud configuration.

## Ingress contract and current limitation

Use an HTTPS reverse proxy sidecar sharing the web process's network namespace (for Compose, `network_mode: service:app`; a pod is another option). Forward to `http://127.0.0.1:8080`, remove incoming forwarded-protocol headers and set `X-Forwarded-Proto: https` yourself. The proxy must be the only externally accessible path. Publish only its HTTPS port. The template intentionally leaves proxy selection, certificates and public routing to the operator. A typical external load balancer reaching the web container's bridge address does **not** satisfy this loopback trust contract; do not solve that by setting broad proxy trust.

`INGRESS_MODE=proxy-loopback` trusts only the immediate loopback peer for secure-cookie detection. It never trusts arbitrary `X-Forwarded-For` client identities. Outside the laptop Cloudflare profile, authentication's IP limit consequently groups clients behind the loopback proxy; the account limit still applies. For larger deployments, add a separately reviewed trusted-edge identity design and regression tests, or account for the shared IP budget at ingress. This kit does not claim scalable per-client limiting for arbitrary cloud load balancers.

Authentication and business APIs stay same-origin; Secure, HttpOnly, host-only, SameSite=Lax session cookies and CSRF checks remain enabled. Do not cache API responses. Only `/api/availability` allows noncredentialed CORS reads from the exact landing origin. `/api/live` indicates a running process; `/api/health` checks the complete migration/checksum set and database access. Use worker `node dist/worker-health.js` for the process's own persisted heartbeat. Both services have a 45-second container grace period, with application/worker shutdown bounded at 30 seconds.

## Database privileges

Create a schema-owning migration role and a separate LOGIN runtime role. The runtime role must have no superuser, database creation, role creation, owner-role membership or ownership privileges. Choose and inject its password privately. Run migrations as the owner, then run the repository's explicit grant template as that owner in the target database:

```sh
psql -X -v ON_ERROR_STOP=1 -v runtime_role=mytikas_runtime -v database=mytikas -f scripts/runtime-grants.sql
```

Configure PostgreSQL connection credentials through private environment/secret files, not command arguments. Review the role/database names for your environment. Run the grants again after migrations that introduce runtime objects; new tables are deliberately not granted automatically. Runtime receives read-only migration metadata, insert-only history/rules, the mutations needed for application/auth/outbox state and housekeeping, plus sequence usage. Database-level roles can still access all applicant rows; application authorization remains responsible for account/staff isolation.

`tests/runtime-role.ts` creates an isolated non-owner role and exercises registration, login/logout, staff approval, rules publication, worker joining/Discord fixture delivery, heartbeats and readiness. It verifies DDL, history deletion and migration-metadata mutation are denied. It does not validate a particular managed PostgreSQL provider's role policy.

## Deployment and rollback

1. Take a verified backup and record the current image digest and schema version. See [recovery](RECOVERY.md).
2. Provision/test external PostgreSQL, verified TLS, role grants and private secret injection. Budget total connections across replicas: `web replicas × DATABASE_POOL_MAX + worker replicas × DATABASE_POOL_MAX`, plus migration and administrative headroom. The default pool maximum is 10 per process; connection waits default to 5 seconds and queries to 15 seconds.
3. Run the migration once using the new image and owner credentials: `docker compose -f compose.cloud.yaml --profile migration run --rm migrate`. Migrations serialize under an advisory lock and fail on checksums that disagree. Legacy checksum adoption requires the separately documented deliberate review.
4. Apply reviewed runtime grants. Start/recreate web and worker with the same image: `docker compose -f compose.cloud.yaml up -d --wait app worker`.
5. Verify readiness, heartbeat, a private smoke account's workflow and outbox status before routing traffic through the HTTPS sidecar. Verify secure cookies and signed-out review deep links through the actual ingress.
6. Record timestamps, image/source identity, schema version, backup location and redacted validation evidence. Monitor process readiness, heartbeat age, pending outbox age/failed jobs, pool/database saturation and backup age.

Start conservatively with one web and one worker and measure memory under simultaneous password hashing before choosing limits; this repository has no measured cloud sizing recommendation. Multiple workers use database claims, but additional processes consume pool capacity. External-service failures should produce job/check status, not be confused with a dead worker.

Readiness currently requires an exact migration set. After an additive migration, the previous image can therefore report unready even if its SQL remains compatible. Do not advertise zero-downtime rolling upgrades or simply revert the image after a schema change. Keep traffic paused until all services run the matching release; rollback may require restoring the pre-upgrade database into a fresh target and accepting the documented loss of writes since that backup. Rehearse this boundary before a public release. Published-image upgrade/rollback rehearsal is still pending.

## Moving from laptop

Preserve both public hostnames. Schedule a maintenance window, stop new writes and workers, take a final private public-profile backup, restore into a fresh managed database, apply owner/runtime roles and verify migration checksums. Transfer necessary session/webhook secrets privately or rotate deliberately; rotating the session secret signs users out. Validate cloud TLS, proxy behavior, staff workflow and worker delivery before switching `app.mytikas.monster` from the laptop tunnel to cloud ingress. Keep GitHub Pages unchanged. Retain the stopped laptop database and previous DNS values for rollback; do not run both writable databases concurrently. Once cloud accepts writes, reverting to the laptop requires explicit reconciliation or data restoration, not only a DNS change.
