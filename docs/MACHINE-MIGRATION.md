# Move public hosting between WSL2 and an Intel Mac

The standalone `mytikas-machine.sh` moves the **public** deployment. Local/demo deployments and the GitHub Pages landing page are independent. Hosting is unavailable between export and successful import. Copies can be renamed `machine1.sh` and `machine2.sh`.

```bash
# Optional: on the receiving machine, install prerequisites before the outage.
chmod +x mytikas-machine.sh
./mytikas-machine.sh prepare

# On the hosting machine, next to its public checkout on the first transfer:
./mytikas-machine.sh migrate
# Prints a private ~/.mytikas/mytikas-<timestamp>-<identity>.zip path.

# Copy that ZIP and the launcher to the receiving machine:
./mytikas-machine.sh import /path/to/archive.zip
```

Run the same commands in reverse to move back. Do not use an old transfer to return: export a new generation from the current host. Ordinary public helpers resolve the managed deployment; they do not rebuild its exported runtime. From an updated checkout containing these migration-aware helpers, use `node scripts/public.mjs ...` or `./mytikas.sh public ...` for status, logs, backup and administration after import.

The ZIP is **unencrypted** and contains database contents, password hashes, sessions, database credentials, session secret, Discord webhook and connector token. Keep it private during copying and storage. Permissions are 600; machine directories are 700. Only import archives from your own trusted host. Checksums detect corruption, not a malicious sender; database dumps and container images are executable trusted inputs. Cloudflare management credentials, `.env`, demo files, private snapshots and previous backups are never included.

The archive uses a deliberately restricted stored ZIP profile: exactly four regular entries, no compression, symlinks, duplicates, extra fields, comments or ZIP64. The current maximum is 4 GiB; export rejects deployments estimated to exceed it before stopping. Standard unzip can inspect these archives, but repacking with another archiver is not supported. Processing streams files with bounded memory and uses built-in Node APIs, requiring no host archive package or PostgreSQL installation.

## Bootstrap and requirements

The launcher runs on macOS's Bash 3.2 and WSL2 Bash. Both machines need an x86_64 Linux Docker engine, disk space for images, staging, backup and a fresh database, and Internet for initial setup and the fixed-repository source download. The first export requires Git in the existing checkout to record its commit. Import requires no checkout, Git, Homebrew, host PostgreSQL or npm install.

A working local Unix-socket Docker context is reused and recorded in `~/.mytikas/machine.json`. Remote Docker contexts are rejected. On Intel macOS, if no engine is available, the launcher downloads pinned Docker Desktop 4.98.0, verifies its SHA-256 and macOS signatures, invokes the official installer and opens Docker. Complete OS permissions and Docker terms prompts yourself; rerun the identical command if its 60-second wait expires. It never accepts terms on your behalf. On WSL2 it explains how to enable Docker Desktop's WSL integration.

An existing Node 24 is reused. Otherwise pinned Node 24.22.2 is downloaded into `~/.mytikas/tools` and checked against embedded platform checksums. Download pins come from [Node's release checksums](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt) and [Docker's Intel release checksums](https://desktop.docker.com/mac/main/amd64/245422/checksums.txt). The installation sequence follows [Docker's Mac installation instructions](https://docs.docker.com/desktop/setup/install/mac-install/).

## What is verified

Export checks local engine/platform, public configuration, running image identities, database and image migration checksums, source availability, public health and host/engine disk capacity before stopping traffic. Source commit and image IDs are separate manifest fields; the launcher never claims a locally built image came from the current commit. The source commit's migrations must match the runtime. Source is downloaded only from `Laymer/mytikas` at that exact commit; no latest-main fallback or archive-supplied URL is accepted.

The connector stops first. App and worker get their existing graceful deadlines; any nonzero exit or OOM rejects export. PostgreSQL stays running for the custom dump and an isolated restore verifies all table fingerprints, sequence values and migration checksums. No job leases or retry state are reset. Discord delivery retains its existing at-least-once/ambiguity behavior; migration cannot promise exactly-once delivery.

The ZIP is checked before publication. Public service containers are then removed, preserving the original database volume, so restart policies cannot revive them. State and a checkout marker reject ordinary startup after handoff. These guards cannot prevent deliberate manual Docker commands, another account bypassing state, or someone importing the same archive on a third machine.

Import validates the entire directory and payload hashes before extracting or restoring. It loads the exact saved image IDs and checks their platform/migrations. A known previous destination gets a safety dump before graceful stop. Restoration always uses a new generation's project and volume with imported credentials; source credentials never touch an existing database volume. Restore reestablishes ownership and least-privilege runtime grants. The app becomes healthy on an isolated network before background work or the tunnel starts. Host UID/GID are regenerated and token readability is tested as that user. The durable write barrier precedes worker startup. Worker heartbeat, public HTTPS health/availability and secure session-cookie flags are checked before activation is recorded.

## Status, interruption and recovery

```bash
./mytikas-machine.sh status
./mytikas-machine.sh doctor
./mytikas-machine.sh import /path/to/the-same-archive.zip  # resume an interrupted import
./mytikas-machine.sh recover finish-export              # finalize an already validated export
./mytikas-machine.sh recover source                     # restart source only before archive publication
./mytikas-machine.sh recover previous                   # explicit pre-write destination rollback
```

Failures keep traffic stopped and retain data. Repeating an active transfer is a no-op; older generations and unrelated lineages are rejected. A failed staging restore may recreate **only its new, never-writable staging volume**. Once the write barrier is recorded, retries preserve the destination database and never replay the dump. Recovery to the previous destination consumes the incoming generation, so that archive cannot later overwrite writes on the recovered copy. A crash immediately before worker startup is conservatively treated as having started writes. Recovery to the previous copy is then forbidden; resume the destination and export a new transfer to return.

`recover source` applies only to `export-stopping`/`export-stopped`, before any usable ZIP is published. `recover finish-export` applies to `export-packaged`. After `handed-off`, receive a newer export from the current host. `recover previous` applies only to imports before the write barrier and requires a recorded previous destination. It is never automatic.

An operation lock prevents concurrent supported helpers. After a process is killed, first verify that no launcher is still running, then remove the **empty** `~/.mytikas/operation.lock` directory and repeat the command. Do not edit checkpoint JSON to bypass the write barrier. Prior deployment volumes and safety dumps are retained until you explicitly remove them after review; there is no automatic pruning command.

## Verification and publication

`npm run test:machine` covers ZIP corruption/path/type rejection, credential validation, generation guards, interruption/resume, write barriers, failed drains and installer decisions with command doubles. `npm run test:machine:container` performs an isolated real PostgreSQL/image WSL-style → Mac-style → return round trip, checks administrator/hash/session preservation and different destination credentials, and verifies the previous destination data survives. Its connector is a local sleeping fixture; it never connects a real tunnel. These tests do not operate the live public project.

Real Intel macOS acceptance is **not yet claimed**. Before using this for a live handoff, rehearse on that Mac: Docker download/signature/install prompts, Node install, bind-mount token readability with UID 501/GID 20, isolated restore, interrupted import, and HTTPS/secure-cookie validation using a non-production test tunnel. Linux simulation does not validate Docker Desktop filesystem behavior or macOS OS prompts.

Changes go through a pull request and existing mandatory CI checks. After merge through the protected workflow, CI publishes the launcher, its checksum and this guide as a commit-named artifact. Source modules live in `scripts/machine/`; regenerate the standalone script with `npm run build:machine`. CI rejects a stale generated launcher. No CI step invokes a live migration.
