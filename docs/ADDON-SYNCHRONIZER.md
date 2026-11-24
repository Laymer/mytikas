# Deploy reviewed add-on releases

The web app accepts submissions after the operator enables the feature. Its PostgreSQL outbox keeps the original ZIP until the Rust worker commits that ZIP and its checksum in a separate PostgreSQL 18 archive database. The worker opens an OlympusMytikas PR from Laymer’s fork and publishes the original bytes after review and merge. Existing downloads remain available during review. Both databases belong to the same public Compose project and have independent named volumes. The worker gets a dedicated SQL login in each database. Only the synchronizer container receives the GitHub App private key.

## Automated rollout on the active host

For the reviewed migration from schema 008 to 009, run the following from a checkout containing the deployment tools as the production machine owner. The command locates the active public Compose project and uses the reviewed app and synchronizer image digests.

```sh
node scripts/addon-sync.mjs rollout
```

On first use, rollout opens the organization’s GitHub App registration on macOS or prints a loopback URL on Linux. Complete GitHub’s browser consent and install the App on the selected `OlympusMytikas` repository under **both** Mytikas-Monster and Laymer. Registration stores the private key on this host. For an existing App, supply the local PEM path in `GITHUB_APP_PRIVATE_KEY_FILE` and its numeric `GITHUB_APP_ID`. The rollout discovers the installation IDs and writes the owner-only configuration. The host’s Docker login must be able to pull both images.

Rollout verifies the pinned images, App access, and deployment settings before stopping traffic. It creates a private backup, rehearses restoration, applies the web migration and grants, starts the synchronizer, and enables the admin form. Rerun the same command after an interruption. It resumes the recorded deployment stage. After activation, verify that `https://app.mytikas.monster/api/health` reports ready and that `/api/auth/me` reports `addonSubmissionsEnabled: true`. Use the next approved upload for release verification.

## Prepare the release

1. Merge the reviewed implementation PRs and confirm the required checks on the resulting upstream commits. Record the app and synchronizer GHCR digests and source commits. Upstream OlympusMytikas already publishes through its CurseForge workflow. Preserve that integration and its existing project configuration. The GitHub App must be installed on both the Laymer fork and the upstream add-on repository. On the fork it writes content and branches. On upstream it reads the fork PR, opens the PR and writes the tag and release.
2. Take a verified backup of the current production installation and retain the exact image, configuration and migration grants. Use the existing maintenance window procedure to apply the app image and migration 009. Apply the new runtime grants before exposing the new web version. For a checkout installation follow the [staged application upgrade](PRODUCTION-ROLLOUT.md#scheduled-upgrade).
3. For an active **machine-managed installation** already at migration 008, run the following from the updated checkout with the machine owner’s account. Save a backup and rehearse restoration first. This command stops the tunnel and existing writers, verifies the supplied image against the org registry’s commit tag, applies 009 as owner, reapplies the runtime grants and restarts the managed app, worker and tunnel. It preserves a private copy of the previous generated Compose file. A failed migration leaves traffic stopped for investigation. Retry with the same release after addressing the failure. Older schemas follow the earlier staged rollout first.

```sh
node scripts/addon-sync.mjs upgrade-managed-web "$MYTIKAS_APP_DIGEST" "$MYTIKAS_APP_COMMIT"
```

4. Save a private RSA App key on the host. Create `~/.mytikas/integrations/addon-sync.json` with mode 0600 under an owner-only directory. Supply the exact digest and the two installation IDs. The key file must also be owner-only and readable by the machine owner.

```json
{
  "image": "ghcr.io/mytikas-monster/mytikas-synchronizer@sha256:<published digest>",
  "GITHUB_APP_ID": "<app ID>",
  "GITHUB_FORK_INSTALLATION_ID": "<installation on Laymer>",
  "GITHUB_UPSTREAM_INSTALLATION_ID": "<installation on Mytikas-Monster>",
  "GITHUB_APP_PRIVATE_KEY_FILE": "/absolute/private/path/to/github-app.pem"
}
```

## Enable, inspect and pause

Run `node scripts/addon-sync.mjs enable` from the updated checkout on the active host. It resolves the current Compose project, creates a private overlay at `.public/addon-sync.json` inside the active deployment, provisions the internal archive database and the two restricted SQL logins, checks GitHub App access, then waits for the worker heartbeat and recreates the web app with submissions enabled. Docker Compose publishes no archive database or worker port. The key stays in a read-only file mount. Keep the overlay private. To rotate an installation key, replace the private file and rerun enable.

Use `node scripts/public.mjs status` and `node scripts/public.mjs logs` to inspect the archive database and synchronizer alongside the app. Check the administrator view for the PR, release and CurseForge result. An individual submission can be blocked while the process remains healthy. A closed, unmerged PR does not release the add-on.

Use `node scripts/addon-sync.mjs pause` to close submissions and stop GitHub processing. The overlay, volume and outstanding jobs are retained. `enable` resumes them. For a cloud deployment, provision the same two PostgreSQL databases with separate credentials and the grants in `scripts/addon-sync-grants.sql`. Run the digest-pinned Rust image with `migrate` against the archive owner connection, then run `preflight` and the default worker command with the runtime logins. Supply `APP_DATABASE_URL` and `ARCHIVE_DATABASE_URL` with `sslmode=verify-full` and a mounted trust root through `sslrootcert`, plus the four GitHub settings above. Set `ADDON_SUBMISSIONS_ENABLED=1` on the web process after the worker is healthy. Demo installations leave submissions disabled.

### Verify the first approved upload

Keep the SHA-256 of the administrator’s submitted ZIP. During review, confirm that the pending version appears in the administrator view and the previous release remains downloadable. After the approved PR merges, verify the new tag points to that exact merge result. Download the GitHub release ZIP and the member download, then run `sha256sum` on both files. Both hashes must equal the submission digest. Check `curseforge-receipt.json` on the same GitHub release for the version, SHA-256, project and CurseForge file ID, and confirm the administrator view records that ID. A receipt acknowledges submission to CurseForge. Its author dashboard shows moderation status.

### Return to the previous web version

For a feature rollback, pause synchronization and continue serving the current web image with the submission gate closed. To roll back the web binaries as well, schedule an outage and stop all writers and ingress. The 008 readiness check requires the exact 008 migration list. Preserve both current volumes, take a paired backup, and restore the verified **pre-009** application snapshot into a fresh app database using the matching 008 image, grants and configuration. Rehearse the restore, verify application readiness and account data, then point the deployment to the restored volume. Keep the archive volume and GitHub records for reconciliation. A snapshot rollback reverses every subsequent website write. Obtain acceptance of that recovery point before changing the active deployment, or continue with submissions paused and fix forward.

## Backup, recovery and transfer

On an archive-enabled installation, `node scripts/public.mjs backup backups/release-YYYYMMDD` creates a private **directory** with `database.dump` and `archive.dump`. It temporarily stops a running synchronizer so archive IDs, checksums and web submission references are mutually consistent, and restarts it after both dumps finish. Keep the pair together. Preserve the deployment configuration and secrets separately in encrypted off-host storage. Earlier installations continue writing their original single-file backups.

For a host transfer use the **updated** `mytikas-machine.sh migrate` and `import`. Format 2 contains both dumps. The exporter restores both in an isolated project and checks table/sequence fingerprints. Import checks them again before exposing the web app. Format 1 transfers remain supported. After import the destination holds the full archive database, including previous IDs and PR/release associations. Submissions and synchronization stay paused until the destination operator provides its private GitHub settings and runs `enable`. A host change therefore cannot inadvertently start a second publisher using copied GitHub credentials. The launcher’s existing 4 GiB transfer limit applies to the combined dumps and images.

For disaster recovery from a paired backup:

1. Stop the synchronizer, web, worker and tunnel. Preserve the failed volumes, the software digests, and any newer GitHub PR/tag/asset identifiers for reconciliation.
2. Stage two fresh PostgreSQL 18 databases on an isolated network, with the same names and owners as production (`mytikas_public` and `mytikas_archive`). For each backup stream the corresponding dump to its database with `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -U OWNER -d DATABASE`. Apply the release’s `public-runtime-role.sql` and `runtime-grants.sql` to the app database. Restore the recorded web credentials and outbox keys.
3. Compare the backup’s submission IDs, archive IDs, versions and SHA-256s. All non-null `addon_submissions.archive_id` values must join to exactly one archive row with matching submission ID, version and checksum. In the archive database verify `SELECT count(*) FROM archives WHERE encode(sha256(archive),'hex') <> sha256` returns zero. Check the archive ID sequence and compare published bytes and tag targets with GitHub.
4. Use the verified pair as the two retained deployment volumes in the recovery installation. Keep the web submission gate closed, start the app and check its health. Apply the archive and app synchronizer grants and private GitHub settings with `enable` on the recovered host. Review any externally published work newer than the backup with the maintainer before resuming synchronization. Preserve existing tags, PRs and release assets during reconciliation.
