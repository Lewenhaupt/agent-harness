# Durable member panel and control plane (bd-186)

A durable member has no pi session name, no `pi --resume`, no session JSONL and
no run manifest. pi-web is session-shaped end to end, so a durable member is
invisible unless something reads its storage deliberately. This doc owns the two
halves that make it observable and steerable: the read-only viewer panel and the
member-owned control plane.

pi-durable is **not installed and not vendored**. The typed seam
(`src/durable-member/contract.ts`) is ours, and a small **reference durable
store** (`src/durable-member/standalone-store.ts`, `node:sqlite`, WAL) stands in
for a pi-durable storage in tests, in the two-process probe and in the panel
fixture. It is a stand-in, not pi-durable: swapping in the real library should be
a module replacement behind the same contract.

For the operator-facing walkthrough — install, seed, what the panel must render,
the crashed-member cases, the control-plane drills and the failure-mode table —
see [`bd-186-userguide.md`](bd-186-userguide.md). This document owns the contract,
the authority matrix and the threat model.

## Read half: a viewer that cannot write

```
member state dir                      pi-web daemon                 browser
─────────────────                     ─────────────                 ───────
store.sqlite  ──readOnly:true──▶  server-plugin.js  ──watch channel──▶  panel.js
control.sock  ◀──command────────  (reader + forwarder)
```

- `openDurableViewer()` opens the reference store with `readOnly: true` and then
  proves the invariant before returning: the handle reports `readOnly`, one
  `appendEntry()` and one `resume()` throw `ReadOnlySessionError`, and the
  reader surface has no `submit`/`resume`/`write` member. The reader *type* has
  no write member at all, so a writable call is a compile error for TypeScript
  callers and a runtime assertion for the plain-JS plugin.
- `conversation.watch()` yields `ConversationWatchFrame`s: the committed entries
  window plus the live generation (streamed partial text, per-tool-call output and
  details, retry state, compaction state, `runFailure`). Cadence defaults to
  100 ms.
- Liveness is the reader's decision, not the row's: a live row outlives a crash
  with `status` still `streaming`, so the viewer's pure `reduceLiveLiveness`
  reduction marks it **stale** (`stale: true` plus `staleReason`) when an injected
  owner-liveness seam says the process is gone (`owner-gone`) or when its
  `updatedAt` heartbeat is older than `staleAfterMs` (`no-heartbeat`, default
  30 s — ~300 missed 100 ms partials). A stale generation is reported, never
  dropped: the panel shows the last known generation and says the owner is gone.
- `harness.watchTaskGraph()` yields every task with its owner edge, status,
  `waitingOn` and `background` flag.
- `transcript()` pages: `window()`, `loadEarlier(cursor)`, `details(entryId)` and
  `conversationId`, so the panel can merge gaps and load earlier entries without
  re-reading the whole history.
- A crashed member still renders: its committed entries live in the store, and
  the panel shows the last committed window. A crash that happened *before* a
  live row was committed shows no live banner; a crash *after* one leaves the row
  behind, and it renders as the stale case above (`owner gone · last known
  generation`) instead of a banner claiming `streaming`.

The pi-web side is `pi-web-plugins/durable-member`: browser apiVersion 5 (v5 is
required for `context.backend`), a `serverModule`, and a plain-JS mirror of the
contract. `store-reader.js` has no write path and `assertReadOnlyStore` fails
closed if that ever changes. The panel is not in the session sidebar — a durable
conversation is not a pi-web session, and only a session-source abstraction in
pi-web itself would put it there (out of scope for this bead).

## Write half: exactly one writer, so nobody writes the DB

pi-durable states that one process owns a storage at a time, with no
cross-process locking. Single-writer is therefore not a preference. Every
external actor sends a **command**, and the owner translates it:

| Command | Owner translation |
|---|---|
| `steer` | `submit({ whenBusy: "steer" })` — joins after the current tool round, same run |
| `followup` | `submit({ whenBusy: "followup" })` — starts the next run |
| `write` | `submit({ type: "write" })` — an entry the model never sees |
| `abort-submission` | `submission.abort()` |
| `abort` | `abort()` — the owner's teardown point. This bead proves the seam call; stopping the conversation and cancelling its tasks is the owner's own contract (bd-185), not observable from here |
| `configure` | `configure()` — changes the agent's contract, so gated |
| `compact` | `compact()` |
| `reset` | `reset()` — changes the agent's contract, so gated |

Flow inside the owner: validate (`commands.ts`, zod) → authorize against the
**proven tier** (`authority.ts`: credential-derived on the socket, queue origin
for a file, constructor tier for direct dispatch) → dedupe check → apply
(`dispatch.ts`) → **record** the requestId. Recording only after a successful apply is what makes a failed
apply retryable: a writer error or throw leaves no ledger entry, so the retry is
applied instead of being acked as a duplicate of an effect that never happened.
A crash in the middle of an apply can lose one command (a human retries); a
doubled steer is worse. The ledger is `<memberStateDir>/dedupe.jsonl` (in-memory
map + append-only JSONL, replayed on start, pruned deterministically under a
cap). Pruned-but-recent ids move to a bounded tombstone window in
`<memberStateDir>/dedupe.tombstones.jsonl`, so a late retry of an evicted id
still reports `duplicate: true` instead of re-applying.

### The credential selects the tier

`command.authority` is a **claim**, never the authorization decision. The socket
derives the connection's tier from the credential the client presents, and
`authorize()` only accepts an opaque `VerifiedAuthority` (branded with a
module-private symbol) — a raw `DurableAuthority` string is a compile error.

One listener (one `control.sock`) serves the tiers the owner configures in
`startControlServer({ tiers })`. There is one credential file per authenticatable
tier, `control.panel.token` and `control.supervisor.token` (0600, created on
first use, stable across restarts); `phase-subagent` has **no** credential and
cannot authenticate at all. The handshake compares the presented credential
against every served candidate in constant time without an early exit and
answers one generic `unauthorized` on failure, so the answer never reveals which
tier was compared or which check refused it (the token-length bound is a DoS
guard, and it rejects without saying so).

| Transport | Tier source | Enforcement |
|---|---|---|
| Control socket | The credential that matched (`control.panel.token` / `control.supervisor.token`) | A frame whose claim differs from the credential-derived tier is refused with `authority-mismatch` before dispatch; a credential the listener does not serve is `unauthorized` |
| File mailbox | `drainDurableCommands({ authority })` — the queue origin (a file cannot present a credential) | A queued file whose `authority` differs is refused and quarantined |
| Panel server module | `PANEL_AUTHORITY = "panel-human"`; it reads only `control.panel.token` | Only `panel-human` commands are forwarded; the owner re-derives the tier from that credential |
| Direct `dispatch()` | `createDurableDispatcher({ authority })` (required) | A command claiming another tier is refused; the writer is never reached |

So a supervisor client presenting its **own** credential to the panel surface
cannot content-steer: if the listener serves only the panel tier, that credential
is `unauthorized`; if it serves both, the credential derives the supervisor tier
and a `steer` claimed as `panel-human` is `authority-mismatch` — either way the
writer is never called. The same holds for a replayed or mis-tiered mailbox file,
and for a frame that relabels its own role. See the trust-boundary section below
for the adversarial same-uid case this does not cover.

### Trust boundary: what this does and does not defend

**Defends against cross-tier wiring mistakes.** The credential, not the frame or
the caller's declaration, selects the tier: a supervisor client accidentally
pointed at the panel surface, a command file copied into the wrong queue, or a
frame that writes a different `authority` into its own payload is refused before
the writer is reached. The dispatcher's constructor-bound tier is a second,
independent check.

**Does not defend against a hostile same-uid process.** All credentials live in
the member's state directory owned by the same uid; such a process can read
`control.panel.token` and present it, or read/write the mailbox files. This
control plane is a coordination boundary *inside one user account*, not a
privilege boundary between users or tenants. Treat the state directory's unix
permissions as the real boundary and do not rely on tier separation against
code already running as the same user.

## Two transports, split by durability

| Transport | Use it for | Location |
|---|---|---|
| Files | anything that must survive the member being down or not yet started: cold-start delivery, supervisor commands | `<memberStateDir>/commands/<requestId>.json` (tmp + rename, 0600), drained at start/turn start; `<memberStateDir>/receipts/<requestId>.json` records the outcome |
| Member-owned socket | interactive steer/abort while the member runs, where the caller needs an answer | `<memberStateDir>/control.sock` (unix, 0600) + one credential per authenticatable tier (`control.panel.token` / `control.supervisor.token`, 0600); a TCP fallback publishes `<memberStateDir>/control.port` (0600) |

Mailbox dispositions after a drain:

- applied / already a duplicate → receipt written, command file removed;
- transient writer failure (`writer-failed`) → failure receipt, command file
  **retained** in `commands/` so the next drain retries it;
- applied but the ledger could not record it (`applied-unrecorded`), or a
  permanent refusal (bad shape, wrong member, wrong tier, unknown submission) →
  failure receipt and the file is **quarantined** under `<memberStateDir>/rejected/`
  so it is evidence, never redelivered.

The fleet's existing mailbox (`events/` supervisor → member, read at turn start)
remains the supervisor's durable file transport; this control plane converges
with it on `submit()` and on `requestId` rather than adding a second durable file
channel. Both transports end in the same dispatcher, so a command delivered by
file and by socket at once applies exactly once.

The optional TCP fallback binds `127.0.0.1` only and publishes its owner-chosen
port in `<memberStateDir>/control.port`; readers resolve the transport from that
file, and nothing in the control plane can listen on a routable address. The
panel/server module never accepts a port from a browser request — that would let
a panel request point the member's valid token at an arbitrary loopback service.

## Authority matrix

| Command | `panel-human` | `fleet-supervisor` | `phase-subagent` |
|---|---|---|---|
| `steer` | allow | refuse | refuse |
| `followup` | allow | refuse | refuse |
| `write` | allow | refuse | refuse |
| `abort-submission` | allow | allow | refuse |
| `abort` | allow | allow | refuse |
| `compact` | allow | refuse | refuse |
| `configure` | confirm with member id | refuse | refuse |
| `reset` | confirm with member id | refuse | refuse |

- A human at the panel may steer, follow up and abort freely.
- `configure`/`reset` require `confirmation` equal to the member id — deterministic
  and hard to misfire. The gate lives in `authority.ts`; the panel only disables
  the button.
- A caller whose presented credential derives `fleet-supervisor` gets lifecycle
  only, so that tier does not become a second author.
- Phase sub-agents get nothing: they own their own child conversations, and
  writes go child → parent, never sideways.

The matrix is evaluated against the tier the owner bound to the transport (see
[The credential selects the tier](#the-credential-selects-the-tier)),
never against the command's claim. The claim is integrity-checked, and a mismatch
is refused with `authority-mismatch`. The same owner check scopes a socket per
member: a command whose `memberId` differs is refused with `member-mismatch`.

## Security surface

This is a local command surface that can steer an agent and change its
model/tools, so treat it as its own review target:

| Property | How it is enforced |
|---|---|
| Loopback only | Unix socket by default; the TCP fallback binds `127.0.0.1` explicitly and cannot be configured to another host |
| Per-member scoping | Socket path is inside the member's state dir; the owner refuses a command whose `memberId` is not its own |
| Tier binding | The socket derives the tier from the presented per-tier credential (constant-time, generic failure); mailbox tier is the queue origin. A claim that disagrees is refused (`authority-mismatch`) on every transport, and `authorize()` cannot be called with a raw string |
| Credential separation | `control.panel.token` / `control.supervisor.token` are issued only for tiers the listener serves; no phase-subagent credential exists. A credential the surface does not serve is `unauthorized` |
| Transport from owner state | The TCP fallback port is read from the member's `control.port`; a panel request cannot supply a port, so a member credential cannot be aimed at another loopback service |
| Authentication | First NDJSON frame must be `{"type":"auth","token":...}`. The credential is compared in constant time against every served tier, the failure is one generic `unauthorized`, and a malformed first frame is rejected **before** any command frame is parsed |
| File permissions | State dir `0700`, socket `0600`, each credential file `0600`, queued command and receipt files `0600` |
| Bounded input | Command text is limited to 64 KiB UTF-8; control frames to 256 KiB; auth tokens to 1024 bytes; transcript pages to 1000 entries |
| No dashboard write path | The plugin server module opens the store read-only and asserts it; there is no endpoint that opens it writable |
| Gated contract changes | `configure`/`reset` require confirmation equal to the member id; any other tier the presented credential derives is refused, so a supervisor-rooted caller has no route to them |
| Supervisor lifecycle only | Content steer/follow-up/write/configure/reset/compact are refused for the tier a supervisor credential derives (`fleet-supervisor`) |
| Dedupe | `requestId` is the single key across both transports; a repeat applies nothing |

Known limitation, deliberate: each tier credential is static (not rotated per
connection) because a client queued while the member was down needs the same
secret after a restart, and there is exactly one writer to coordinate. Treat
`control.panel.token` / `control.supervisor.token` as that tier's credential, and
the state directory's unix permissions as the real security boundary between
users.

## The two-process WAL probe (prove it, do not assume)

pi-durable documents one owner per storage and `readOnly` as the designed second
process; SQLite WAL allows concurrent readers. That was verified, not assumed:

```bash
pnpm test:integration -- durable-readonly-viewer
```

`test/durable-readonly-viewer.integration.test.ts` creates one store in a
tmpdir, spawns `test/fixtures/durable-readonly-writer.mjs` (a real Node process
holding a read-write WAL connection and inserting five entries) and
`test/fixtures/durable-readonly-viewer.mjs` (a real Node process opening the same
file with `new DatabaseSync(path, { readOnly: true })`). The viewer polls,
reports each observed committed count, then attempts an `INSERT`.

Observed result:

- the read-only process observed the committed count grow **one entry at a time,
  from 1 to 5, while the writer held its read-write connection** (five distinct
  deltas, not just the final state);
- its `INSERT` was rejected with *"attempt to write a readonly database"*
  (SQLite read-only connection), and a later read showed the row never landed;
- `openDurableViewer()` — the panel's actual read path — read the same five
  entries from the same live file inside the test.

If `node:sqlite` is unavailable the test prints
`Skipping integration test: node:sqlite unavailable (<reason>)` and marks itself
skipped; it never passes silently.

## Seeding the panel fixture

```bash
MEMBERS_ROOT="${BELAYD_DURABLE_MEMBERS_DIR:-$HOME/.pi-web/durable-members}"
node pi-web-plugins/durable-member/fixtures/seed-member.mjs "$MEMBERS_ROOT" bd-186-fixture
```

The script writes `member.json`, a `store.sqlite` with committed entries (user,
assistant, tool call + output with details, retry marker, compaction marker), a
live generation with a running tool call, a three-node task graph (done,
running, blocked-background) and one receipt. Point the plugin at the same root
with `BELAYD_DURABLE_MEMBERS_DIR` (or copy it under the plugin's
`dataDirectory/members`), restart `pi-web-sessiond`, and open the **Durable
Member** panel. See the plugin README for the expected rendering table and the
empty state.

## Where the code lives

| Path | Owns |
|---|---|
| `src/durable-member/contract.ts` | Read surface types, `DurableReader`, conversation-view reduction, `ReadOnlySessionError` |
| `src/durable-member/commands.ts` | Command union + zod boundary schema and refusal-code mapping |
| `src/durable-member/authority.ts` | Verified tier binding (`VerifiedAuthority`), role × kind matrix, confirmation gate |
| `src/durable-member/dedupe.ts` | requestId ledger (map + JSONL, replay, prune) and bounded tombstones |
| `src/durable-member/dispatch.ts` | The one command → writer translation; record-after-apply |
| `src/durable-member/socket.ts` | Control socket server + client (one listener, per-tier credentials, credential→tier derivation, unix + optional loopback TCP with published `control.port`, framing) |
| `src/durable-member/mailbox.ts` | File transport: enqueue, drain (queue-origin tier), receipts, retry/quarantine |
| `src/durable-member/viewer.ts` | Read-only reader assembly, scratch-database invariant probe and the live-liveness reduction (`reduceLiveLiveness`) |
| `src/durable-member/standalone-store.ts` | Reference durable store over `node:sqlite` + zod payload schemas |
| `pi-web-plugins/durable-member/` | Browser panel, server module and the mirrored plain-JS contract |
| `test/durable-readonly-viewer.integration.test.ts` | Two-process WAL probe |

### `node:sqlite` import boundary

Production `src/` code imports `node:sqlite` only in `standalone-store.ts`. The
plugin's `store-reader.js` does too, as the plain-JS mirror; the parity test keeps
the tables, columns, payload shape and cursor format honest.

**Sanctioned test-fixture exception:** `test/fixtures/durable-readonly-writer.mjs`,
`test/fixtures/durable-readonly-viewer.mjs`, `test/fixtures/durable-crash-writer.mjs` and
`pi-web-plugins/durable-member/fixtures/seed-member.mjs` import `node:sqlite`
directly on purpose. They are plain-JS processes/fixtures: the two-process probe
must run without a TypeScript build step, and the screenshot seeder must run
without the library. Routing them through `standalone-store.ts` would make the
probe depend on `pnpm build` output or a TS loader, so the exception is
documented here and in `docs/repo-layout.md` instead.

### Boundary validation

`commands.ts` (commands) and `standalone-store.ts` (entry/live-generation/task
payloads read back from SQLite) validate fully untrusted data with **zod** and
map the first issue onto stable refusal codes. The plain-JS mirror
`pi-web-plugins/durable-member/contract.js` stays hand-rolled on purpose — the
plugin is served from source with no build step and no runtime dependencies — and
that asymmetry is recorded in the `SYNC WARNING` on both sides. The parity test
drives both implementations over `fixtures/commands.json` and
`fixtures/frames.json`, including every rejection path.

### Regression coverage for the first review

| Finding | Test |
|---|---|
| C1 tier escalation | `durable-member-authority.test.ts` (claim mismatch, brand type), `durable-member-dispatch.test.ts` (direct dispatch mismatch), `durable-member-mailbox.test.ts` (queued wrong-tier claim), `durable-member-socket.test.ts` (credential→tier derivation, supervisor credential content steer refused before the writer, no phase credential, 0600/stable credentials), `server-plugin.test.js` (panel presents only the panel credential) |
| W2 lost command after a failed apply | `durable-member-dispatch.test.ts` (retry after error/throw), `durable-member-mailbox.test.ts` (failure receipt retains the file, next drain applies) |
| W3 bare casts on untrusted JSON | `durable-member-socket.test.ts` (`isControlErrorCode`), `durable-member-mailbox.test.ts` (unknown receipt kind) |
| W4 browser-supplied port | `server-plugin.test.js` (port ignored, `control.port` used), `durable-member-socket.test.ts` (published port target) |
| W5 zod boundary validation | `durable-member-commands.test.ts` + the contract parity test |
| S6 tombstones | `durable-member-dedupe.test.ts` |
| S7 scratch probe | `durable-member-viewer.test.ts` (no probe row in real storage) |
| S9 empty configure | `panel.test.js` (`configureDraftError`) |
| R3 auth-answer uniformity | `durable-member-socket.test.ts` (a wrong token, an oversized token and a command before auth all answer the identical generic `unauthorized`; both served credentials still derive their own tier) |
| T4 stale live banner after a crash | `durable-member-viewer.test.ts` (`reduceLiveLiveness`: fresh + alive, fresh + owner gone, old + alive, unset heartbeat, caller bound, stale never `live`), `contract.test.js` (the plugin mirror of the same rule), `panel.test.js` (a stale row renders "owner gone · last known generation", never `streaming`), `test/durable-readonly-viewer.integration.test.ts` (a writer that commits a `streaming` row and SIGKILLs itself renders stale: `owner-gone` via the seam, `no-heartbeat` via an injected clock) |

## Deliberately out of scope

- **Task-level cancellation.** `abort` reaches the owner's `abort()`, which is the
  single point where conversation and task teardown happen; `DurableWriter` has
  no task-abort surface, so this bead proves the seam call and not that tasks
  stopped. Task cancellation belongs to the bd-185 runtime.
- **A real pi-durable member process.** The mailbox drain, socket server and
  dispatcher are owner-side seams with tests; the process that calls
  `drainDurableCommands()` at turn start and owns the socket is the durable
  member runtime from bd-185. This bead ships the contract, the viewer, the
  control plane and the panel so that runtime is observable and steerable on day
  one; it does not vendor or install pi-durable.
- **Durable conversations in the pi-web session sidebar.** Only `SessionLabel` /
  `WorkspaceLabel` contributions can be added by a plugin, so a durable
  conversation can only become a first-class *session* by patching pi-web's
  session model (a session-source abstraction). The panel is the plugin-first
  shape; the fork stays optional.
- **Read-side supervision digests** (tiered digest tools, transcript sub-agent,
  diagnosis skill) moved to bd-189; this bead keeps the panel and the control
  plane.
