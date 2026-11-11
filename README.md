# Pi Inbox

Remote access to live Pi and Pi-Bolt sessions through an unmodified Plannotator Inbox UI. Our extension owns host integration and the outbound authenticated relay; Plannotator owns the web app, machine views, offline outbox, replies, and attachment rendering.

## Architecture

```text
Pi/Pi-Bolt extension
  └─ outbound authenticated WSS
     └─ agent ingress (port 8092)
        └─ virtual Plannotator machine door (port 8093)
           └─ central Plannotator Inbox
              └─ unchanged UI proxied on port 8091
````

Each paired computer appears to Plannotator as a separate linked machine. No Plannotator extension is required on agent computers, and no agent computer accepts inbound connections.

## What works

- Automatic registration on `session_start`.
- Per-host Ed25519 identity approved once by the owner.
- One Plannotator thread per live Pi session, with conversation snapshots and streaming updates.
- Plannotator replies and new messages delivered to the original Pi process with generation checks.
- Image replies through Pi's native text-plus-image message API; non-image uploads are written to the extension's private state directory.
- **Stop agent** through a Plannotator question card, implemented with `ctx.abort()`.
- Plannotator's native machine list, offline state, event stream, and offline outbox.
- Simultaneous Pi processes on one host.
- Heartbeats every 20 seconds and relay expiry after 60 seconds without a message.
- Existing push subscriptions and the previous interface at `/legacy` for host pairing.

There is intentionally no supervisor or remote process launcher.

## Run locally

Requires Node 22.12 or newer and the `plannotator` CLI.

```sh
npm install --registry=https://registry.npmjs.org/
VIRTUAL_MACHINE_ADDRESS=http://127.0.0.1:8093 npm start
````

Open `http://127.0.0.1:8091`. Open `/legacy` to approve a new computer. Agent connections default to `ws://127.0.0.1:8092` for local development; set `PI_INBOX_RELAY_URL` explicitly on each Pi host.

For a local virtual-machine link, Plannotator's test sandbox allows loopback HTTP:

```sh
PLANNOTATOR_TEST_SANDBOX=1 npm start
````

Production uses HTTPS through Tailscale Serve for the virtual door. The browser never needs access to that door: it uses the SSO-protected viewer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | HTTP bind address |
| `VIEWER_PORT` | `8091` | Plannotator UI proxy and legacy pairing |
| `AGENT_PORT` | `8092` | Agent challenge and authenticated WebSocket |
| `DOOR_PORT` | disabled | Virtual Plannotator machine door |
| `PUBLIC_URL` | `http://127.0.0.1:8091` | Stable viewer origin and notification links |
| `VIRTUAL_MACHINE_ADDRESS` | none | HTTPS machine-door address used by central Plannotator |
| `DATA_DIR` | `./data` | Relay state, virtual links, uploads, subscriptions, and central Plannotator data |
| `PLANNOTATOR_BINARY` | `plannotator` | Upstream CLI used by the central runtime |
| `PLANNOTATOR_DISABLED` | `0` | Set to `1` only for legacy local development |
| `PI_INBOX_RELAY_URL` | `wss://inbox-relay.borges.dev` | Agent-side relay URL |
| `PI_INBOX_STATE_DIR` | `~/.pi/agent/pi-inbox` | Agent identity and received non-image uploads |
| `PI_INBOX_AUTO_PAIR_LOCAL` | `0` | Set to `1` in single-session containers to auto-approve loopback agents |
| `PI_INBOX_HANDOFF_TOKEN` | none | Session-scoped relay lease token injected into remote handoff workers |
| `PI_INBOX_DISABLED` | `0` | Set to `1` to disable the extension for the current process |

## Pair and use

1. Start Pi normally with this extension installed.
2. Open `/legacy`, choose **Agents → Pair computers**, and approve the pending host after comparing its code.
3. The hub links that host to central Plannotator as a virtual machine.
4. Open the machine's thread in the unchanged Plannotator UI and reply normally.
5. While the agent runs, the thread includes a **Stop agent** question card.

When the last Pi process on a host exits, its sessions become offline. Plannotator can hold writes in its own outbox and delivers them after the host reconnects.

## Current limitations

- Pi's native `ui_prompt_start`/`ui_prompt_end` dialogs remain notification-only; arbitrary structured terminal dialogs cannot be answered through the virtual thread.
- Remote process launch is not provided.
- The legacy interface is retained for pairing and compatibility, not as the primary UI.

## Verify

```sh
npm run typecheck
npm test
````

The integration test starts a real Plannotator process, links a virtual host, and verifies thread reads, image downloads, replies, uploads, Stop, and UI proxying. Set `PLANNOTATOR_TEST_BINARY=/path/to/plannotator` if it is not on `PATH`.

Run the real Pi-Bolt loading smoke test:

```sh
PI_INBOX_TEST_PI_BOLT=/path/to/pi-bolt node --test test/pi-bolt.test.js
````

Build the production image:

```sh
docker build -t pi-inbox:local-test .
````
