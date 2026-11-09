# Production rollout and acceptance

## Current gate — 9 November 2026

The discovery supplied for this rollout records healthy pre-004 web/worker, migrations 001–003 with matching checksums, two administrators, one application, and prototype rules. Public HTTPS, apex/www Pages and the application tunnel are already cut over to this repository. Those observations supersede older pending-DNS, missing-Docker and missing-admin statements. They are not a fresh deployment attestation. Recheck immediately before interruption.

PR #12 implements activation, recovery and rosters. Its earlier head `433d3e5a21237dbdefbcc97726e849cd23676328` passed [PR CI](https://github.com/Laymer/mytikas/actions/runs/42654880801) and [push CI](https://github.com/Laymer/mytikas/actions/runs/42654868302). Hardening changes require their own complete CI. No production migration, mail delivery or live acceptance is claimed here.

The operator has not yet established the maintenance window, recovery custodian, encrypted off-host backup destination, private Proton token/sender setup, reviewed rules/webhook or approved live test identities. Keep production running until these are ready. Do not bootstrap administrators again. Confirm existing administrator access privately.

## Candidate and protected configuration

Set optional `MYTIKAS_IMAGE=ghcr.io/laymer/mytikas@sha256:<64 lowercase hex digits>` in the mode-0600 public environment file. A tag is rejected. Migration, web and worker use that digest. An empty selection retains local builds. Managed machine imports continue using archived image IDs.

`node scripts/public.mjs doctor` and `up` resolve Compose privately, validate mail settings and matching candidate services, build/pull before interruption, validate the candidate and inspect the existing database volume. An existing database must be available for a read-only schema/checksum check. Ordinary `up` refuses pending/mismatched migrations before stopping ingress: use the staged procedure below. A stopped database may be explicitly started with `up -d --no-deps --no-recreate --wait db` after verifying its retained volume. Never recreate an absent production volume as an empty database.

`node scripts/public.mjs doctor --smtp` verifies the candidate transport connection, certificate, TLS and authentication without sending a message. Transport uses required STARTTLS (implicit TLS on 465), certificate validation, TLS 1.2 minimum, bounded timeouts and disabled debug logging. Docker/preflight errors are redacted; successful authentication is not inbox delivery evidence. Missing keys are reported, never generated over existing configuration.

Set Proton host `smtp.protonmail.ch`, port `587`, user and sender `mytikas@mytikas.monster`. Use a dedicated SMTP token, not the account password. Read the current [Proton SMTP instructions](https://proton.me/support/smtp-submission) and confirm sender/domain readiness in the account panel. Supply credentials with a private editor/secret manager, never chat, command arguments or published logs. Generate an independent random 32-byte hexadecimal outbox key only after confirming no existing key/encrypted queue must be preserved. Keep original database/session/tunnel secrets. Keep encrypted off-host copies of configuration/key and tunnel token separately from the database dump.

Machine export compares captured Compose-resolved values with running web/worker values. Generated deployments keep secrets in a mode-0600 Compose file with literal dollars escaped; their env file contains host IDs only. Protect both files. Archive format 1 and older archives without mail/image metadata remain supported. Do not copy generated Compose strings back through an extra dotenv parser.

## Mail DNS preparation

Privately export the whole current zone with record identities and TTLs. Confirm Proton domain verification and sender activation before changing records. Prepare and review exactly this delta against the [Proton domain panel](https://proton.me/support/custom-domain-cloudflare): remove five obsolete registrar-forwarding MX records and the registrar SPF policy; retain Proton MX priorities, three DKIM selectors, DMARC, Proton and GitHub verification, Pages addresses, application CNAME and nameservers. Retain exactly one apex SPF policy: `v=spf1 include:_spf.protonmail.ch ~all`. Verify authoritative and public resolver answers after the scoped change. Mixed MX and two SPF policies are an open gate, not a completed mail setup. DNS changes await account-side confirmation.

## Publish the tested candidate

Recheck PR head/base, reviews, unresolved conversations and branch protection. Require full final-head CI and independent review. Preserve strict current `ci-required`, resolved conversations and administrator enforcement; do not lower security/coverage gates. Merge through protection, wait for the resulting main SHA's full CI/publication, and select its recorded registry digest. Publication must load the tested archive without rebuilding. Preserve source/run URLs, digest, scan/SBOM, coverage, migration checksums and launcher provenance before artifacts expire. Review unfixed image findings even when the fixable HIGH/CRITICAL gate passes.

## Scheduled upgrade

Use the helper's sanitized environment for all Compose commands below: remove ambient `DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_*`, `POSTGRES_*`, `DATABASE_*`, `RUNTIME_DATABASE_*`, `SESSION_*`, `SMTP_*`, `EMAIL_*`, `PUBLIC_*`, `DISCORD_*`, `MYTIKAS_*`, `APP_ORIGIN`, `DEPLOYMENT_PROFILE`, and `INGRESS_MODE`. For the ordinary deployment, `DC` denotes `docker compose --project-name mytikas-public --env-file .env.public -f compose.public.yaml`. Re-resolve any managed-machine pointer first. Do not run unsanitized commands against production.

1. With service available, record old app/worker IDs, database image/volume, migration checksums and aggregate account/application counts. Save the **exact old image**, old grants and configuration privately. Its source is unknown unless independently established; a similarly named registry image is not a substitute. Pull/inspect the candidate and perform no-send SMTP preflight. Check disk space, PostgreSQL 18 restore tooling, isolated capacity, off-host backup access, secret recovery, reviewed rules/webhook, tester and maintenance window.
2. Stop ingress with `DC stop tunnel`, then `DC stop --timeout 45 app worker`. Verify clean exits and no active application transaction. PostgreSQL stays running. A separate-network tester confirms Pages remains available and shows unavailable/unknown application status.
3. Run `node scripts/public.mjs backup backups/<UTC>-pre004.dump`. Verify mode 0600, archive integrity/checksum and encrypted off-host copy. Restore to an isolated fresh target, with no public tunnel or externally sending worker. Compare data/sequence fingerprints, checksums, grants, accounts/history and sessions. An archive listing alone is insufficient. Do not migrate until the actual production snapshot and exact old runtime/secrets are demonstrably recoverable.
4. With traffic and writers still stopped, run `DC run --rm --no-deps migrate`, then `DC run --rm --no-deps runtime-grants`, then `DC up -d --no-deps --no-build --wait --wait-timeout 180 app worker`. Migration uses owner credentials; runtime remains non-owner. Verify 001–004 checksums/grants, existing account exemptions with null verification timestamps, unchanged roles/history and version-zero session compatibility. Verify 10/20/40 roster seeds/distributions, identical runtime image IDs/effective settings, internal readiness and process-specific heartbeat.
5. Recreate the namespace consumer last: `DC up -d --no-deps --force-recreate tunnel`. Verify public HTTPS, no-store APIs, host-only Secure/HttpOnly/SameSite cookies, administrator access and controlled acceptance. Publish reviewed rules and private webhook before controlled registration. Do not advertise recruitment until core acceptance passes.

## Failure and rollback

Before migration commits, establish the actual schema; resume the old runtime only if unchanged. After 004 commits, image-only rollback to pre-004 is unsupported. Leave ingress/writers stopped if interrupted or schema/image/secrets are uncertain. Save the failed upgraded state privately. Restore the verified pre-upgrade snapshot using the exact old image, old grants and original secrets; validate a fresh restore first. Destructive replacement requires `node scripts/restore.mjs <archive> --public --database mytikas_public --replace` and the recovery custodian's accepted data-loss boundary; consult `node scripts/restore.mjs --help` for connection routing. Never accidentally run new migration/grant dependencies while restoring the old runtime. Recreate the old tunnel only after old-schema readiness and account/session checks pass.

Snapshot rollback reverses **all** writes after the recovery point, including registrations, passwords/sessions, reviews and rosters. It cannot undo external email/Discord delivery. Reconcile reversed security changes explicitly. Prefer a forward fix after accepting new writes unless recovery requires rollback.

Recover a missing outbox key before replacing it. If irretrievably lost, a reviewed incident procedure must invalidate affected links and cancel unreadable pending jobs before deliberate replacement. Terminal failures discard payloads; request replacement links after repair instead of blindly requeueing failed jobs.

## Mail diagnostics

Worker failure events contain only event name, job ID, attempt, retry/terminal outcome and an allowlisted category (`payload`, `authentication`, `tls`, `timeout`, `connection`, `smtp_permanent`, `smtp_temporary`, `internal`). Never log raw transport errors, addresses, bodies, ciphertext, links, tokens or credentials. Use owner/private SQL access for aggregate monitoring:

```sql
SELECT status, count(*) AS jobs, max(attempts) AS max_attempts,
       sum(attempts) AS total_attempts
FROM email_jobs GROUP BY status;
SELECT count(*) AS pending,
       now()-min(created_at) AS oldest_pending_age,
       count(*) FILTER (WHERE lease_until < now()) AS expired_leases
FROM email_jobs WHERE status='PENDING';
```

Also inspect Discord backlog/failures, lease ages, readiness and heartbeat age. A healthy heartbeat is not mail delivery evidence. Job creation is exactly once under the relevant transaction; external delivery is retry-based and may duplicate after ambiguous acknowledgements.

## Controlled acceptance and release closeout

Use approved dedicated accounts/recipients and real characters. Respect 60-second address cooldown, five requests/address/hour and twenty/IP/hour. Do not delete immutable test history. Record UTC time, source SHA/digest, schema/checksums, browser/device/network, expected/observed result and redacted evidence per case.

- Verify pending signup stays unauthenticated and outside staff list/detail; original application/rules remain immutable. Confirm actual inbox/spam receipt, sender and authenticated headers, single-use verification, one Discord job, replay and wrong-purpose rejection.
- Test credential-protected resend/correction, old-link cancellation, preserved application, password-reset/change receipt, old-password/session rejection, and unverified reset remaining unverified. Exercise natural 24-hour verification and 30-minute reset expiry without changing production clocks/timestamps; acceptance spans at least 24 hours.
- Confirm private Discord destination, no email/secrets/mentions, staff deep-link login and correct review target; healthy notification within 30 seconds of verification. Exercise approval/rejection/reopening/resubmission and original rules history.
- Use real matching armory identity/region/ruleset for joining and class retrieval; record manual joining separately. Test all roster access roles, including removed members, member moderators read-only and administrators without membership. Assign/clear all sizes, reject duplicates, preserve stale drafts and drafts across class refresh, preserve class overrides and test “Use armory class”. Remove a member assigned across all rosters; access ends, every slot clears, restoration leaves slots empty and administrator role is unchanged.
- Verify keyboard-only dialog/focus and actual-device horizontal scrolling. Use a genuinely separate network without VPN for HTTPS/session behavior, outage/Pages status, restart persistence, same-digest recreation/tunnel recovery and the actual-backup restore drill. Same-host automation is insufficient. Induce transport failures/races only in isolated fixtures.

After evidence and operator signoff, make a separate closeout PR recording actual outcomes and open failures. Validate the old Pages fallback at its project URL where necessary without transferring the live domain to satisfy a stale row. Only then disable the old publishing workflow and add its notice; retain repository/history. Create an annotated accepted-release tag (for example unused `v1.0.0`) on the **deployed and accepted source SHA**, recording any separate docs commit, digest, migrations, CI and recovery point. Managed cloud hosting, actual Intel Mac handoff, alternate characters, more rosters and scheduling remain deferred.
