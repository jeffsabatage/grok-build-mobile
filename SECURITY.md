# Security

Grok Build Mobile is a LAN gateway. The phone and the PC are expected to share trusted Wi-Fi. The pairing secret stays in `.secret` (or `GROK_REMOTE_SECRET`) on that PC and is gitignored. Do not commit `.secret`, `.env`, keystores, or `google-services.json`.

## Network boundary

- Bind stays `0.0.0.0` so the phone can open `http://<pc-lan-ip>:2420/`. That is LAN reachability, not an invitation to publish the port.
- Do not port-forward 2420. Do not put the gateway behind a tunnel or reverse proxy that accepts internet traffic. Those paths often connect from loopback, and `/api/pair` would then treat the visitor as local.
- `/api/pair` returns the pairing secret only when the TCP peer is loopback, link-local (`169.254.0.0/16`, `fe80::/10`), RFC1918, IPv6 unique-local (`fc00::/7`), or the CGNAT block used by Tailscale (`100.64.0.0/10`). Public addresses get HTTP 403 and no secret. The check uses `socket.remoteAddress` only. `X-Forwarded-For` is ignored.
- `/api/health`, the static UI, the app manifest, and the APK download stay open so the phone can find the gateway before it has the secret. They do not return the secret.
- Other `/api/*` routes still require the pairing secret.
- If this PC must be reached from outside the house, use a VPN that places the phone on a private address. Do not add an internet account in front of LAN pairing.

## Android cleartext

The shell loads `http://<LAN-IPv4>:2420`. Android Network Security Config cannot express a private IP range, and `domain-config` does not apply to raw IP hosts, so `usesCleartextTraffic` and the base cleartext flag stay on. That is safe only while the port stays on the LAN. `android:allowBackup` is false so an ADB backup does not copy WebView data off the device.

## Repo settings this tree cannot flip

This repository can carry Dependabot's version-update config (`.github/dependabot.yml`). Turning on Dependabot alerts, Dependabot security updates, and branch protection needs repository administration. The token used for automation received HTTP 403 (`administration=write` required) for:

- `PUT /repos/jeffsabatage/grok-build-mobile/vulnerability-alerts`
- `PUT /repos/jeffsabatage/grok-build-mobile/automated-security-fixes`
- branch protection and repository rulesets on `main`

### Jeff — GitHub settings for this repo

1. **Code security and analysis**
   - Enable **Dependabot alerts**.
   - Enable **Dependabot security updates** (after alerts).
   - Secret scanning and push protection are already on. Leave them on.
2. **Branches** (or a repository ruleset) for `main`
   - Block force pushes.
   - Block deletion.
   - Require a pull request before merging.
   - Required approvals: 0 if the UI allows it, so a solo maintainer can merge. Otherwise leave administrators able to bypass, and do not require a second reviewer.
   - Do not require status checks until the `check` workflow is green on a pull request.
   - Same protection is still needed on other SabatAge repos. This run could not read the private `nsight-dashboard` repository (`repository not found`), so nothing there was changed.
