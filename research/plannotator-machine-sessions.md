# Plannotator linked machines and new agent sessions

**Research date:** 2026-11-10  
**Evidence:** backnotprop/plannotator GitHub releases, tagged official documentation and source, plus pi-phone's own source for integration impact. No blogs or second-hand comparisons. Source links for the latest release pin tag commit `67582e0e0d944f1cb19e31b9b97d73a6f94e046b`; v0.28.48 links pin `60024aed055161c868dfa57d2be5508f88a739ac`. “Launch” below means creating a new agent process/session, not attaching to an arbitrary existing terminal process.

## Conclusion

**The latest release is v0.28.60, published 2026-11-10 at 11:51:18 UTC.** Its own release notes do not announce a new machine-link protocol or launch backend; the important changes relative to pi-phone's v0.28.48 arrived mainly in v0.28.52, v0.28.53, v0.28.55, and v0.28.58 ([latest release API](https://api.github.com/repos/backnotprop/plannotator/releases/latest), [v0.28.60 notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.60), [tagged source](https://github.com/backnotprop/plannotator/tree/67582e0e0d944f1cb19e31b9b97d73a6f94e046b)).

The three relevant operations are different:

| Operation | What Plannotator does | What it does **not** do |
|---|---|---|
| **Connect an existing machine** | Pair two existing Plannotator Inboxes; each becomes a view/controller of the other's threads over an authenticated Tailscale HTTPS door ([machine guide](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L5-L23)). | It does not provision a computer, install an agent, or create a session. |
| **Create an agent on an already-linked machine** | New message sends a `to.launch` request through the viewing machine to the target; the target starts Claude Code, Pi, or Codex with its own installation, folder, credentials, trust, and settings ([remote launch](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L134-L153)). | It requires an existing link and a ready backend. It is not machine provisioning and is not adoption of an arbitrary external Pi TUI. |
| **Remote terminal access** | For a remote launched thread, Plannotator offers **Copy attach command**. “Open in Terminal” is local-only macOS Terminal automation and never crosses the machine link ([window behavior](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L203-L220), [route implementation](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-launch.ts#L1303-L1318)). | There is no Plannotator browser shell, SSH transport, or remote terminal-opening API. The person must arrange terminal access to the target separately. |

For pi-phone, **upgrading the central UI and enabling upstream launch are separate decisions**. The existing virtual door already speaks `machine_links: 1` and explicitly advertises `launch_from_machines: 0`, so the source model supports keeping new-session creation disabled while retaining existing live-Pi access. Changing that flag without implementing the launch contracts would be incorrect. Basic v0.28.60 interoperability was not live-tested in this research.

## What changed since v0.28.48

| Release | Relevant primary-source change |
|---|---|
| **v0.28.42** | Introduced linking two computers through Settings → Machines or `plannotator inbox link`, using Tailscale, with offline answers delivered when the machine wakes ([release notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.42)). |
| **v0.28.48 — 2026-11-03** | Already contains the machine coordinator, `machine_links: 1`, link CLI, and Tailscale transport ([baseline health](https://github.com/backnotprop/plannotator/blob/60024aed055161c868dfa57d2be5508f88a739ac/packages/server/inbox.ts#L1007-L1022), [baseline machine guide](https://github.com/backnotprop/plannotator/blob/60024aed055161c868dfa57d2be5508f88a739ac/docs/agent-guides/inbox-machines.md#L5-L23)). It has no launch implementation; v0.28.52 introduces that feature. |
| **v0.28.52 — 2026-11-08** | Added local and linked-machine starts for **Claude Code and Pi**, default-on on macOS/Linux; added scratch folders, Stop/Delete/reply-to-resume, trust handling, and permission cards ([release notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.52)). |
| **v0.28.53 — 2026-11-08** | Added create-folder-and-start, Git clone-and-start, and project-row **+** shortcuts. Clones run on the selected linked machine using that machine's Git sign-in; no password/token is passed ([release notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.53)). |
| **v0.28.55 — 2026-11-08** | Added updating an older linked machine from this Inbox; its notes also cover v0.28.54. The target asks GitHub for the newest release and performs its own checksum-checked update/restart ([release notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.55), [implementation guide](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L82-L89)). |
| **v0.28.58 — 2026-11-10** | Added **Codex** launching, folders on any drive, and the sidebar **Agents** section in place of Machines ([release notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.58)). |
| **v0.28.59 / v0.28.60 — 2026-11-10** | Refined the Agents sidebar and phone composer, including running sessions followed by “Start a new session”; v0.28.60 also fixes replies following a Claude conversation that acquires a new session id. No additional launch backend is announced ([v0.28.59](https://github.com/backnotprop/plannotator/releases/tag/v0.28.59), [v0.28.60](https://github.com/backnotprop/plannotator/releases/tag/v0.28.60)). |

A direct comparison of the tagged files found `apps/hook/server/inbox-link-command.ts`, `packages/server/inbox-transport-tailnet.ts`, and `packages/server/inbox-links.ts` byte-identical between v0.28.48 and v0.28.60 ([v0.28.48 transport](https://github.com/backnotprop/plannotator/blob/60024aed055161c868dfa57d2be5508f88a739ac/packages/server/inbox-transport-tailnet.ts), [v0.28.60 transport](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-transport-tailnet.ts)).

## Connecting existing machines

### Commands and window routes

On the machine offering the link:

```sh
plannotator inbox link --offer --tailscale
```

On the other machine:

```sh
plannotator inbox link '<plannotator://link?...>'
plannotator inbox link --list
plannotator inbox unlink '<machine name or id>'
```

The link command accepts `--address <host:port>` to override the offer address, `--back <host:port>` for the reverse path, and `--one-way` to skip the reverse link. The offer is a `plannotator://link?v=1&id=…&name=…&tailnet=…&secret=…&code=…` URL ([CLI source and usage](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/apps/hook/server/inbox-link-command.ts#L1-L38), [link-state format](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-links.ts#L1-L25)).

Equivalent local window/control APIs are:

```text
POST /api/inbox/machines/offer       { serverSession?, tailscale? }
POST /api/inbox/machines/link        { serverSession?, link | code, address?, back?, one_way? }
POST /api/inbox/machines/:id/unlink  { serverSession? }
GET  /api/inbox/machines
GET  /api/inbox/control/machines
POST /api/inbox/control/machines/offer | link | unlink
```

Window linking/unlinking is local-only (`403 local_only` through the tailnet); control routes use the registry bearer token ([route guide](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L94-L105)).

By default, B redeems A's offer as a `platform: "machine"` device, verifies A's `health` (`inbox_id` matches and `machine_links >= 1`), then sends its own offer through A's `link-back` route so A can redeem the reverse link. Failure of the reverse path rolls back the partial link unless `--one-way` was requested ([pairing workflow](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L16-L19)).

### Transport, storage, and offline behavior

- **Transport:** HTTPS through Tailscale Serve to `https://<machine>.<tailnet>.ts.net:<port>/api/inbox/device/*`, using Tailscale's certificate and normal TLS verification. The door takes port 8443 or the next free port through 8450. Only a MagicDNS `.ts.net` HTTPS origin is accepted; arbitrary hosts, IPs, localhost, embedded credentials, paths, queries, and fragments are rejected. Loopback HTTP is accepted only under `PLANNOTATOR_TEST_SANDBOX` ([transport source](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-transport-tailnet.ts#L1-L49)).
- **Not SSH or the phone relay:** machines never pair/connect over the Wi-Fi listener and get no relay carriage or pushes. SSH between peers is explicitly outside the design ([machine guide](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L12-L14), [door implementation](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-devices.ts#L604-L640)).
- **Pairing credentials:** a machine offer has a 256-bit secret and six-digit code, is single-use, expires after ten minutes, and closes after five wrong codes. Redemption issues a new 256-bit `tok_…` bearer token ([device source](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-devices.ts#L581-L640)).
- **Data ownership:** each machine keeps its own Inbox and threads. A remote list is cached in memory only, not copied to another machine's disk; a machine cannot request `machines=1`, preventing transitive reads/echoes ([shape and merged reads](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L5-L32)).
- **Live link:** the peer authenticates `health`, then holds the remote event stream using `Last-Event-ID`. Heartbeats are 15 seconds and 20 seconds without a byte is considered dead ([peer-line guide](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L23-L30)).
- **Offline writes:** JSON writes use a persistent, ordered, idempotent per-machine outbox on the sending/viewing Inbox and can wait for a sleeping machine. File uploads/markups are streamed only while online and are not held ([forward/outbox rules](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L32-L62)).
- **At rest:** `inbox/machines.json` is written atomically with mode 0600 and stores stable Inbox ids, per-link bearer tokens, transport, reverse device id, and link time ([link store](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-links.ts#L1-L48)).

## Creating agents on an already-connected machine

### Exact user workflows

In **New message → To → Start a new session**, the person selects **Claude Code**, **Pi**, or **Codex**, then a project/folder and writes the first message. The folder selection determines the target machine. Current folder choices include an existing project, a new scratch folder, another folder (including external/network drives), **Create `<folder>` and start**, or a Git URL to clone before starting ([launch overview](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L1-L23), [scratch/folder/clone contracts](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L97-L104)).

For a remote start from A on B:

1. A reads B's `health`; `launch_from_machines: 1` means launch is enabled, `0` means explicitly off, and a missing field means an older Inbox ([health source](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox.ts#L1449-L1462)).
2. A posts compose's `to.launch` through `/api/inbox/m/<B>/messages`.
3. B starts the backend in B's folder with B's credentials/configuration and owns the resulting thread. A's merged list remains a remote view ([remote send](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L136-L141)).
4. If B is asleep, A holds the launch in its outbox and starts it once when B returns; Cancel is possible before it leaves A. Attachments cannot yet accompany a new session launched on another machine ([offline launch](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L142-L143)).
5. Stop, Try again, Trust folder, and Delete cross the link as machine-only launch actions. Open in Terminal and launch settings do not ([remote actions](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L139-L143)).

Messaging an **already-running** session is a different compose target: `to: { host, session }`. Creating one uses `to: { launch: … }` ([compose implementation](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-compose.ts#L158-L195)).

### HTTP creation API

There is no dedicated `plannotator inbox launch`/`inbox start` command in the tagged CLI overview; creation is part of the guarded compose/window API. The CLI exposes Inbox lifecycle, MCP, link/unlink, and project commands ([CLI overview](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/apps/hook/server/inbox-command.ts#L1-L31)).

Local creation:

```http
POST /api/inbox/messages
```

Remote creation from A to linked B:

```http
POST /api/inbox/m/<B-inbox-id>/messages
```

Representative request:

```json
{
  "body": "Investigate the failing tests.",
  "thread_name": "Investigate test failure",
  "idempotency_key": "a-unique-key",
  "serverSession": "<current-window-server-session>",
  "to": {
    "launch": {
      "agent": "pi",
      "project_id": "prj_..."
    }
  }
}
```

Accepted target shapes in the tagged source are:

```json
{ "agent": "claude-code", "project_id": "prj_..." }
{ "agent": "pi", "scratch": true }
{ "agent": "codex", "folder": "~/code/project" }
{ "agent": "pi", "folder": "~/code/new-project", "create": true }
{
  "agent": "claude-code",
  "folder": "~/code/repo",
  "clone": { "url": "https://github.com/owner/repo", "branch": "optional" }
}
```

The normal response contains `thread_id`, `message`, `project`, `replayed`, and, for a start, `launch: { id, state: "starting" | "failed" }`. An idempotent replay cannot start a second agent. An offline remote launch can instead return HTTP 202 with outbox state ([target types](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-launch.ts#L108-L121), [compose validation and response](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-compose.ts#L158-L190), [launch response](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-compose.ts#L249-L268)).

The viewing Inbox then calls B's authenticated `/api/inbox/device/messages` door with `X-Plannotator-Window: 1`. This is an internal, version-specific window/door contract, not a versioned external SDK or proto API ([remote forward authorization](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L138-L140)).

Lifecycle routes include:

```text
POST /api/inbox/launch/:id/stop
POST /api/inbox/launch/:id/retry
POST /api/inbox/launch/:id/trust
POST /api/inbox/launch/:id/delete
POST /api/inbox/launch/:id/open       # local Terminal only
GET|POST /api/inbox/launch/settings
GET  /api/inbox/launch/folders
GET  /api/inbox/launch/clone
GET  /api/inbox/launch/clone-check
```

Remote lifecycle calls use `/api/inbox/m/<machine>/launch/:id/<action>`; `open` and settings are not forwarded ([route list](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-launch.ts#L49-L62), [remote restrictions](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L134-L154)).

### Supported launch backends

The built-in launch-host registry contains exactly **Claude Code, Pi, and Codex**. Other Inbox-connected backends (for example OpenCode, Gemini, Qwen, and DeepSeek Harness) are not launch hosts merely because they can use the Inbox ([host registry](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-launch.ts#L452-L467)).

| Backend / launch id | Requirements | Process and resume model |
|---|---|---|
| **Claude Code** — `claude-code` | Claude Code **2.1.314+**, its Plannotator plugin/mod, and sign-in. | `claude --bg --name … --settings …`; Claude's supervisor hosts the background session. Permission flags honor the person's existing consent/settings ([hosting model](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L7-L23), [start command](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L37-L46)). |
| **Pi** — `pi` | `pi` **0.79.1+** on PATH and Plannotator's Pi extension in Pi settings. | One Inbox-owned `pi --mode rpc --session-id <uuid> --name <thread name>` per session, with `PLANNOTATOR_INBOX_TOOL=1`. It exits when the Inbox exits; the next reply starts a new process with the same session id and resumes the session file ([Pi model](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L156-L174)). |
| **Codex** — `codex` | Codex **0.149.0+**, signed in, with a `plannotator-inbox` MCP entry. | One Inbox-owned `codex app-server` per thread, JSON-RPC over stdio. It uses the person's config/login/model/sandbox; Plannotator does not write Codex's config ([Codex model](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L186-L201)). |

Upstream's launch documentation names the `pi` executable, not `pi-bolt`; Pi-Bolt launch support should not be inferred from the general Pi integration ([Pi readiness check](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L174-L175)).

Launch is default-on on macOS/Linux and default-off/not offered on Windows. The target's `inboxLaunch.enabled` setting controls remote starts; turning it off prevents new starts but does not remove Stop/Delete/Retry for existing launches ([configuration behavior](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L5-L5), [v0.28.58 Windows caveat](https://github.com/backnotprop/plannotator/releases/tag/v0.28.58)).

## Security and authorization constraints

- **Linking is the remote-launch permission**, plus launch being enabled on the target. A linked machine acts with the target owner's ability to start/stop/trust agents; there is no separate per-agent remote credential ([remote permission model](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L134-L140)).
- **Remote start/stop/trust requires a window-marked request.** A checks same-origin `Origin`/Host and the current `serverSession`, records `window: true`, and sends `X-Plannotator-Window: 1`. B honors that mark only from an authenticated machine token, never from a phone. Bare agent/script calls receive `403 window_only` ([forward check](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-machines.ts#L843-L867), [door check](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/packages/server/inbox-compose.ts#L331-L336)).
- **Tailnet guests cannot start, stop, delete, trust, or write through a forward.** Their replies also cannot respawn a stopped session. The owner can act through their own tailnet devices, subject to route restrictions ([window routes and guests](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L203-L205)).
- **The window mark is not a boundary against same-user local programs.** The official guide explicitly accepts that a process running as the user can forge Origin/window headers or read session/machine tokens and then control agents on a linked machine ([accepted threat](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L89-L93)).
- **Backend secrets remain on the target.** Git clone uses the target's own Git sign-in with interactive prompting disabled; the launch request carries no Git password/token ([clone contract](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L144-L149)).
- **Folder trust is an explicit security decision.** Claude trust writes are owner-only and window-only; a changed folder/warning invalidates the consent read. Pi has no launch permission mode; unsupported Pi extension dialogs are cancelled and reported rather than shown as permission cards ([trust authorization](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L111-L119), [Pi dialogs](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L174-L176)).

## Relevance to pi-phone

Current pi-phone pins the central binary to v0.28.48 (`Dockerfile:1-7`) and presents each paired computer as a virtual Plannotator machine over the hub's outbound-WSS architecture (`README.md:3-16`). Its virtual health response is:

```json
{
  "ok": true,
  "inbox_id": "ibx_...",
  "machine_links": 1,
  "version": "0.28.48",
  "launch_from_machines": 0
}
```

(`server/virtual-machines.js:781-790`). Its compose `POST messages` route accepts only an existing online `body.to.session`; otherwise it returns `session_not_live` (`server/virtual-machines.js:799-803`). Unknown launch/update routes end at `device_route_not_found` (`server/virtual-machines.js:957-965`). The documented architecture intentionally has no supervisor or remote process launcher (`README.md:31`, `README.md:78-82`).

1. **Keep launch disabled for a central-binary-only upgrade.** `launch_from_machines: 0` is the explicit upstream “off” signal, whereas an absent field means “too old.” It should suppress remote start offers for virtual hosts while existing `to.session` messaging continues. This is a source-level compatibility conclusion, not a live upgrade test ([capability interpretation](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L152-L153)).
2. **Do not just change the flag to 1.** Real support requires the launch block in session/folder discovery, all accepted `to.launch` forms that pi-phone chooses to expose, idempotent start responses, lifecycle routes, offline/cancel semantics, and window-provenance enforcement. Most importantly, it needs a real process supervisor on each Pi host, driven over pi-phone's outbound authenticated WSS—not merely more virtual-door HTTP shims.
3. **Native upstream Pi launch is a different architecture from pi-phone.** Upstream starts and owns a fresh RPC process tied to its Inbox; pi-phone delivers messages to the original, independently running Pi/Pi-Bolt process through its extension. Native launch would add process creation/resume, not improve same-process attachment ([upstream Pi process model](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L156-L183); pi-phone `README.md:20-31`).
4. **Remote terminal support is not inherited.** Upstream gives only copyable attach commands for another machine, so pi-phone would still need its own terminal product if interactive remote shells are desired. Plannotator's machine link does not supply one.
5. **Watch the generic linked-machine Update UI.** v0.28.55+ can show Update for an older virtual door. The latest source treats an older door's missing `update` route as “too old” and offers manual `plannotator update && plannotator inbox restart` commands. Those commands make sense for a real Plannotator installation, not for pi-phone's virtual host; upgrade testing should check and account for this affordance rather than treating it as an agent-host updater ([update behavior](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-machines.md#L82-L89)).
6. **Regression-test the newer Agents/phone UI against virtual sessions.** v0.28.58-v0.28.60 add machine-grouped agent lists, start buttons, and a phone recipient/start picker. The zero launch capability is therefore important to keeping creation controls consistent with pi-phone's existing live-session-only API ([v0.28.58 notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.58), [v0.28.60 notes](https://github.com/backnotprop/plannotator/releases/tag/v0.28.60)).

## Verification limits

- Release metadata was rechecked against GitHub's `/releases/latest` API on 2026-11-10. Source findings use the exact v0.28.60 and v0.28.48 tag archives/commits cited above.
- No v0.28.60 ↔ pi-phone interoperability test was run, and no repository code was changed.
- The creation routes are documented as window/door implementation routes, not a stable external SDK. Pin any future compatibility work to an exact Plannotator version.
- The tagged guide says the real Codex was not run by its tests/build smoke; Codex behavior here is evidenced by the implementation and stubs, not an independent live Codex run ([Codex proof note](https://github.com/backnotprop/plannotator/blob/67582e0e0d944f1cb19e31b9b97d73a6f94e046b/docs/agent-guides/inbox-launch.md#L199-L201)).
