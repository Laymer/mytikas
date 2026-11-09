# Cloudflare setup automation

`npm run cloudflare -- plan` inventories the intended account, zone, tunnel and DNS record without changing Cloudflare. `npm run cloudflare -- apply` creates the missing zone, dedicated remotely managed `mytikas-public` tunnel and proxied `app.mytikas.monster` CNAME, verifies the tunnel route, and saves the connector token directly into `.public/tunnel-token` with mode 600. No global API key is needed.

## One-time authorization

Create a token in [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens) with these dashboard permissions:

- Account → Cloudflare Tunnel → Edit (also called Cloudflare One Connector: cloudflared → Edit).
- Account → Account Settings → Read, to discover the intended existing account.
- Zone → Zone → Edit, to find/create the zone.
- Zone → DNS → Edit, to inspect records and create the application route.

Scope the account permissions to the intended account. Creating a zone may require temporary All zones scope; narrow or revoke the setup token after provisioning. Use an existing Cloudflare account; signup and account verification are interactive. This command creates no paid subscription or extra account.

Save only the token in `.public/cloudflare-api-token` using a private editor. Keep `.public` mode 700 and the token file mode 600. Never paste it into chat, argv, shell history, tracked files or CI secrets. `.public` is excluded from Git and the Docker build. The API token is used only during setup; the tunnel container gets only its connector token.

If more than one account is visible, the command prints account IDs and refuses to guess. Select the correct account using `npm run cloudflare -- plan ACCOUNT_ID` and use the same argument for `apply`. Account IDs are not credentials.

## Execution and recovery

```sh
npm run cloudflare -- plan
npm run cloudflare -- apply
npm run cloudflare -- plan
```

Requests use the fixed official HTTPS API, reject redirects, have bounded responses/timeouts, and never automatically replay mutations. Provider error bodies are withheld to avoid accidental secret disclosure. Private snapshots (`.public/cloudflare-before-*.json`) record the current **Cloudflare** DNS/configuration before mutations. They are not a full export of the registrar's DNS zone.

Setup stores IDs in `.public/cloudflare-state.json`, refuses a conflicting account/zone/tunnel, and refuses to replace existing application DNS or unrelated tunnel configuration. A repeated successful `apply` preserves existing credentials and routes. If an interrupted create succeeded remotely but its response was lost, run `plan` and inspect the dedicated tunnel before retrying; the command may refuse adoption rather than guess ownership. It never deletes remote resources to recover.

An exclusive `.public/cloudflare-setup.lock` prevents concurrent applies. If the process is killed, confirm no setup process remains before removing that lock. Do not delete the saved state or token as a routine retry. A different existing tunnel token requires explicit investigation, not silent replacement.

## DNS delegation and launch boundary

The command does not change registrar nameservers/DS, existing apex/`www`/mail/verification records, GitHub Pages binding, Cloudflare Access policies, or start the public stack. A newly created zone remains pending until delegation is completed. Cloudflare's DNS scan and public DNS lookups are not a complete zone export.

Before delegation, obtain the complete existing-provider DNS inventory and compare/import every record, preserving mail, verification, CAA and delegated subdomains. Keep GitHub Pages apex/`www` DNS-only. The setup output provides the exact assigned nameservers; use them only after the full inventory and DNSSEC/DS review in [CUTOVER.md](CUTOVER.md). Registrar authorization is separate from a Cloudflare API token. Existing wildcard Access policies may still intercept the application; external acceptance must verify anonymous access.

After verified delegation, use [PUBLIC-OPERATIONS.md](PUBLIC-OPERATIONS.md) to start services and bootstrap the administrator/reviewed rules. Discord webhook setup is independent. A successful API setup is not evidence of live HTTPS, tunnel connectivity, healthy application, DNS propagation or external showcase acceptance.

Official contracts checked for this implementation: [zone creation](https://developers.cloudflare.com/api/resources/zones/methods/create/), [tunnel API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/), [tunnel token](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/), [full zone onboarding](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
