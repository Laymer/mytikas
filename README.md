<img width="1280" height="640" alt="mytikas" src="https://github.com/user-attachments/assets/b2d134da-09d1-4997-a14b-804107803fc5" />

# Mytikas local guild application

See the [illustrated user manual](docs/USER-MANUAL.md) for applicant, staff, and demo walkthroughs.

A self-contained Olympus Mytikas recruitment prototype: Node.js 24, TypeScript, Express 5, plain browser JavaScript, and PostgreSQL 18. The summit artwork, crest, styling, and complete chronicle were copied from the neighboring `olympus-mytikas/site` frontend. There is no runtime dependency on that repository.

## Start locally

Install Node.js 24 and enable Docker Desktop's WSL integration for this distribution. Both commands must succeed before starting the stack:

```sh
docker compose version
docker info
```

Then, from this directory:

```sh
npm ci
npm run secrets
docker compose up --build -d
docker compose ps
docker compose logs migrate
# Interactive: email and hidden password, then password confirmation.
docker compose exec app node dist/admin-cli.js
```

Open **http://localhost:8080**. Sign in at `/account.html` using the newly created admin account and follow **Admin panel**. The first-admin command creates no application and refuses to run after any admin exists. To grant more staff access, an admin can change an existing account's role in the panel.

`npm run secrets` creates an ignored, mode-0600 `.env` with random database and session secrets. It refuses to overwrite an existing file. `.env.example` documents the variables; its placeholders are not suitable secrets. Keep `.env` between restarts so saved sessions remain valid. Use `localhost` consistently: `APP_ORIGIN` is checked on write requests. If you choose a different browser origin, update it in `.env` and recreate app/worker containers.

Compose exposes only `127.0.0.1:8080`. PostgreSQL is internal. A database health check gates the one-shot migration service; successful migrations gate app and worker startup. All three backend services use the same image. PostgreSQL 18 data lives in the named `postgres-data` volume, mounted at `/var/lib/postgresql`.

```sh
# Inspect logs or readiness.
docker compose logs -f app worker
curl --fail http://localhost:8080/api/health

# Stop and resume without deleting data.
docker compose stop
docker compose start

# Remove containers while preserving the database volume.
docker compose down
docker compose up -d

# After source changes; migrations run before the new app starts.
docker compose up --build -d
```

Do not add `--volumes` / `-v` to `docker compose down` if you want to preserve accounts, applications, sessions, and history. Changing the database password in `.env` does not change credentials inside an already initialized database.

## Applicant and staff workflow

The account page contains sign-in and combined signup/application forms. Signup requires a valid email, a 12–128 character password, first name plus surname (2–24 Unicode letters each), 1–300 characters of trimmed motivation, and explicit acceptance of the displayed rules. Names are normalized with Unicode NFKC, whitespace folding, and lowercasing for uniqueness; display capitalization is retained. Emails are trimmed and lowercased. Each account has one application lifecycle and one current main character; two accounts cannot reserve the same normalized character.

```text
SUBMITTED → APPROVED → JOINED
    ↓          ↓
 REJECTED ←─────┘
    ↓ staff reopen
 REOPENED → applicant revises and resubmits → SUBMITTED
```

Submitted applications are locked. Approved means the staff must arrange the invitation in WoW. Rejection can include an applicant-visible review note. Only rejected applications can be reopened; the applicant must then accept the current rules before resubmitting. Each submission retains its own immutable motivation, character, acceptance timestamp, and rules version. Joining ends this application lifecycle and removes it from the pending queue. The **All applications** or **JOINED** filter retains access to its history.

Both moderators and admins can review submissions, inspect accepted rules/history, approve, reject, reopen, run membership checks, and manually mark approved applicants as joined. Only admins can publish immutable rules versions or assign `USER`, `MODERATOR`, and `ADMIN` roles. The last admin cannot be demoted, including by concurrent requests. The server reads current roles on each request; a role change applies to existing sessions. The initial rules are conspicuously labelled **PROTOTYPE DRAFT**; publish your intended rules in the panel before recruiting.

## Armory verification

The production verifier only requests `https://worldofwarcraft.blizzard.com/en-us/forever/us/armory/character/<name-surname>`. Redirects are refused, fetch/body reading has a 10-second deadline, and decoded responses are limited to 2 MB. It extracts JSON from the known `character-profile-mount-initial-state` script and never evaluates JavaScript.

All of these must match: normalized first name and surname, character region `us`, ruleset slug `pvp`, and guild name exactly `Olympus Mytikas` after normalization. A substring or unrelated occurrence in HTML is insufficient. Staff must verify character ownership during review or invitation; this check only establishes membership.

Approval schedules a check for the next worker cycle (normally within five seconds). Subsequent checks are due every 15 minutes, without an open browser. **Check now** shares a one-minute cooldown between the owner and staff. Database leases prevent overlapping checks, and conditional updates prevent late responses from replacing a manual confirmation or newer workflow state. The worker stops checking once joined. Errors, blocked requests, missing profiles, and mismatches retain approval and expose the latest result. Staff can confirm joining manually.

Run a separate live smoke check:

```sh
npm run smoke:armory
npm run smoke:armory -- Firstname Surname
```

## Discord notifications

Set `DISCORD_WEBHOOK_URL` in `.env` to a staff-channel webhook on `https://discord.com/api/webhooks/...`, then recreate the backend containers:

```sh
docker compose up -d app worker
```

Submission and resubmission commit an outbox job in the same transaction as the application. The worker sends only character name, application reference, and staff-panel link, with `allowed_mentions.parse: []`. Emails and motivations never enter the payload. The webhook stays on the server and is not exposed in API responses or browser code.

Temporary errors retry with exponential delay (15 seconds up to one hour), up to eight attempts; HTTP 429 retry timing and exhausted rate-limit headers defer pending deliveries. Permanent 4xx responses fail immediately (408 is retried). Per-job leases allow crash recovery. Delivery is at least once: a crash after Discord accepts a message but before the database records it can produce a duplicate. Failed delivery never undoes an application. Inspect delivery status in the application's **Submission notifications** section.

Without a webhook, the panel shows notifications disabled and new jobs are marked `DISABLED`. Enabling it later sends future submissions, not old disabled jobs. Localhost links in notifications work only on the computer running this application.

## API and security

All mutation requests accept JSON, require the session's `X-CSRF-Token`, and reject conflicting origins. Obtain the token from `GET /api/auth/me`. Registration and login return a rotated session and new token. Logout deletes the server-side session. Sessions live in PostgreSQL and use HttpOnly, SameSite=Lax cookies, seven-day expiry, and Secure cookies for HTTPS origins. Local Compose deliberately uses HTTP on loopback. No proxy trust or public deployment is configured.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Database/application readiness |
| `GET /api/auth/me` | Account and CSRF token |
| `POST /api/auth/register` | Atomic account + first application |
| `POST /api/auth/login`, `/api/auth/logout` | Session lifecycle |
| `GET /api/rules` | Current rules version |
| `GET /api/application` | Owner application, submissions, history |
| `POST /api/application` | Resubmit a reopened application |
| `POST /api/application/check` | Owner membership check |
| `GET /api/admin/applications?status=PENDING&offset=0` | Staff queue (50 per page); `ALL` or a lifecycle status also supported |
| `GET /api/admin/applications/:id` | Staff detail, accepted rules, events and delivery status |
| `POST /api/admin/applications/:id/approve` | Approve a submitted application |
| `POST /api/admin/applications/:id/reject` | Reject a submitted or approved application |
| `POST /api/admin/applications/:id/reopen` | Reopen a rejected application |
| `POST /api/admin/applications/:id/join` | Manual joining confirmation |
| `POST /api/admin/applications/:id/check` | Staff membership check |
| `GET /api/admin/users?q=...` | Admin-only email lookup, up to 50 matches |
| `POST /api/admin/users/:id/role` | Admin-only role change: `{ "role": "MODERATOR" }` |
| `POST /api/admin/rules` | Admin-only publication: `{ "content": "..." }` |

Registration accepts `email`, `password`, `characterName`, `motivation`, `rulesId`, and `acceptRules: true`; resubmission uses the same application fields without email/password. Staff transitions accept an optional plain-text `note` of up to 1,000 characters, visible to the applicant.

Passwords use Argon2id (64 MiB, three iterations). SQL is parameterized. Uniqueness and workflow updates are transactional. Immutable-history triggers protect rules, submissions, transition events, and role-change events. Authentication limits are persisted in PostgreSQL: 40 attempts per IP and 12 per normalized email per 15 minutes. The worker removes expired rate limits and sessions. Frontend rendering treats application content and rules as text; Helmet supplies a restrictive same-origin CSP. Applicants can retrieve only their own application; every staff endpoint checks the current role on the backend.

## Development and verification

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

Integration and browser tests launch a genuine, isolated PostgreSQL 18 instance from the development-only `embedded-postgres` package, on an ephemeral loopback port and temporary directory. They do **not** connect to `DATABASE_URL` or alter your application database. Run as a normal user (PostgreSQL refuses root). The package supports mainstream platforms; if a platform is unsupported, run tests in a supported Linux development environment. If package install scripts were disabled, rebuild the matching `@embedded-postgres/<platform>` package to hydrate its native symlinks.

An isolated HTTP fixture service supplies explicitly synthetic Blizzard profile data and Discord responses. Tests inject its transport into backend constructors; the production entrypoints have no fixture URL override or fallback. The production parser, verifier, API, transactions, outbox, and worker cycle are exercised against these fixtures. No real Discord messages are sent by tests. Browser screenshots are saved under ignored `test-results/`.

Coverage includes signup → approval → worker-confirmed joining, manual joining, rejection/reopening/resubmission, immutable versions, duplicate identity rollback, validation, role boundaries, CSRF, session rotation/logout, rate limits, check cooldowns, conflicting transitions, armory mismatches/failures, Discord failures/retries, browser workflows, and database/application restart persistence.

For native development against your own separately provisioned PostgreSQL 18 instance, set `DATABASE_URL` in `.env`, then run `npm run migrate`, `npm run dev`, and `npm run worker` in separate terminals. Compose's database is intentionally not published to the host. Use `npm run admin` once to bootstrap that development database. `npm run build && npm start` runs the compiled server.

## Verification recorded during implementation

- Node.js 24.19.0; PostgreSQL 18.6 integration suite passed all 22 checks, including a real database process stop/start and preserved sessions/history.
- Interactive first-admin creation verified with hidden password input and no guild application; secret generation verified for private permissions and overwrite protection.
- Chromium browser checks passed for combined signup, required acceptance/counter, moderation, reopening/resubmission, rule publication, joining, role management, and mobile layout. No uncaught page errors.
- Live armory check on 2026-11-08 returned HTTP 200 for **Xaryu Forever**. Parsed region `us`, ruleset `pvp`, guild **Phase Nine**; result `GUILD_MISMATCH`, as expected. Successful automatic joining was demonstrated using the identified fixtures, not asserted against this live profile.
- Docker Compose was unavailable and the Docker daemon unreachable in the supplied WSL environment. Container build/startup and Compose restart persistence remain unverified. After enabling Docker Desktop WSL integration, run the startup steps above, create an application, run `docker compose down` followed by `docker compose up -d`, and verify the same account/session, rules and history remain.

Public deployment to `mytikas.monster`, domain/TLS setup, email verification/reset, Discord login, alternate characters, in-game invitation automation, and ongoing member monitoring are deferred.

## Compose operations helper and isolated demo

Use Bash 4+, Node.js 24, Docker with a running daemon, and Docker Compose
2.24.4 or newer (the demo uses `!override` to replace the published port).
The executable helper resolves paths from its own location, including when invoked
from another directory. It never sources environment files. Each invocation pins
the project, environment file, and Compose files; ambient application environment
variables are cleared so they cannot substitute another database or origin.

```sh
./mytikas.sh help
./mytikas.sh init       # create private .env only if missing
./mytikas.sh doctor     # prerequisites, daemon and quiet config validation
./mytikas.sh up         # build and wait for readiness, up to 180 seconds
./mytikas.sh status
./mytikas.sh health
./mytikas.sh logs app worker
./mytikas.sh logs --follow app
./mytikas.sh shell      # optional service name; defaults to app
./mytikas.sh db -c 'SELECT count(*) FROM applications;'
./mytikas.sh migrate
./mytikas.sh admin      # interactive first-admin creation
./mytikas.sh backup 'backups/my private backup.dump'
./mytikas.sh stop
./mytikas.sh start
./mytikas.sh restart
./mytikas.sh down
./mytikas.sh build
```

Normal operation uses project `mytikas`, `.env`, and `http://localhost:8080`.
`start` resumes existing containers and `restart` restarts them. Use `up` to
apply source or environment changes. `down` preserves the PostgreSQL volume.
Logs default to the last 100 lines. Shell and database commands preserve terminal
support and accept redirected input; admin setup requires a terminal.
Backups use containerized `pg_dump -Fc`, mode 0600, refuse existing destinations,
and remove incomplete output after failure. Relative backup paths resolve from
the repository; the default destination is `backups/<project>-<UTC timestamp>.dump`.
Inspect a dump without installing PostgreSQL locally:

```sh
docker exec -i mytikas-db-1 pg_restore --list < backups/mytikas-example.dump
```

The independent demo uses project `mytikas-demo`, private ignored `.env.demo`,
different database credentials and a dedicated project volume. Only
`127.0.0.1:8081` is published; PostgreSQL and the worker have no host port.
The startup chain is database → migrations → transactional seed → fixture
readiness → app/worker. `GET /api/runtime` reports `normal` or `demo`; demo pages
show a banner. The demo's `mytikas.demo.sid` cookie allows simultaneous normal and
demo logins on localhost.

```sh
./mytikas.sh demo up
./mytikas.sh demo accounts  # the only helper command that prints the password
./mytikas.sh demo summary
./mytikas.sh demo seed      # idempotent; preserves walkthrough changes
./mytikas.sh demo armory approved@demo.test member
./mytikas.sh demo check approved@demo.test
./mytikas.sh demo down      # preserve demo data
./mytikas.sh demo reset --yes  # delete ONLY demo volume, rebuild and reseed
```

`--demo` before any operational command selects the same demo environment, for
example `./mytikas.sh --demo backup` or `./mytikas.sh --demo db`.
`demo reset --yes` deliberately discards walkthrough changes; it preserves the
shared password in `.env.demo`. Keep that file alongside the persistent volume.
Initialization preserves existing files instead of filling or replacing secrets
in an existing file; configuration validation reports missing required values.

The nine fictional logins share one generated, persistent password, hashed with
the application's Argon2id implementation:

| Login | Role / initial application |
| --- | --- |
| `admin@demo.test` | Administrator, no application |
| `moderator@demo.test` | Moderator, no application |
| `submitted@demo.test` | Submitted; fixture is already a member |
| `approved@demo.test` | Approved; fixture is initially an outsider |
| `rejected@demo.test` | Rejected with a review note |
| `reopened@demo.test` | Reopened for revision |
| `resubmitted@demo.test` | Submitted again; two immutable revisions |
| `manual@demo.test` | Joined manually by staff |
| `armory@demo.test` | Joined by armory verification |

The seed stores two accepted demo rules versions, review notes, transition actors,
and disabled Discord jobs. A dataset marker makes repeated seeding a no-op;
first seeding refuses a populated unmarked database, and failures roll back the
entire dataset. Unsupported dataset versions fail explicitly.

For a walkthrough, inspect `demo accounts`, then sign in as the administrator at
`http://localhost:8081/account.html` and open the admin panel. Approve **Demo
Submitted**; its `member` fixture lets the worker move it to Joined on its next
cycle. Sign in as `reopened@demo.test`, revise the motivation, accept the current
rules, and resubmit. Compare the immutable submission history and accepted rules.
Finally change `approved@demo.test` to `member` with the command above and run
`demo check`; confirm Joined on the account or staff page. A previous membership
check imposes the normal one-minute cooldown; wait before checking again.

Fixtures live in the demo database and support `member`, `outsider`, `missing`
(404), and `unavailable` (transport failure). Unknown characters return 404. The
armory command targets the applicant's **current** character, including a revised
name. Fixtures feed the existing HTML parser, membership verifier, cooldown logic,
and worker through an injected transport; demo entrypoints make no live Blizzard
requests and forcibly disable Discord even if a webhook is configured. Normal
entrypoints retain the live Blizzard transport.

### Verification (2026-11-08)

Verified with Node 24, Docker Engine 29.8.2, Compose 5.6.0 and real PostgreSQL 18.6:

- `npm run build`, `npm test` (22 integration checks), and `npm run test:browser`
  (six browser scenarios) passed.
- `npm run test:demo` passed: transactional failure rollback, populated-database
  refusal, repeatability, Argon2 passwords and roles, submission/event consistency,
  both accepted rules versions, fixture outcomes, cooldowns, automatic joining,
  and disabled Discord jobs.
- `bash -n mytikas.sh` and `npm run test:helper` passed: external-directory
  invocation, missing prerequisites, invalid commands, argument quoting, secret
  file preservation, failure propagation, and incomplete-backup cleanup.
- Actual Compose builds/startup, health/status/logs, migrations, database queries
  and redirected input, shell input, private custom-format backup and archive
  inspection, overwrite refusal, stop/start, restart, and down/up persistence
  were exercised.
- `npm run test:demo:browser` passed against both running Compose stacks: seeded
  login, demo banner, historical rules, reopened revision, and simultaneous
  normal/demo sessions, including logout isolation. This optional check creates a normal test account and
  revises the demo; run it on local test stacks, then reset the demo.
- Demo-only reset was checked against normal container IDs, volume creation
  metadata, and user data; the normal project remained unchanged. The demo was
  left freshly seeded and running on port 8081.

ShellCheck was unavailable in this environment. Integration and browser tests use
isolated fixture transports; live Blizzard/Discord integration was not exercised.

## Public prototype deployment

The intended public landing URL is **https://mytikas.monster**, with accounts and staff pages at **https://app.mytikas.monster**. The domain cutover and external showcase acceptance are still pending; the existing landing remains in place.

The public deployment uses an isolated database and Cloudflare Tunnel, with no app/database host ports. Start setup with `node scripts/public.mjs init`, then follow [public laptop operations](docs/PUBLIC-OPERATIONS.md), [DNS cutover](docs/CUTOVER.md), and [backup/recovery](docs/RECOVERY.md). Normal local and seeded demo commands remain available. Password reset and email verification are not implemented. Registration/application details are sent to the private staff Discord channel; email, passwords and session information are excluded.

The [implementation tracker](docs/IMPLEMENTATION-PLAN.md) distinguishes verified implementation from outstanding live work. [Architecture contracts](docs/ARCHITECTURE.md) and the [cloud handoff](docs/CLOUD-HANDOFF.md) describe portable web/worker/migration entrypoints, external PostgreSQL TLS and runtime privileges. CI gates changes with `ci-required`; Pages and image publication run only after required jobs succeed on main.

Run `npm run typecheck`, `npm run coverage:backend`, and `npm run coverage:utilities` for backend/tool checks. Browser compatibility uses `BROWSER=chromium|firefox|webkit npm run test:browser`; Chromium collects coverage with `FRONTEND_COVERAGE=1`, followed by the same setting for `npm run test:landing:browser`, then `npm run coverage:frontend`. `npm run coverage:check` validates the measured baseline. See the coverage report documentation for exclusions and remaining gaps.

The [published-artifact verification record](docs/VERIFICATION.md) contains the tested source commit, immutable image digest, landing preview and remaining live-launch blockers.

### Move public hosting between WSL2 and Intel macOS

Use `./mytikas-machine.sh migrate` on the current host, copy its private ZIP and the launcher, then run `./mytikas-machine.sh import /path/to/archive.zip` on the receiver. Reverse those commands with a new export to return. See [machine migration and recovery](docs/MACHINE-MIGRATION.md) for prerequisites, downtime, credential handling, the 4 GiB archive limit and the pending real-Mac acceptance rehearsal.
