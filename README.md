# Pi Inbox

Central inbox and mobile PWA for agents already running in Pi or Pi-Bolt. A global extension publishes lifecycle events over an outbound authenticated WebSocket; the original Pi process remains authoritative.

## What works

- Automatic registration on `session_start`, without a command in each session.
- Per-host Ed25519 identity generated locally and approved once in the web UI.
- Live conversation snapshots and streaming assistant text.
- Persistent inbox entries after `agent_settled` and during Pi UI prompts.
- Replies routed to the same live Pi process with stale-generation protection.
- Multiple computers through one central server.
- Android/installable PWA with VAPID Web Push and notification deep links.
- No host supervisor or inbound listener on agent computers.

## Architecture

```text
Pi/Pi-Bolt extension
  └─ outbound authenticated WSS
     └─ agent ingress (port 8092)
        └─ central inbox and persistent state
           └─ viewer UI/WSS (port 8091)
              └─ browser or Android PWA
```

The two HTTP listeners are intended for separate Pangolin resources. The viewer uses SSO; the agent ingress accepts only signed, paired host connections.

## Run locally

Requires Node 22.12 or newer.

```sh
npm install --registry=https://registry.npmjs.org/
npm start
```

Open `http://127.0.0.1:8091`. The agent relay defaults to `ws://127.0.0.1:8092` for local development; set `PI_INBOX_RELAY_URL` explicitly on each Pi host.

Configuration:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | HTTP bind address |
| `VIEWER_PORT` | `8091` | Browser UI and WebSocket |
| `AGENT_PORT` | `8092` | Agent challenge and WebSocket |
| `PUBLIC_URL` | `http://127.0.0.1:8091` | Stable viewer origin and notification links |
| `DATA_DIR` | `./data` | Persistent hosts, sessions, inbox, subscriptions, and VAPID keys |
| `PI_INBOX_RELAY_URL` | `wss://inbox-relay.borges.dev` | Agent-side relay URL |
| `PI_INBOX_STATE_DIR` | `~/.pi/agent/pi-inbox` | Agent-generated private identity |

## Pair and use

1. Start Pi normally with the extension installed.
2. Open **Agents → Pair computers** in the central UI.
3. Compare the pairing code shown in Pi with the pending host and approve it.
4. Sessions appear automatically while those Pi processes are running.
5. Open a session and answer from the composer.
6. Choose **Alerts** in the installed PWA to enable push notifications on that device.

When the last Pi process on a host exits, its sessions become offline. Agents ping every 20 seconds; the relay terminates connections after 60 seconds without a message. There is intentionally no supervisor or remote-start daemon.

## Current limitation

Ordinary assistant questions can be answered from the PWA. Pi's native `ui_prompt_start`/`ui_prompt_end` events are notification-only, so structured dialogs currently create alerts but must still be answered in their original Pi prompt surface. The protocol never pretends that a chat reply resolved such a dialog.

## Verify

```sh
npm run typecheck
node --check public/app.js
node --check public/sw.js
npm test
```

Run the real Pi-Bolt loading smoke test:

```sh
PI_INBOX_TEST_PI_BOLT=/path/to/pi-bolt node --test test/pi-bolt.test.js
```

Build the production image:

```sh
docker build -t pi-inbox:local-test .
```
