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
| B01 — Audit files and full history | ⬜ To do | |
| B02 — Self-contained assets and notices | ⬜ To do | |
| B03 — Tracker and architecture | ⬜ To do | |
| B04 — Initial mandatory CI | ⬜ To do | |
| B05 — Stable ci-required aggregate | ⬜ To do | |
| B06 — Audited publication and successful remote CI | ⬜ To do | |
| B07 — Enforced main protection | ⬜ To do | |
| B08 — Failing draft PR cannot merge | ⬜ To do | |
| **P01 — Architecture contracts** | ⬜ To do | |
| P01.1 — Origins profiles and acceptance | ⬜ To do | |
| P01.2 — Shared configuration | ⬜ To do | |
| P01.3 — Independent subsystem tests | ⬜ To do | |
| P01.4 — Ownership and migration reservations | ⬜ To do | |
| P01.5 — PR template | ⬜ To do | |
| **P02 — Coverage** | ⬜ To do | |
| P02.1 — Node c8 source-map coverage | ⬜ To do | |
| P02.2 — Chromium Istanbul coverage | ⬜ To do | |
| P02.3 — Unexecuted owned files at zero | ⬜ To do | |
| P02.4 — Separate backend frontend utilities | ⬜ To do | |
| P02.5 — Isolated deterministic reports | ⬜ To do | |
| P02.6 — PR-base nonregression gate | ⬜ To do | |
| P02.7 — Reports and gap list | ⬜ To do | |
| **P03 — Landing artifact** | ⬜ To do | |
| P03.1 — Reproducible landing build | ⬜ To do | |
| P03.2 — Allowlisted public content | ⬜ To do | |
| P03.3 — Application origin links | ⬜ To do | |
| P03.4 — Root and project asset paths | ⬜ To do | |
| P03.5 — CSP and bounded availability | ⬜ To do | |
| P03.6 — Outage content and retry | ⬜ To do | |
| P03.7 — Tested Pages workflow | ⬜ To do | |
| **P04 — Application UX** | ⬜ To do | |
| P04.1 — Same-origin app and APIs | ⬜ To do | |
| P04.2 — Public Home navigation | ⬜ To do | |
| P04.3 — Validated login return | ⬜ To do | |
| P04.4 — Reject unsafe destinations | ⬜ To do | |
| P04.5 — Bounded requests and error messages | ⬜ To do | |
| P04.6 — Preserve form content and prevent replay | ⬜ To do | |
| P04.7 — Recover ambiguous submission | ⬜ To do | |
| P04.8 — Prototype privacy and account wording | ⬜ To do | |
| **P05 — Ingress security** | ⬜ To do | |
| P05.1 — Validate public configuration | ⬜ To do | |
| P05.2 — Narrow loopback proxy trust | ⬜ To do | |
| P05.3 — Secure cookies and session behavior | ⬜ To do | |
| P05.4 — Validated Cloudflare identity | ⬜ To do | |
| P05.5 — Configured origin links | ⬜ To do | |
| P05.6 — Session-free availability CORS | ⬜ To do | |
| P05.7 — Ingress security regression tests | ⬜ To do | |
| **P06 — Discord** | ⬜ To do | |
| P06.1 — Immutable submission payload | ⬜ To do | |
| P06.2 — Character motivation rules and review URL | ⬜ To do | |
| P06.3 — No private fields or mentions; bounded payload | ⬜ To do | |
| P06.4 — Submission and resubmission enqueue | ⬜ To do | |
| P06.5 — Retry and duplicate recovery | ⬜ To do | |
| P06.6 — Payload retry and outage tests | ⬜ To do | |
| **P07 — Worker lifecycle** | ⬜ To do | |
| P07.1 — Independent bounded lanes | ⬜ To do | |
| P07.2 — Leases and multi-worker safety | ⬜ To do | |
| P07.3 — Heartbeat and health command | ⬜ To do | |
| P07.4 — Bounded worker shutdown | ⬜ To do | |
| P07.5 — Bounded web shutdown | ⬜ To do | |
| P07.6 — Redacted structured logs | ⬜ To do | |
| P07.7 — Latency restart overlap signal tests | ⬜ To do | |
| **P08 — Database** | ⬜ To do | |
| P08.1 — External DB and bounded pools | ⬜ To do | |
| P08.2 — Verified TLS and CA | ⬜ To do | |
| P08.3 — Checksums and adoption | ⬜ To do | |
| P08.4 — Serialized additive migrations | ⬜ To do | |
| P08.5 — Separate owner runtime grants | ⬜ To do | |
| P08.6 — Schema readiness and liveness | ⬜ To do | |
| P08.7 — Migration TLS and preservation tests | ⬜ To do | |
| **P09 — Public laptop stack** | ⬜ To do | |
| P09.1 — Separate public project and secrets | ⬜ To do | |
| P09.2 — Pinned namespace-sharing tunnel | ⬜ To do | |
| P09.3 — No public-profile host ports | ⬜ To do | |
| P09.4 — Private token injection | ⬜ To do | |
| P09.5 — Public operations helper | ⬜ To do | |
| P09.6 — Readiness migration and tunnel recreation | ⬜ To do | |
| P09.7 — Prerequisite doctor | ⬜ To do | |
| P09.8 — Windows WSL sleep recovery docs | ⬜ To do | |
| P09.9 — Isolation and recovery tests | ⬜ To do | |
| **P10 — Recovery** | ⬜ To do | |
| P10.1 — Private public backups | ⬜ To do | |
| P10.2 — Safe fresh-target restore | ⬜ To do | |
| P10.3 — Automated restored authentication/data drill | ⬜ To do | |
| P10.4 — Backup cadence and encrypted offsite copy | ⬜ To do | |
| P10.5 — Rotation migration outbox rollback runbook | ⬜ To do | |
| **P11 — Browser regression** | ⬜ To do | |
| P11.1 — Two-host trusted HTTPS harness | ⬜ To do | |
| P11.2 — Three browser engines and Chromium coverage | ⬜ To do | |
| P11.3 — Navigation return permissions sessions | ⬜ To do | |
| P11.4 — Offline ambiguous and tunnel errors | ⬜ To do | |
| P11.5 — Visual keyboard labels focus mobile | ⬜ To do | |
| P11.6 — Frontend error coverage gaps | ⬜ To do | |
| **P12 — Backend regression** | ⬜ To do | |
| P12.1 — Registration authentication isolation | ⬜ To do | |
| P12.2 — Transitions rules concurrency roles | ⬜ To do | |
| P12.3 — Armory failure races | ⬜ To do | |
| P12.4 — Discord failure and crash recovery | ⬜ To do | |
| P12.5 — Configuration CLI helper failure paths | ⬜ To do | |
| P12.6 — Profile and fixture isolation | ⬜ To do | |
| P12.7 — Coverage gaps and gate | ⬜ To do | |
| **P13 — CI and artifacts** | ⬜ To do | |
| P13.1 — Typecheck lint ShellCheck | ⬜ To do | |
| P13.2 — Parallel isolated mandatory jobs | ⬜ To do | |
| P13.3 — Every PR least privilege pinned actions | ⬜ To do | |
| P13.4 — Deterministic merge fixtures | ⬜ To do | |
| P13.5 — Redacted failure artifacts | ⬜ To do | |
| P13.6 — Immutable image publication and pull | ⬜ To do | |
| P13.7 — Image security and inventory | ⬜ To do | |
| P13.8 — Same-tested-commit publication | ⬜ To do | |
| P13.9 — Protection bypass regression checks | ⬜ To do | |
| **P14 — Cloud handoff** | ⬜ To do | |
| P14.1 — Portable web worker migration entrypoints | ⬜ To do | |
| P14.2 — External DB and secrets | ⬜ To do | |
| P14.3 — Ingress sizing pool health contracts | ⬜ To do | |
| P14.4 — Deployment order | ⬜ To do | |
| P14.5 — Upgrade rollback rehearsal | ⬜ To do | |
| P14.6 — Laptop-to-cloud migration | ⬜ To do | |
| P14.7 — Operational signals | ⬜ To do | |
| **P15 — Live cutover** | ⬜ To do | |
| P15.1 — Export current DNS and Pages | ⬜ To do | |
| P15.2 — Cloudflare zone onboarding | ⬜ To do | |
| P15.3 — DNSSEC and nameservers | ⬜ To do | |
| P15.4 — DNS-only Pages and named app tunnel | ⬜ To do | |
| P15.5 — Public admin and reviewed rules | ⬜ To do | |
| P15.6 — Private Discord webhook delivery | ⬜ To do | |
| P15.7 — Validate new Pages before detach | ⬜ To do | |
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
| P17.1 — README and manual | ⬜ To do | |
| P17.2 — Verified operations guides | ⬜ To do | |
| P17.3 — Coverage gaps limitations | ⬜ To do | |
| P17.4 — Tracker evidence reconciliation | ⬜ To do | |
| P17.5 — Accepted release tag and artifact provenance | ⬜ To do | |

## Verification log

2026-11-09: baseline build, helper tests and all 22 isolated PostgreSQL integration checks passed. Additional implementation and verification are ongoing. No public release, domain cutover, or live showcase acceptance has been claimed.
