# Public prototype implementation tracker

Statuses: ⬜ To do · 🚧 In progress · ✅ Done. Existing baseline is locally implemented, not publicly accepted. A checked item requires verification; local edits alone do not satisfy merge or live-evidence requirements.

Architecture: Pages at `https://mytikas.monster`; laptop app/API at `https://app.mytikas.monster` via Cloudflare Tunnel; isolated persistent public PostgreSQL; independent worker. Node 24, current design and lifecycle preserved. See [contracts](ARCHITECTURE.md).

The empty remote permits one audited bootstrap publication. Subsequent feature changes require PRs and protected `ci-required`; no extra human approver is required.

| Feature / work item | Status | Evidence / remaining work |
|---|---|---|
| E01 — Landing artwork and chronicle | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E02 — Registration authentication CSRF | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E03 — Applicant lifecycle and immutable history | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E04 — Staff review and joining | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E05 — Roles and versioned rules | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E06 — Armory checks and leases | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E07 — Discord outbox retries | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| E08 — Containers helpers backups demo | ✅ Done locally | Baseline 979e1d0; 22 integration checks pass; public acceptance pending |
| **B — Repository and CI bootstrap** | ⬜ To do | |
| B01 — Audit files and full history | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B02 — Self-contained assets and notices | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B03 — Tracker and architecture | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B04 — Initial mandatory CI | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B05 — Stable ci-required aggregate | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B06 — Audited publication and successful remote CI | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B07 — Enforced main protection | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| B08 — Failing draft PR cannot merge | ✅ Done | Bootstrap [1ec6b8d](https://github.com/Laymer/mytikas/commit/1ec6b8d); [passing CI](https://github.com/Laymer/mytikas/actions/runs/42592311792); [rejected probe PR #1](https://github.com/Laymer/mytikas/pull/1) |
| **P01 — Architecture contracts** | ⬜ To do | |
| P01.1 — Origins profiles and acceptance | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P01.2 — Shared configuration | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P01.3 — Independent subsystem tests | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P01.4 — Ownership and migration reservations | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P01.5 — PR template | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P02 — Coverage** | ⬜ To do | |
| P02.1 — Node c8 source-map coverage | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P02.2 — Chromium Istanbul coverage | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P02.3 — Unexecuted owned files at zero | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P02.4 — Separate backend frontend utilities | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P02.5 — Isolated deterministic reports | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P02.6 — PR-base nonregression gate | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P02.7 — Reports and gap list | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P03 — Landing artifact** | ⬜ To do | |
| P03.1 — Reproducible landing build | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P03.2 — Allowlisted public content | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P03.3 — Application origin links | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P03.4 — Root and project asset paths | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P03.5 — CSP and bounded availability | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P03.6 — Outage content and retry | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P03.7 — Tested Pages workflow | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P04 — Application UX** | ⬜ To do | |
| P04.1 — Same-origin app and APIs | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.2 — Public Home navigation | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.3 — Validated login return | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.4 — Reject unsafe destinations | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.5 — Bounded requests and error messages | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.6 — Preserve form content and prevent replay | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.7 — Recover ambiguous submission | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P04.8 — Prototype privacy and account wording | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P05 — Ingress security** | ⬜ To do | |
| P05.1 — Validate public configuration | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P05.2 — Narrow loopback proxy trust | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P05.3 — Secure cookies and session behavior | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P05.4 — Validated Cloudflare identity | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P05.5 — Configured origin links | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P05.6 — Session-free availability CORS | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P05.7 — Ingress security regression tests | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P06 — Discord** | ⬜ To do | |
| P06.1 — Immutable submission payload | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P06.2 — Character motivation rules and review URL | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P06.3 — No private fields or mentions; bounded payload | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P06.4 — Submission and resubmission enqueue | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P06.5 — Retry and duplicate recovery | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P06.6 — Payload retry and outage tests | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P07 — Worker lifecycle** | ⬜ To do | |
| P07.1 — Independent bounded lanes | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P07.2 — Leases and multi-worker safety | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P07.3 — Heartbeat and health command | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P07.4 — Bounded worker shutdown | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P07.5 — Bounded web shutdown | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P07.6 — Redacted structured logs | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P07.7 — Latency restart overlap signal tests | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| **P08 — Database** | ⬜ To do | |
| P08.1 — External DB and bounded pools | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P08.2 — Verified TLS and CA | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P08.3 — Checksums and adoption | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P08.4 — Serialized additive migrations | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P08.5 — Separate owner runtime grants | 🚧 In progress | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P08.6 — Schema readiness and liveness | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P08.7 — Migration TLS and preservation tests | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| **P09 — Public laptop stack** | ⬜ To do | |
| P09.1 — Separate public project and secrets | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.2 — Pinned namespace-sharing tunnel | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.3 — No public-profile host ports | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.4 — Private token injection | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.5 — Public operations helper | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.6 — Readiness migration and tunnel recreation | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.7 — Prerequisite doctor | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.8 — Windows WSL sleep recovery docs | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P09.9 — Isolation and recovery tests | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| **P10 — Recovery** | ⬜ To do | |
| P10.1 — Private public backups | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P10.2 — Safe fresh-target restore | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P10.3 — Automated restored authentication/data drill | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P10.4 — Backup cadence and encrypted offsite copy | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P10.5 — Rotation migration outbox rollback runbook | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P11 — Browser regression** | ⬜ To do | |
| P11.1 — Two-host trusted HTTPS harness | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P11.2 — Three browser engines and Chromium coverage | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P11.3 — Navigation return permissions sessions | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P11.4 — Offline ambiguous and tunnel errors | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P11.5 — Visual keyboard labels focus mobile | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P11.6 — Frontend error coverage gaps | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P12 — Backend regression** | ⬜ To do | |
| P12.1 — Registration authentication isolation | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P12.2 — Transitions rules concurrency roles | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P12.3 — Armory failure races | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P12.4 — Discord failure and crash recovery | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P12.5 — Configuration CLI helper failure paths | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P12.6 — Profile and fixture isolation | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P12.7 — Coverage gaps and gate | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P13 — CI and artifacts** | ⬜ To do | |
| P13.1 — Typecheck lint ShellCheck | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P13.2 — Parallel isolated mandatory jobs | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P13.3 — Every PR least privilege pinned actions | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P13.4 — Deterministic merge fixtures | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P13.5 — Redacted failure artifacts | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P13.6 — Immutable image publication and pull | ✅ Done | [Published-artifact evidence](VERIFICATION.md); custom-domain cutover remains pending |
| P13.7 — Image security and inventory | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P13.8 — Same-tested-commit publication | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P13.9 — Protection bypass regression checks | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| **P14 — Cloud handoff** | ⬜ To do | |
| P14.1 — Portable web worker migration entrypoints | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P14.2 — External DB and secrets | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P14.3 — Ingress sizing pool health contracts | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P14.4 — Deployment order | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P14.5 — Upgrade rollback rehearsal | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P14.6 — Laptop-to-cloud migration | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P14.7 — Operational signals | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| **P15 — Live cutover** | ⬜ To do | |
| P15.1 — Export current DNS and Pages | 🚧 In progress | Public DNS/Pages inventory recorded; complete private zone export pending |
| P15.2 — Cloudflare zone onboarding | ⬜ To do | |
| P15.3 — DNSSEC and nameservers | ⬜ To do | |
| P15.4 — DNS-only Pages and named app tunnel | ⬜ To do | |
| P15.5 — Public admin and reviewed rules | ⬜ To do | |
| P15.6 — Private Discord webhook delivery | ⬜ To do | |
| P15.7 — Validate new Pages before detach | ✅ Done | [Published-artifact evidence](VERIFICATION.md); custom-domain cutover remains pending |
| P15.8 — Custom-domain transfer and HTTPS | ⬜ To do | |
| P15.9 — TLS DNS cache anonymous access | ⬜ To do | |
| P15.10 — Test cutover rollback | ⬜ To do | |
| P15.11 — Old repository notice and workflow retirement | ⬜ To do | |
| **P16 — External acceptance** | ⬜ To do | |
| P16.1 — External registration | ⬜ To do | |
| P16.2 — Live Discord payload and link | ⬜ To do | |
| P16.3 — Signed-out staff login return and decision | ⬜ To do | |
| P16.4 — Reject reopen resubmit history | ⬜ To do | |
| P16.5 — Armory and manual joining | ⬜ To do | |
| P16.6 — Rules and role boundaries | ⬜ To do | |
| P16.7 — Healthy notification latency | ⬜ To do | |
| P16.8 — Outage and restart persistence | ⬜ To do | |
| P16.9 — Rebuild tunnel recovery isolation | ⬜ To do | |
| P16.10 — Timestamp device commit digest evidence | ⬜ To do | |
| **P17 — Closure** | ⬜ To do | |
| P17.1 — README and manual | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P17.2 — Verified operations guides | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P17.3 — Coverage gaps limitations | ✅ Done | [Merged PR #2](https://github.com/Laymer/mytikas/pull/2); [passing complete CI](https://github.com/Laymer/mytikas/actions/runs/42594323149); scope/limitations below |
| P17.4 — Tracker evidence reconciliation | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |
| P17.5 — Accepted release tag and artifact provenance | 🚧 In progress | Implementation and local verification; final PR/CI and remaining gaps below |

## Verification log

2026-11-09: baseline build, helper tests and all 22 isolated PostgreSQL integration checks passed. Additional implementation and verification are ongoing. No public release, domain cutover, or live showcase acceptance has been claimed.

## Implementation evidence and remaining work

The bootstrap is public, CI passed after retrying as a public repository, and main protection enforces current `ci-required`, PRs, administrator enforcement and resolved conversations. Deliberately failing draft PR #1 was blocked by GitHub and closed without a bypass.

Feature work is consolidated in one integration branch/PR rather than the proposed per-subsystem PR sequence. Three agents edited disjoint subsystem files in the shared checkout while the coordinator owned package/CI integration; independent cross-reviews corrected ambiguous frontend replay handling and schema readiness. This is a deviation from the proposed worktree-per-feature delivery, not evidence that separate feature PRs were merged.

Local checks passed: full baseline integration/demo tests; ingress secure cookies/CSRF/CORS/spoofing; migration checksums/adoption/TLS fail-closed/data preservation; runtime non-owner privileges; immutable Discord payload and independent worker lanes; heartbeat/SIGTERM; helper and landing unit tests; Chromium/Firefox workflows; two-host certificate-pinned HTTPS browser smoke; real isolated public Compose startup/recreation/persistence/no host ports; PostgreSQL 18 backup/restore/login/history drill; typechecking and ShellCheck. No live Discord or Blizzard calls were used by these tests.

Remaining explicit gaps: full visual snapshot comparison and comprehensive accessibility audits; exhaustive concurrency/crash/expired-lease and provider TLS-success cases; public Docker restore against a real public stack; OS image vulnerability inventory and published-image upgrade/rollback rehearsal; full protection tests for stale/skipped/missing reports beyond aggregate/gate unit tests; DNS zone export and Cloudflare onboarding; live administrator/rules/webhook setup; Pages binding cutover; all external showcase acceptance and release tagging. Coverage is measured rather than assumed; see COVERAGE.md. Some implemented rows remain in progress until merged CI evidence and these validations are reconciled.

Public DNS inventory confirms registrar nameservers and old Pages binding on 2026-11-09. This is not a full zone export. No nameserver/domain changes or live public tunnel startup have been performed. No Cloudflare plugin was found. Live cutover requires the account-side tunnel/DNS setup described in CUTOVER.md.

## Merged implementation — 2026-11-09

PR #2 merged as `ab5c3e3` after independent review and passing required CI, including Chromium, Firefox and WebKit, the immutable-base coverage gate, public Compose persistence and full restore drill. Review corrected a vacuous migration preservation assertion and documented runnable local/demo checksum-adoption commands. WebKit exposed a synthetic lost-response test header mismatch; the harness now faithfully preserves cookies, Origin and CSRF while dropping the response.

Checked implementation rows describe tested code/contracts and documentation, not live acceptance. P08.5 supplies and verifies non-owner runtime roles for external/cloud deployment; the self-contained local/public bootstrap Compose still uses its dedicated database owner credential. Further splitting that bootstrap role is an explicit hardening follow-up. P07.6 logs generated request IDs/status/duration and job/submission references, excluding payloads and credentials. P10's real recovery drill uses an isolated PostgreSQL database, not the future public production volume. Full visual comparisons, expanded failure/concurrency coverage and the live operational rows remain pending.

The user confirmed Cloudflare and tunnel setup is not configured. Private `.env.public` and an empty `.public/tunnel-token` were initialized without changing normal/demo credentials. No webhook URL is configured. The old Pages custom-domain binding and DNS are untouched. New Actions Pages configuration uses the project preview URL without a custom domain. Accepted-release tagging remains contingent on external acceptance.


Post-merge publication correctly stopped when the main run exposed an idle PostgreSQL connection error during restart/teardown. A follow-up handles idle-pool failures with a redacted event instead of an unhandled exception and tests actual backend termination/reconnection. No failed-commit image or Pages artifact was published.

Published implementation artifacts, exact digest, pull/run smoke, current coverage and remaining live blockers are recorded in [VERIFICATION.md](VERIFICATION.md). This does not complete P16 or authorize an accepted-release tag before its evidence exists.
