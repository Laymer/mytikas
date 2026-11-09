# DNS and public acceptance runbook

No domain or nameserver changes have been made by this implementation. The existing landing site remains on `Laymer/olympus-mytikas`. The new repository is public and protected; enable its Pages deployment only after mandatory CI passes.

## Observed rollback state (2026-11-09)

GitHub Pages API reports the old repository uses workflow publishing, custom domain `mytikas.monster`, enforced HTTPS, source `main` at `/`. Public DNS reports `dns1.registrar-servers.com` and `dns2.registrar-servers.com`; apex A answers are GitHub Pages addresses; `www` is `laymer.github.io`; the GitHub verification TXT exists. MX records point to the registrar's forwarding service. No app CNAME or DS answer was returned. These public lookups are a partial inventory, **not a complete zone export** and not proof of DNSSEC state at the registrar.

Before changing nameservers, export the complete registrar DNS zone and record existing TTLs, A/AAAA/CNAME, MX, SPF/DKIM/DMARC, verification TXT and any other subdomains. Keep this export private. In Cloudflare add the zone and compare every imported record against that export, especially mail and GitHub ownership verification. Confirm DNSSEC/DS state at the registrar; follow the registrar's coordinated DNSSEC migration procedure. Do not publish arbitrary nameserver values: use the pair assigned to this specific zone. Verify resolution from multiple resolvers after propagation. Keep apex/`www` Pages records DNS-only.

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
