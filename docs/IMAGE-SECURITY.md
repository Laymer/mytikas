# Image security checks

CI scans the **same saved image archive** that passed the Compose smoke test, using Trivy 0.76.2 pinned by image digest. It generates a complete JSON vulnerability report and CycloneDX software inventory; both are retained as the `image-security` artifact for 30 days. `ci-required` depends on this scan, so scanner failure, a missing report, or a skipped security job prevents image/Pages publication.

The release gate rejects HIGH or CRITICAL findings with an available fixed version. All findings, including unfixed OS advisories, remain in the report; no ignore list is used. This is an explicit gate policy, not a claim of zero vulnerabilities. Review unfixed findings before live acceptance and rebuild when the upstream base or vulnerability database changes. A passing point-in-time scan does not establish future safety.

The initial published image scan found six fixable HIGH findings in the npm package manager bundled by the Node base image (`brace-expansion` and npm's `undici`). The application uses direct Node entrypoints and has no runtime need for npm/Yarn, so the runtime stage now removes that tooling. Build-time npm remains in the discarded build stage. Application production dependencies independently pass `npm audit --omit=dev`; development coverage dependencies still have moderate findings documented in COVERAGE.md.

The Debian base scan also reports unfixed advisories, including HIGH/CRITICAL severities. These are deliberately retained for triage; this work does not assert that every reported package advisory is reachable through the application. Native dependencies, vendor applicability and operational exposure require separate review. The public launch is still pending.

Container commands remain `node dist/server.js`, `node dist/worker.js`, `node dist/migrate.js` and the Node admin/health entrypoints. Do not use npm inside the stripped runtime image. Native development still uses npm normally.
