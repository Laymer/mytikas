# Public prototype contracts

The public landing origin is `https://mytikas.monster`; the account and API origin is `https://app.mytikas.monster`. Pages contains only landing content. Accounts, staff pages and APIs run together on the laptop. Public PostgreSQL uses a separate Compose project and volume. Normal local and seeded demo configurations remain independent.

Only `/api/availability` permits anonymous, noncredentialed cross-origin reads from the configured landing origin. It must not establish a session. `/api/live` checks the process; `/api/health` checks database/schema readiness. Secure, host-only, HttpOnly, SameSite=Lax session cookies and CSRF checks remain required. Discord review links are configured-origin URLs with an application hash; validated local return paths preserve these through login.

Cloudflare ingress shares the app network namespace and reaches loopback. Public services publish no host ports. Only loopback ingress is trusted in this explicit profile; forwarded client identity is not trusted in local mode. A replacement app requires replacement of the tunnel container.

Use Node 24, Express, TypeScript, plain browser JavaScript and PostgreSQL. Web, migration and worker commands are separate entrypoints in one image. External PostgreSQL supports `DATABASE_TLS=verify-full`, optional `DATABASE_CA_FILE`, `DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_MS`, and `DATABASE_QUERY_TIMEOUT_MS`. URL SSL parameters are rejected to prevent overriding certificate verification.

Migrations are immutable and serialized with an advisory lock. Existing installations with the original checksum-free migration table must compare their applied SQL against the repository before running once with `ADOPT_MIGRATION_CHECKSUMS=1`. Remove that setting afterward. A mismatch aborts the transaction. Never edit an applied migration to repair a mismatch.

The coordinator owns package scripts, CI, migrations reservations and integration. Subsystem tests should have independent entrypoints. Reservation: 003 is worker heartbeat. Feature branches depend on the contract branch and must include tests and tracker IDs. Independent review precedes merging. Only the initial audited empty-repository bootstrap may publish without a PR; all subsequent merges require `ci-required` and resolved conversations, without requiring a second human approver.

Public acceptance requires a real external-network registration, Discord delivery, signed-out review-link login, staff decisions, resubmission history, joining, outage/restart persistence and backup recovery. Record timestamp, browser/device, commit/image digest and redacted evidence. Fixture results are not live acceptance. Coverage is measured separately for backend, browser and Node utilities; 95% is aspirational and never implied by passing tests.
