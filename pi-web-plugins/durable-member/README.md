# Durable Member — pi-web Plugin

A workspace panel for observing and steering **durable members** (bd-186). A
durable member has none of the things the harness normally scrapes for insight —
no named pi session, no `pi --resume`, no session JSONL, no run manifest — so
this plugin reads the member's durable storage directly (read-only) and forwards
control commands to the one process that owns it.

Two halves, deliberately split:

- **Read half.** A read-only viewer. `server-plugin.js` opens the member's
  `store.sqlite` with `{ readOnly: true }` (`store-reader.js` has no write path at
  all) and streams conversation frames (committed entries plus the live
  generation: partial text, per-tool-call output and details, retries,
  compaction, `runFailure`) and the durable task graph to the browser panel.
  The channel carries the **wire frame** (`ConversationWatchFrame`: `entriesWindow`
  + `cursor` + `hasEarlier` + `live`, with the task graph on the envelope), and
  the panel performs the single `reduceConversationFrames` pass — the server
  never publishes a pre-reduced view.
  A crashed member's last committed state still renders after a restart, and a
  live row the crash left behind is reported stale (`owner gone · last known
  generation`) instead of as a running generation: the server module derives
  liveness from the row's `updatedAt` heartbeat against `staleAfterMs` (30 s),
  never from the row's own `status`.
- **Write half.** A command forwarder. Nobody writes the storage; every control
  command (steer / follow-up / write / abort / abort-submission / configure /
  compact / reset) is sent to the member's control socket, where the owner
  validates, authorizes, dedupes by `requestId` and applies it.

The contract is mirrored in plain JS here (`contract.js`, `store-reader.js`,
`control-client.js`) and in TypeScript under `src/durable-member/`. Both sides
carry `SYNC WARNING` comments, and
`src/__tests__/durable-member-contract-parity.test.ts` drives both over shared
fixtures so the mirror cannot drift silently.

---

## How to Verify

> The operator-facing walkthrough — enabling the plugin, seeding a member, the
> browser's expected rendering, the crash/liveness cases, and the failure-mode
> table — is [`docs/bd-186-userguide.md`](../../docs/bd-186-userguide.md). The
> steps below are the plugin-local view of the same checks.

### 1. Run the guard, contract and reader tests

```bash
pnpm vitest run pi-web-plugins/durable-member
```

This runs:

| Test | What it proves |
|---|---|
| `pi-web-plugin.test.js` | Browser and server `apiVersion`s are among the versions the **installed** host accepts (parsed from `node_modules/@jmfederico/pi-web/dist/{plugin-api,server-plugin-api}.d.ts`, never hardcoded), the manifest declares `module` + `serverModule` + `machineSpecific`, and the panel/action are registered |
| `contract.test.js` | Command validation, frame reduction, the live-liveness reduction (fresh/old heartbeat, owner gone, flagged-not-dropped) and the panel's control-availability rules |
| `store-reader.test.js` | The plugin reader opens read-only, exposes no write member, pages by cursor and reads details |
| `server-plugin.test.js` | Member discovery, read-only invariant, request/channel operations, control forwarding failure when the member is down, panel-tier-only forwarding, panel-credential-only presentation, and the owner-published `control.port` (a browser-supplied port is ignored) |
| `wire-seam.test.js` | The **cross-module seam**: the real `server-plugin.js` `watch` / `load-earlier` / `entry-details` payloads are fed into the real `panel.js` (`handleChannelData`, `loadEarlier`, `showEntryDetails`), asserting the raw `entriesWindow` frame renders entries with no adapter and that no operation's shape drifts |

The cross-implementation parity test lives with the TypeScript library:

```bash
pnpm vitest run src/__tests__/durable-member-contract-parity.test.ts
```

### 2. Set up the symlink

```bash
ln -sf "$PWD/pi-web-plugins/durable-member" ~/.pi-web/plugins/durable-member
readlink -f ~/.pi-web/plugins/durable-member
```

Server-backed plugins are read at session-daemon start, so **restart the daemon**
(not just reload the browser) after installing or changing this plugin:

```bash
# Interrupts live sessions and terminals on this machine.
sudo systemctl restart pi-web-sessiond
```

### 3. Seed a fixture member and open the panel

The panel is screenshot-able with no live member. Seed a reference storage (this
is a **reference stand-in**, not pi-durable):

```bash
MEMBERS_ROOT="${BELAYD_DURABLE_MEMBERS_DIR:-$HOME/.pi-web/durable-members}"
node pi-web-plugins/durable-member/fixtures/seed-member.mjs "$MEMBERS_ROOT" bd-186-fixture
```

Point the plugin's server module at the same root (it defaults to
`<plugin dataDirectory>/members`):

```bash
export BELAYD_DURABLE_MEMBERS_DIR="$MEMBERS_ROOT"   # for the session daemon
sudo systemctl restart pi-web-sessiond
```

Open pi-web, select a workspace, and click the **Durable Member** tab (or press
`Ctrl+K` / `Cmd+K` → **Open Durable Member**). With the fixture seeded the panel
must show:

| Region | Expected |
|---|---|
| Member list | `bd-186-fixture (live)` |
| Transcript | user message, assistant message, a **tool call** with its JSON input, a **tool output** with details (`bytes`, `lines`), a **retry** marker (`429 rate limited`), a **compaction** marker (`82 000 → 21 000 tokens`), and a final assistant message |
| Live banner | `tool-call · attempt 2 · retry 2/3` plus the streamed partial text and the running `write` call |
| Task graph | `bd-186-scout [done] unowned …`, `bd-186-implement [running] child:bd-186-fixture · waiting on bd-186-scout · foreground`, `bd-186-proof [blocked] child:bd-186-fixture · waiting on bd-186-implement · background` |
| Controls | Steer / Follow up / Abort / Compact enabled; Configure / Reset disabled until the confirmation input equals the member id |

With no seeded member, the panel shows the explicit empty state:
*"No durable members. A member appears here once its storage exists at
`members/<memberId>/store.sqlite` under this plugin's data directory."*

### 4. Verify the read-only invariant

The panel must never open a member's storage writable. Two independent checks:

```bash
# a) the plugin reader has no write path at all
grep -n "appendEntry\|setLiveGeneration\|upsertTask\|resume(" \
  pi-web-plugins/durable-member/store-reader.js
# Expected: no matches (the file is commented about them; the code has none)

# b) live: the viewer process still cannot write
pnpm vitest run src/__tests__/durable-member-store.test.ts \
  src/__tests__/durable-member-viewer.test.ts
```

The viewer additionally *probes* at open time: it refuses a handle that reports
`readOnly: false`, attempts one `appendEntry()` and one `resume()` expecting
`ReadOnlySessionError`, and asserts the reader exposes no `submit`/`resume`.

### 5. Verify the two-process WAL probe

The bead required proving that a second `readOnly` process can read deltas while
the owner holds its write connection:

```bash
pnpm vitest run --config vitest.integration.config.ts durable-readonly-viewer
```

(Use this form rather than `pnpm test:integration -- durable-readonly-viewer`:
the extra argument is dropped, so that spelling runs the whole integration suite
and takes ~35 s instead of ~1 s.)

The test spawns a real writer process (WAL, inserting entries) and a real
read-only viewer process over the same file, asserts the viewer observed
increasing committed counts while the writer stayed connected, asserts its
`INSERT` was rejected with *"attempt to write a readonly database"*, and asserts
the rejected write left no row. Two crash cases run too: one where the writer
dies before committing a live row (no live banner) and one where it commits a
`streaming` row and then SIGKILLs itself (rendered stale, by the liveness seam
and by an injected clock past the heartbeat bound). If `node:sqlite` is
unavailable it prints
`Skipping integration test: node:sqlite unavailable (<reason>)` and marks the
test skipped — it never passes silently.

### 6. Verify the control socket and the authority gate

```bash
# The socket and each tier credential are per-member and private.
stat -c '%a %n' ~/.pi-web/durable-members/bd-186-fixture/{control.sock,control.panel.token}
# Expected: 600 …/control.sock ; 600 …/control.panel.token  (the member dir is 700)
# A supervisor-tier member also issues control.supervisor.token; there is no
# phase-subagent credential.

# A TCP fallback publishes the owner-chosen port; clients read this file and
# never accept a port from a browser request.
test -f ~/.pi-web/durable-members/bd-186-fixture/control.port \
  && cat ~/.pi-web/durable-members/bd-186-fixture/control.port
```

| Scenario | Expected |
|---|---|
| Steer from the panel | Delivered; the transcript shows the entry; the owner applies it with `submit({ whenBusy: "steer" })` |
| Send the same command twice (same `requestId`) | Second response says **already applied (duplicate requestId)**, one writer call |
| Abort | The owner's `abort()` seam runs; conversation and task teardown happen there, inside the owner. This bead proves the seam call, not task cancellation |
| Configure / Reset without typing the member id | The button stays disabled and the owner would answer `confirmation-required` |
| Supervisor content steer (fleet tier) | Refused: `fleet-supervisor may not send steer`. Lifecycle (`abort`, `abort-submission`) is allowed |
| A supervisor credential presenting a `steer` claimed as `panel-human` | Refused with `authority-mismatch`; nothing is applied. The credential selects the tier, not the frame |
| A supervisor credential on a panel-only surface | Refused with `unauthorized` before any command is parsed |
| `phase-subagent` credential | None is ever issued, so that tier cannot authenticate |
| A command addressed to another member | Refused by the owner (`member-mismatch`); the socket is per-member scoped by path |
| Wrong or missing token | Rejected before any command frame is parsed, and the channel closes |
| Configure with an empty model | The button is disabled and the panel names the missing field (`Configure needs a model…`) |

The same gate exists on the other transport: a command queued as
`commands/<requestId>.json` while the member was down is applied through the same
dispatcher on start and acknowledged with `receipts/<requestId>.json`. A queued
file claiming a tier other than the queue origin's is refused
(`authority-mismatch`) and quarantined under `rejected/`, never applied. A failed
apply keeps the command file for the next drain, while an applied-but-unrecorded
command is quarantined so it can never be applied twice.

---

## How to Use

### Installation

```bash
mkdir -p ~/.pi-web/plugins
ln -sf /absolute/path/to/pi-web-plugins/durable-member ~/.pi-web/plugins/durable-member
sudo systemctl restart pi-web-sessiond   # server-backed plugin: daemon restart required
```

The package is plain JavaScript with no build step. Its `package.json` declares
both entries:

```json
"piWeb": { "plugins": [ { "id": "durable-member", "browserRoot": ".",
  "module": "pi-web-plugin.js", "serverModule": "server-plugin.js", "machineSpecific": true } ] }
```

Uninstall: `rm -rf ~/.pi-web/plugins/durable-member`, restart the daemon, then
hard-reload the browser.

### Member root and `dataDirectory` layout

The server module resolves members from `BELAYD_DURABLE_MEMBERS_DIR` when set,
otherwise from `<plugin dataDirectory>/members`. One directory per member:

```
<membersRoot>/
└── bd-186-fixture/
    ├── member.json          # { conversationId, label? }; conversationId defaults to "main"
    ├── store.sqlite         # reference store: entries, live_generations, task_nodes (WAL)
    ├── control.sock         # member-owned control socket (0600), created by the running member
    ├── control.panel.token  # panel-tier credential (0600), created on first use
    ├── control.supervisor.token  # supervisor-tier credential (0600), only if that tier is served
    ├── control.port         # only with the TCP fallback: owner-chosen 127.0.0.1 port (0600)
    ├── commands/            # file transport: queued commands, <requestId>.json (0600)
    ├── receipts/            # one receipt per queued command attempt
    ├── rejected/            # quarantined refusals and applied-but-unrecorded commands
    ├── dedupe.jsonl         # requestId ledger replayed on start
    └── dedupe.tombstones.jsonl  # bounded window of recently pruned requestIds
```

`dataDirectory` is host-owned and persistent; it is **not** the member's storage
directory, only the discovery root the plugin is allowed to read.

### Liveness configuration

A member is only "live" while its live row's `updatedAt` heartbeat is inside the
bound: the row's own `status` survives a crash, so it is never trusted. The
server module resolves the seam **once per activation** and uses it for both the
sidebar summary and the watch channel. Defaults match the TypeScript viewer
(`src/durable-member/viewer.ts`):

| Setting | Default | Meaning |
|---|---|---|
| `settings.staleAfterMs` | `30000` | Heartbeat bound (~300 missed 100 ms partials). A row **at or past** the bound is stale with reason `no-heartbeat`. A non-numeric or non-positive value falls back to the default; a `liveness.staleAfterMs` override wins over the setting |
| owner probe (`liveness.ownerAlive`) | treat as alive | Process-local override: returning `false` stales the row immediately with reason `owner-gone` |
| clock (`liveness.clock`) | `Date.now()` | Process-local override, so a test can advance a fake clock across the bound and assert the published frame flips instead of crafting an already-stale row |

The clock and the owner probe are functions, so they are `activate()` overrides
rather than JSON settings; `staleAfterMs` is the only setting. A stale row is
reported in the frame (`stale: true` + `staleReason`) and never counted in the
`members` view (`live` is false).

### Two transports, split by durability

| Transport | When it is the right one | Where |
|---|---|---|
| Files | The member is down or not started yet; delivery must survive | `<memberStateDir>/commands/`, drained at start/turn start, receipts in `receipts/` |
| Control socket | The member is running and the caller needs an answer (steer, abort) | `<memberStateDir>/control.sock` (unix, 0600); the presented per-tier credential selects the tier; optional TCP fallback on `127.0.0.1` only, with the port read from the member's `control.port` |

Both converge on the same `dispatch()` inside the owner, so `requestId` is the
single dedupe key: the same command delivered by file *and* by socket applies
once. The fleet mailbox (`events/`) stays the supervisor → member transport;
this plugin does not add a second file channel for anything that outlives a
process.

### Authority matrix

| Command | `panel-human` | `fleet-supervisor` | `phase-subagent` |
|---|---|---|---|
| `steer` (after current tool round) | yes | no | no |
| `followup` (next run) | yes | no | no |
| `write` (entry the model never sees) | yes | no | no |
| `abort-submission` | yes | yes | no |
| `abort` | yes | yes | no |
| `compact` | yes | no | no |
| `configure` | confirmation = member id | no | no |
| `reset` | confirmation = member id | no | no |

A caller whose presented credential derives the supervisor tier gets lifecycle
only, so that tier does not become a second author; phase sub-agents own their
own child conversations, so writes go child → parent, never
sideways. The matrix lives in `src/durable-member/authority.ts` and is evaluated
against the tier the transport proves: the **credential that matched** on the
socket, the queue origin for a file, this module's `panel-human` constant, or the
dispatcher's constructor tier. It is never the command's own `authority` field; a
mismatched claim is refused with `authority-mismatch`. The panel's disabled
buttons are a convenience, not the gate.

**Trust boundary.** Credential separation defends against cross-tier wiring
mistakes: a supervisor client pointed at the panel surface, a replayed or
mis-tiered mailbox file, or a frame that relabels its own role. It does **not**
defend against a hostile **same-uid** process, which can read the other tier's
0600 credential and present it. This is a coordination boundary inside one user
account, not a privilege boundary between users.

### Internals overview

| File | Responsibility |
|---|---|
| `pi-web-plugin.js` | Browser entry (apiVersion 5): workspace panel + "Open Durable Member" action |
| `panel.js` | `<pi-web-durable-member-panel>` — member list, transcript, live banner, task graph, load-earlier, control bar with the confirmation flow |
| `server-plugin.js` | Server entry (apiVersion 5): member discovery, `members` / `load-earlier` / `entry-details` / `control` requests, `watch` channel. Reader + forwarder only; forwards only its own `panel-human` tier |
| `store-reader.js` | Read-only SQLite reader (mirror of the reference store's read half) |
| `control-client.js` | NDJSON control client (mirror of `src/durable-member/socket.ts`); resolves the transport from the member's `control.port` / `control.sock`, never from a request |
| `contract.js` | Command validation, frame reduction, control availability (mirror of `src/durable-member/{commands,contract}.ts`). Hand-rolled on purpose: the plugin has no build step, so zod validation is a documented TS-side exception |
| `fixtures/` | Shared parity fixtures plus `seed-member.mjs` for screenshots |

### Related documentation

- [Durable member panel and control plane](../../docs/durable-member-panel.md) — design, security surface, probe result
- [Durable member operator guide](../../docs/bd-186-userguide.md) — how to enable, seed, verify and operate the panel and control plane
- [pi-web Plugins API](../../node_modules/@jmfederico/pi-web/docs/plugins.md) — requests, channels, `dataDirectory`
- [Proof of Work viewer](../proof-of-work/README.md) — the sibling browser-only plugin in this repo
