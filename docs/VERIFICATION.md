# Verified implementation artifacts — 2026-11-09

This is implementation verification, **not external showcase acceptance**. Cloudflare, the live webhook, custom-domain cutover and P16 acceptance remain pending.

- Public protected repository: https://github.com/Laymer/mytikas
- Implementation PRs: [#2](https://github.com/Laymer/mytikas/pull/2), [#3](https://github.com/Laymer/mytikas/pull/3).
- Tested source: `a34e91ab4b6440be91e9c1fa70d2b7256182abd0`.
- Successful main CI and artifact publication: [run 42596051826](https://github.com/Laymer/mytikas/actions/runs/42596051826).
- Landing preview: https://laymer.github.io/mytikas/ — index, stylesheet, crest, summit image and landing script returned HTTP 200; generated HTML links to the application origin and contains no password form. Pages artifact is from the same successful run. No custom domain is assigned to this new Pages site.
- Published image: `ghcr.io/laymer/mytikas:a34e91ab4b6440be91e9c1fa70d2b7256182abd0`.
- Immutable reference: `ghcr.io/laymer/mytikas@sha256:5c4e8aafcd24f1efeb2588b11e7ba3ce9b9cd0de19e3d292a3ebdf9bc6bd91ac`.
- Migration set: `001_initial.sql`, `002_discord_delivery_gate.sql`, `003_worker_heartbeats.sql`, with SHA256 records enforced.

The published digest was pulled locally, without a new registry login, then run with `--no-build` against fresh PostgreSQL in a randomized isolated Compose project. Migrations completed, `/api/health` returned `{ "ready": true }`, and the process-specific worker health command succeeded. Test containers and their dedicated volume were removed afterward. No real tunnel, webhook, administrator or applicant account was configured by this smoke test. A separately hosted managed-provider deployment remains deferred.

CI passed typechecking, ShellCheck, runtime dependency audit, integration/demo, ingress security, migration/TLS-failure checks, non-owner runtime privileges, worker/Discord fixtures, helpers, source-verified coverage gates, Chromium/Firefox/WebKit, certificate-pinned two-host HTTPS smoke, container recreation/persistence and PostgreSQL backup/restore/authentication/history recovery. Image publication loaded the exact image archive produced by the container smoke job; it did not rebuild an untested image.

| Layer | Lines | Statements | Functions | Branches |
|---|---:|---:|---:|---:|
| Backend including demo | 87.00% | 87.00% | 91.37% | 82.90% |
| Browser | 97.06% | 97.06% | 100% | 97.54% |
| Node utilities | 45.12% | 45.12% | 47.05% | 73.26% |

All owned executable files remain included. V8 branch denominators can vary slightly between equivalent runs; measured values above are from the linked main CI run. The immutable-base floor check passed. See [coverage gaps](COVERAGE.md).

Main requires current `ci-required`, PRs, resolved conversations and administrator enforcement, with zero extra human approvals. [Deliberately failing draft PR #1](https://github.com/Laymer/mytikas/pull/1) was blocked and closed without bypass. Publication also stopped automatically when an earlier main run failed its database teardown check; the error was corrected in PR #3 before this successful publication.

The existing `mytikas.monster` Pages binding remains on `Laymer/olympus-mytikas`, and registrar nameservers/mail records remain unchanged. The user confirmed Cloudflare/tunnel setup is not configured. Separate public secrets exist locally, with an empty tunnel-token file and no webhook. Follow [cutover](CUTOVER.md) and [public operations](PUBLIC-OPERATIONS.md); do not tag an accepted release until the external-network showcase passes.

## Hardened artifact and recovery follow-up

[PR #5](https://github.com/Laymer/mytikas/pull/5) passed [main run 42598958115](https://github.com/Laymer/mytikas/actions/runs/42598958115) at `1a703960fe7bf0dc5099c2e36ed5b902b581ebd9`. Its published image is `ghcr.io/laymer/mytikas@sha256:60dbddd0ae2ce3416c1af05ffd2b1ad81e211ea7616447b1428faf8911ba4b68`. Mandatory image scanning found zero fixable HIGH/CRITICAL findings; unfixed base-image findings remain recorded, not suppressed (see IMAGE-SECURITY.md).

The actual cloud Compose configuration was rehearsed locally with the earlier published digest, this hardened published digest, then the earlier digest again. Separately provisioned PostgreSQL required verified CA/hostname TLS and separate owner/runtime roles. Accounts, password authentication, sessions, immutable submissions, history, migration checksums and worker health survived upgrade and rollback. This verifies a same-schema rollback boundary, not arbitrary schema reversal or a managed-provider deployment.

[PR #6](https://github.com/Laymer/mytikas/pull/6) merged as `08ba63d9170811f724926815a8033cdf2e690134` after independent review and [passing required CI](https://github.com/Laymer/mytikas/actions/runs/42601083300). It adds public non-owner database roles with secret-preserving provisioning, exact common-image checks, cloud Compose upgrade/rollback against the candidate image, and real administrator/web process tests. Local measured coverage is backend 92.28% lines/statements, 94.73% functions, 83.91% branches; browser 97.06%, 97.06%, 100%, 97.54%; utilities 45.61%, 45.61%, 47.05%, 73.68%. Increased floors passed CI. Main protection was rechecked: strict current ci-required, PRs, administrator enforcement and resolved conversations remain active; force pushes and deletion are disabled.

## Email activation, recovery and Raid Roster implementation

Local verification for migration 004 covers pending registration, correction, original rules acceptance, concurrent single-use verification, reset replay/expiry and session revocation (including racing login), address/IP throttles, encrypted email jobs, lease recovery and mandatory SMTP TLS. Roster checks cover all three seeded layouts, permissions, duplicate assignment, conflicts, removal races, restoration, class identity validation and persistent overrides. Runtime grants and production dependency audit pass.

Chromium and Firefox acceptance tests pass, including keyboard slot editing, preserved drafts after conflicts, per-roster cancellation, mobile scrolling, read-only views and password reset. HTTPS two-host activation and original landing-page pixel checks pass. Local WebKit requires missing host libraries; the required CI job installs them. The public container test, PostgreSQL backup/restore drill, machine-transfer round trip and cloud upgrade/snapshot rollback rehearsal pass with isolated credentials and transports.

The existing immutable-base coverage gate was retained. Production SMTP credentials, a verified sender, the persistent outbox key and real verification/reset delivery remain operator rollout inputs; no live mail delivery or production rollout is claimed by these tests.
