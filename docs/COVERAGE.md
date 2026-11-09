# Coverage measurement and gaps

Initial measurement on Node 24, 2026-11-09:

| Group | Lines | Statements | Functions | Branches |
|---|---:|---:|---:|---:|
| Backend (including demo) | 86.97% | 86.97% | 91.37% | 82.86% |
| Browser | 93.05% | 93.05% | 100% | 92.71% |
| Executable Node utilities | 45.12% | 45.12% | 47.05% | 73.26% |

The recovery/error-path follow-up measures 87.00% backend lines/statements and 82.94% branches, plus 97.06% frontend lines/statements, 97.54% branches and 100% named functions locally. The frontend floor is raised to 97.06% lines/statements and 97.5% branches; branch rounding avoids observed V8 denominator variation between equivalent runs. Other floors remain unchanged.

These are V8/c8/Istanbul measurements, not a claim of 95% coverage or exhaustive behavioral testing. Browser function coverage counts V8 named function entries; anonymous callbacks are also reflected in executable line/branch ranges. SQL and Bash are tested behaviorally and are not represented by these percentages.

`npm run coverage:backend` runs independent integration suites and includes every `src/**/*.ts` file, including unused CLI/demo entrypoints at zero. `npm run coverage:utilities` runs helper/build/restore/gate tests and includes executable `.mjs` and `.ts` under scripts, including smoke/screenshot and reporting tools at zero when unexecuted. Fixtures that copy a utility into a temporary directory are mapped back only after a preload verifies byte-identical source and records a SHA256; stale, missing or malformed evidence rejects the report. Reporting orchestration itself is included, so its unexecuted parent process lowers utility coverage rather than being silently excluded.

Browser collection requires `FRONTEND_COVERAGE=1 npm run test:browser` and `FRONTEND_COVERAGE=1 npm run test:landing:browser`, then `npm run coverage:frontend`. Both raw reports are mandatory. Every owned `public/*.js` file is included, including runtime and content scripts; no data-only JavaScript exclusion is currently needed. Source content must match the canonical repository file and V8 ranges are validated before merging. Assets without executable JavaScript, tests, dependencies and generated output are outside these three groups.

Raw directories are separate for backend, utilities and browser suites. Utility and browser merges sort their inputs and fail on missing/empty/malformed reports. HTML and JSON summaries live in ignored `coverage/<group>` directories and are uploaded by CI for seven days. The checked-in baseline is validated against measurements. PR CI loads the baseline from the immutable base SHA and rejects reductions to the proposed baseline as well as measured regressions. The only initial-establishment exception is the explicit audited bootstrap SHA that predates coverage; subsequent PRs cannot use their own baseline to weaken the gate.

Priority gaps toward 95%:

1. P12/P07: web and admin CLI process paths; full shutdown deadline, worker crash/lease expiry and overlapping-worker behavior.
2. P12/P02: utility process error branches, PostgreSQL tool extraction, native restore execution, secret generator, screenshot/live-smoke entrypoints, and coverage reporters themselves. Separate container/recovery tests exercise some of these without contributing to this coverage group.
3. P11: frontend error branches, all staff mutation ambiguity paths, visual snapshots and comprehensive accessibility checks. Chromium/Firefox workflows and a narrow two-host HTTPS/mobile/keyboard smoke pass locally; WebKit passes with CI-provisioned OS libraries.
4. P08: successful managed-CA TLS chain and hostname verification, populated legacy upgrade under restricted owner roles, and published-image upgrade/rollback rehearsal.

Production dependency audit currently reports zero vulnerabilities. Development coverage dependencies have moderate audit findings; no force/downgrade was applied to hide them. Full OS image scanning and software inventory remain release follow-up work.
