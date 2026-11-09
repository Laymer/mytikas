# DNS and public acceptance runbook

## Current rollout state — 9 November 2026

The [production rollout and acceptance runbook](PRODUCTION-ROLLOUT.md) is the current operational reference. Public Pages/HTTPS and the application tunnel are already cut over; administrators already exist. Production remains pre-004; email activation/rosters require a staged migration and private mail setup. Earlier claims below about pending DNS/Pages, unavailable Docker, missing administrators or unimplemented recovery are historical and superseded. Live mail, reviewed rules/private webhook, actual-backup restore proof, separate-network/device checks and operator acceptance remain open. Do not announce recruitment or tag an accepted release yet.

## Historical implementation records (superseded where noted)


No domain or nameserver changes have been made by this implementation. The existing landing site remains on `Laymer/olympus-mytikas`. The new repository is public and protected. Its landing preview is deployed at https://laymer.github.io/mytikas/ after mandatory CI; the custom-domain transfer remains pending.

## Observed rollback state (2026-11-09)

GitHub Pages API reports the old repository uses workflow publishing, custom domain `mytikas.monster`, enforced HTTPS, source `main` at `/`. Public DNS reports `dns1.registrar-servers.com` and `dns2.registrar-servers.com`; apex A answers are GitHub Pages addresses; `www` is `laymer.github.io`; the GitHub verification TXT exists. MX records point to the registrar's forwarding service. No app CNAME or DS answer was returned. These public lookups are a partial inventory, **not a complete zone export** and not proof of DNSSEC state at the registrar.

Before changing nameservers, export the complete registrar DNS zone and record existing TTLs, A/AAAA/CNAME, MX, SPF/DKIM/DMARC, verification TXT and any other subdomains. Keep this export private. In Cloudflare add the zone and compare every imported record against that export, especially mail and GitHub ownership verification. Confirm DNSSEC/DS state at the registrar; follow the registrar's coordinated DNSSEC migration procedure. Do not publish arbitrary nameserver values: use the pair assigned to this specific zone. Verify resolution from multiple resolvers after propagation. Keep apex/`www` Pages records DNS-only.

## Automated Cloudflare preparation

Use [Cloudflare automation](CLOUDFLARE-AUTOMATION.md) to authorize once and create the pending zone, dedicated tunnel and application CNAME. The command preserves existing Cloudflare records, stores tokens privately, and leaves registrar delegation separate until the complete DNS export and DNSSEC review are ready.

## Application preparation

Follow [public operations](PUBLIC-OPERATIONS.md). Create a named Cloudflare Tunnel with public route `app.mytikas.monster` to `http://127.0.0.1:8080`. No Cloudflare Access login policy should intercept visitors. Store its token privately in `.public/tunnel-token`; never paste it into chat or a command line. Create the private staff Discord webhook and put the official URL in `.env.public`. Start with `node scripts/public.mjs up`, bootstrap admin interactively, and publish reviewed guild rules through the website before inviting applicants. Treat default prototype rules as unreviewed.

Verify HTTPS, host-only Secure cookies, application readiness, no API cache, and separate real-client rate limits. Do not infer working public ingress from local Compose tests. Confirm Discord contains only character/motivation/rules/revision/reference/review link, with mentions disabled and no account email.

## Pages cutover

First enable Actions Pages for `Laymer/mytikas` without a custom domain, then set repository variable `PAGES_ENABLED=true`. The CI workflow uploads the allowlisted landing artifact and deploys only after `ci-required` succeeds on main. Validate the project URL and direct assets. Keep the old custom-domain binding in place until this succeeds.

Then remove the custom-domain binding from `olympus-mytikas` and assign `mytikas.monster` to `mytikas`. Preserve the account/domain verification TXT throughout. GitHub must issue/validate HTTPS for the new binding; confirm both apex and `www` redirects and certificate validity. A workflow-based Pages deployment does not require a CNAME file. Do not delete the old repository/history.

If cutover fails, remove the new binding, restore the old repository's `mytikas.monster` binding and enforced HTTPS, and rerun the old publishing workflow if needed. Restore DNS from the recorded export only for records actually changed. Stop application exposure with `node scripts/public.mjs stop`; never delete database volumes to stop access. Test this rollback before retiring the old publishing workflow. After full acceptance, disable that old workflow and add a notice pointing to the new repository.

## External acceptance record

From a separate network with no VPN, record date/time, device/browser, source commit, image digest and database migration version. Verify landing → registration → submission → real Discord notification within 30 seconds → signed-out staff review link → login → correct application → applicant-visible decision. Exercise rejection/reopening/revised submission and immutable history; approval/Armory/manual joining; rules/roles and permissions. A fixture membership result is not live Armory evidence.

Stop the laptop service: Pages must still load and show unavailable/unknown service status. Restart and verify sessions, accounts/history persist. Rebuild with the helper and verify tunnel recovery and local/demo isolation. Run a private backup and restore drill. Redact screenshots/logs before saving evidence. Only then tag the accepted prototype and record the Pages artifact, immutable container digest and migration set in the tracker.

Cloudflare's current [dashboard tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) uses **Networking → Tunnels**. After adding/verifying the zone, create a remotely managed tunnel and configure its published application route as above. Use the token-file mechanism already provided by Compose rather than copying the token-bearing installation command into shell history. During initial planning on 2026-11-09, Cloudflare/tunnel setup was not configured; the later execution record below supersedes that state.

## Executed Cloudflare preparation — 2026-11-09

Scoped API setup created the dedicated remotely managed tunnel and proxied application CNAME, verified the loopback route plus 404 fallback, and saved the connector token privately. The actual public Compose stack was initialized and started: web/database/worker healthy, web readiness HTTP 200, worker health successful, tunnel healthy with four connections, no published host ports. This is connector/control-plane evidence, not external HTTPS acceptance.

Cloudflare initially imported the Pages apex/www records as proxied and omitted the GitHub verification TXT. Four Pages records were changed to DNS-only; the TXT was copied from matching answers from both authoritative registrar nameservers. Other existing records were verified unchanged. Private pre-change snapshots are under `.public`; no credential values are in this repository.

The user confirmed the registrar's full record list contains only the known Pages A/www CNAME, five MX, SPF TXT and GitHub verification TXT records, and that domain email is unused. The MX/SPF records remain preserved. Namecheap's [free forwarding requires its DNS services](https://www.namecheap.com/support/knowledgebase/article.aspx/308/2214/how-to-set-up-free-email-forwarding/), so copying those records would not establish continuity for an active mailbox; none is currently used.

The parent authoritative DNS returned no DS record and Cloudflare DNSSEC was disabled during preparation. Assigned nameservers are `elaine.ns.cloudflare.com` and `rob.ns.cloudflare.com`; the original rollback nameservers are `dns1.registrar-servers.com` and `dns2.registrar-servers.com`. The registrar change has been requested from the user because the agent has no registrar access. Check live delegation before treating activation as complete. Pages custom-domain binding remains on the old repository. Administrator/rules/webhook and external showcase acceptance remain pending.

### Delegation verified — 2026-11-09 11:15 UTC

The user saved the custom nameservers at Namecheap. The authoritative `.monster` parent now delegates to Cloudflare and the Cloudflare zone is active. Both assigned authoritative servers resolve the application, retain the original Pages A/www records as DNS-only, and preserve the five MX, SPF and GitHub verification TXT records. Google DNS has updated; Cloudflare's public resolver still held the prior negative application answer at this observation (remaining negative-cache TTL about 59 minutes). No DS was present at the parent.

The Cloudflare API reports Universal SSL enabled, but its certificate-pack list was still empty and application HTTPS handshakes were not yet succeeding. Do not treat DNS activation or a healthy connector as TLS acceptance. Cloudflare documents [15 minutes to 24 hours for initial issuance](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/). Public HTTPS/availability/cookie checks and the GitHub Pages custom-domain move remain pending successful certificate provisioning. The old landing website remains available. A private public-database backup was taken after startup.

### HTTPS and Pages binding verified — 2026-11-09

The initial edge certificate became available during verification. Real HTTPS requests through Cloudflare returned 200 for liveness/readiness/availability and account/admin HTML. Session cookies were Secure, HttpOnly, SameSite=Lax and host-only. API responses were `no-store` and Cloudflare `DYNAMIC`; the landing-origin availability response allowed the exact origin without credentials or a session cookie. Normal system-DNS requests also succeeded; some remote resolver caches may still lag.

The old Pages custom-domain binding was detached and assigned to `Laymer/mytikas`, retaining the verification TXT. GitHub reports HTTPS enforced and certificate approved. `https://mytikas.monster/` returned 200 with application links and no password forms; `https://www.mytikas.monster/` and the HTTP apex redirected to the HTTPS apex. A live Chromium smoke followed Apply/sign-in to the application with no uncaught errors and verified that the signed-out staff sign-in link retains its local review destination. No applicant registration, staff login, live Discord or Armory acceptance is claimed by this smoke.

The old repository/history and publishing workflow are retained until P16 acceptance. The public database currently has no administrator, default rules still need review, and the Discord webhook is not configured. Bootstrap interactively with `node scripts/public.mjs admin`; inject the webhook privately and restart the worker using the documented public helper workflow. Keep the laptop/Docker running for public application availability. The current public database has a private backup under ignored `backups/`.
