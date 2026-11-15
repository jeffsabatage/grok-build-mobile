# Grok Build Mobile

LAN Android / browser client for **Grok Build** sessions. Uses ACP (`grok agent --leader stdio`), not MCP.

The phone and PC must be on the same Wi-Fi. The gateway never leaves your LAN.

## Run the gateway

```bash
npm install
node server.mjs
```

Then open `http://<pc-lan-ip>:2420/` from the phone (or sideload the APK).

Optional environment:

| Variable | Default |
|---|---|
| `GROK_BIN` | `~/.grok/bin/grok.exe` (or `grok` on Unix) |
| `GROK_HOME` | `~/.grok` |
| `GROK_REMOTE_CWD` | process working directory |
| `GROK_REMOTE_HTTP_PORT` | `2420` |
| `GROK_REMOTE_HOST` | first non-loopback IPv4 |

A pairing secret is created at `.secret` on first run. Do not commit that file.

The gateway is for the same Wi-Fi as the phone. Do not port-forward port 2420. `/api/pair` returns that secret only to a client whose TCP address is loopback, link-local, RFC1918, or a private overlay such as Tailscale (`100.64.0.0/10`, IPv6 ULA). A public WAN address is refused. No internet login was added. Android still uses cleartext HTTP to the LAN address, because Android cannot limit cleartext to private IP ranges. Details are in [SECURITY.md](SECURITY.md).

## Windows service

```powershell
powershell -File .\scripts\install-service.ps1 -Action Install -AsNssm
```

Requires Administrator. NSSM is expected at `tools/nssm/nssm.exe`.

## APK

```powershell
cd android-app
npm install
npx cap add android   # first time only
powershell -File .\scripts\build-debug-apk.ps1
```

Sideload `downloads/Grok-Remote.apk`. The app scans the LAN for port 2420.

Gateway update endpoints:

- `GET /api/app/manifest`
- `GET /api/app/changelog`
- `GET /downloads/Grok-Remote.apk`

## What it can do

Session roster, history, live tail, send prompts, tool cards, plan approval, slash commands, file attach, voice, and LAN notifications.
