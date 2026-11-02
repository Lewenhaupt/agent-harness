# Durable member panel and control plane — operator guide (bd-186)

A **durable member** has no pi session name, no `pi --resume`, no session JSONL
and no run manifest, so pi-web cannot show it the way it shows a session. This
bead gives you two things instead:

- a **read-only panel** that reads the member's durable storage directly and
  streams the transcript, the running generation and the task graph;
- a **member-owned control plane** — a per-member unix socket plus a file
  mailbox — through which a human at the panel, a fleet supervisor, or a cold
  start can send *commands* (steer, follow up, abort, configure, compact, reset)
  that the one process owning the storage applies.

Nobody writes the storage from the panel side. The owner of the storage is the
only writer, and the panel can only ask.

| Piece | Where |
|---|---|
| Browser panel + server module (plugin) | `pi-web-plugins/durable-member/` |
| Read-only viewer, liveness reduction | `src/durable-member/viewer.ts`, `standalone-store.ts` |
| Command vocabulary and zod boundary | `src/durable-member/commands.ts` |
| Tier matrix, confirmation gate | `src/durable-member/authority.ts` |
| The one command → writer translation | `src/durable-member/dispatch.ts` |
| Control socket, per-tier credentials | `src/durable-member/socket.ts` |
| File transport (queue / drain / receipts) | `src/durable-member/mailbox.ts` |
| Screenshot fixture | `pi-web-plugins/durable-member/fixtures/seed-member.mjs` |
| Two-process WAL probe | `test/durable-readonly-viewer.integration.test.ts` |
| Design record, authority matrix, threat model | [`durable-member-panel.md`](durable-member-panel.md) |

> **What this bead does and does not prove.** The storage behind every command
> below is a **reference durable store** (`node:sqlite`, WAL) that stands in for
> pi-durable — it is not pi-durable and it is not installed. `abort` reaches the
> owner's `abort()` seam; whether the owner's tasks then stop is the owner's own
> contract (bd-185) and is **not** observable here. Without an injected liveness
> probe the panel notices a dead owner only when the heartbeat bound expires
> (30 s by default). Tier separation is a coordination boundary **inside one unix
> user account**, not a privilege boundary between users.

---

## How to Verify

All commands run from this repository root (`/home/hugo/git/feat-bd-186`) unless
a step says otherwise. Nothing here needs network access.

### 1. Gates

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
pnpm test:integration
```

Observed in this worktree (pnpm's own banner lines omitted):

```text
$ tsc --noEmit
$ biome check .
Checked 334 files in 617ms. No fixes applied.
$ tsc

Test Files  151 passed (151)
     Tests  3994 passed (3994)

Test Files  15 passed (15)
     Tests  111 passed (111)
```

The bead's own suites, which the rest of this guide leans on:

```bash
pnpm vitest run pi-web-plugins/durable-member
pnpm vitest run src/__tests__/durable-member-contract-parity.test.ts
```

```text
✓ pi-web-plugins/durable-member/contract.test.js (15 tests)
✓ pi-web-plugins/durable-member/panel.test.js (20 tests)
✓ pi-web-plugins/durable-member/pi-web-plugin.test.js (5 tests)
✓ pi-web-plugins/durable-member/store-reader.test.js (5 tests)
✓ pi-web-plugins/durable-member/server-plugin.test.js (24 tests)
Test Files  5 passed (5)
     Tests  69 passed (69)

✓ src/__tests__/durable-member-contract-parity.test.ts (8 tests)
```

The parity suite is the guard that the plain-JS plugin contract
(`contract.js`, `store-reader.js`, `control-client.js`) and the TypeScript
contract (`src/durable-member/*.ts`) agree on validation, frame reduction,
cursor merging, liveness and control availability. It drives both sides over
`pi-web-plugins/durable-member/fixtures/*.json`.

### 2. Enable the plugin

The plugin is a symlink into pi-web's plugin directory; it has no build step.

```bash
ln -sfn "$PWD/pi-web-plugins/durable-member" "$HOME/.pi-web/plugins/durable-member"
readlink -f "$HOME/.pi-web/plugins/durable-member"
```

```text
/home/hugo/git/feat-bd-186/pi-web-plugins/durable-member
```

(`$PI_WEB_DATA_DIR/plugins` instead of `~/.pi-web/plugins` if you set that.)

The package declares a **server module** as well as a browser entry:

```json
"piWeb": { "plugins": [ { "id": "durable-member", "browserRoot": ".",
  "module": "pi-web-plugin.js", "serverModule": "server-plugin.js", "machineSpecific": true } ] }
```

That is what decides the reload rule, and the two halves differ:

| You changed | What it takes |
|---|---|
| `panel.js`, `pi-web-plugin.js`, `contract.js`, `store-reader.js` in the **browser** | a hard reload of the tab (`Ctrl+Shift+R` / `Cmd+Shift+R`) |
| `server-plugin.js`, `control-client.js`, or the symlink itself | **restart the session daemon**, then reload: `sudo systemctl restart pi-web-sessiond` |

The server module is read at session-daemon start, so a cold symlink is not in
the manifest yet. Confirm with the manifest endpoint:

```bash
curl -s http://127.0.0.1:8504/pi-web-plugins/manifest.json \
  | jq '.plugins[] | select(.id=="durable-member")'
```

Before the daemon restart this prints **nothing at all** — verified on this host
with the symlink in place and `pi-web` running; the id list from the same
endpoint ends at `proof-of-work, relays, updates, workflows`. After the restart
it prints an object whose `"id"` is `"durable-member"`, whose `"source"` is
`"local"`, whose `"module"` is a `/pi-web-plugins/durable-member/pi-web-plugin.js?v=…`
URL, and which carries a `backendRevision` (present because this plugin ships a
server module). The exact hashes are host-emitted.

> **Restart caveat.** `sudo systemctl restart pi-web-sessiond` interrupts every
> live session and terminal on this machine — see
> [Extension loading: discovery → restart](pi-web-service.md#extension-loading-discovery--restart)
> and the restart note in [pi-web service](pi-web-service.md). Drain first, and
> restart from outside the sessions it hosts.

### 3. Seed a member the panel can show

The panel's member root defaults to `<plugin dataDirectory>/members`, i.e.
`$HOME/.pi-web/plugin-data/durable-member/members`. Seed the reference fixture
there — the script takes `[membersRoot] [memberId]` and nothing else:

```bash
node pi-web-plugins/durable-member/fixtures/seed-member.mjs \
  "$HOME/.pi-web/plugin-data/durable-member/members" bd-186-fixture
```

```text
seeded durable member bd-186-fixture at /home/hugo/.pi-web/plugin-data/durable-member/members/bd-186-fixture
point the plugin at it with: BELAYD_DURABLE_MEMBERS_DIR=/home/hugo/.pi-web/plugin-data/durable-member/members
```

The resulting layout (exactly what the seeder creates):

```text
$HOME/.pi-web/plugin-data/durable-member/
└── members/
    └── bd-186-fixture/
        ├── member.json                     {"conversationId":"bd-186-fixture:main","label":"bd-186 fixture"}
        ├── store.sqlite                    entries + live_generations + task_nodes
        └── receipts/
            └── fixture-request.json        {"requestId":"fixture-request",…,"kind":"steer","ok":true}
```

A *running* member adds the control surface next to those files
(`control.sock`, `control.panel.token`, `control.supervisor.token`, optional
`control.port`, `commands/`, `rejected/`, `dedupe.jsonl`). The fixture does not,
because nothing is running.

Two things to know about the fixture:

- the live generation's heartbeat is stamped **at seed time**, so the member reads
  as `live` for 30 s and then goes stale. Re-run the seeder right before you look
  at the panel; that is the fastest fix for "it says idle".
- it contains no `run failure` entry. To see one, append a row (data only, no code
  change, no restart needed):

  ```bash
  cat > /tmp/durable-failure-row.mjs <<'EOF'
  import { DatabaseSync } from "node:sqlite";
  const path = `${process.env.HOME}/.pi-web/plugin-data/durable-member/members/bd-186-fixture/store.sqlite`;
  const db = new DatabaseSync(path);
  db.prepare(
    `INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    "fixture-failure", "bd-186-fixture:main", "assistant", "failure", Date.now(),
    "provider exploded",
    JSON.stringify({ failure: { message: "provider exploded", code: "provider-error" } }),
  );
  db.close();
  console.log("appended fixture-failure");
  EOF
  node /tmp/durable-failure-row.mjs
  ```

### 4. Read half without a browser

The panel's operations are ordinary functions on the plugin's server module, so
you can drive exactly what the browser drives:

```bash
cat > /tmp/durable-read.mjs <<'EOF'
process.env.BELAYD_DURABLE_MEMBERS_DIR =
  process.env.BELAYD_DURABLE_MEMBERS_DIR ??
  `${process.env.HOME}/.pi-web/plugin-data/durable-member/members`;
const pluginRoot = `${process.cwd()}/pi-web-plugins/durable-member`;
const { createDurableMemberPeer } = await import(`${pluginRoot}/server-plugin.js`);
const { openDurableStoreReader } = await import(`${pluginRoot}/store-reader.js`);
const { annotateLiveGeneration, formatTaskLine, reduceLiveLiveness } = await import(`${pluginRoot}/contract.js`);

const peer = createDurableMemberPeer({ dataDirectory: "/tmp/durable-read-data", settings: {} });
const { members } = await peer.request({ operation: "members", input: null });
console.log(`members: ${JSON.stringify(members)}`);

const wanted = process.env.DURABLE_MEMBER;
const first = wanted === undefined ? members[0] : members.find((member) => member.memberId === wanted);
if (first === undefined) {
  console.log(`no durable member ${wanted ?? ""} under ${process.env.BELAYD_DURABLE_MEMBERS_DIR}`);
  process.exit(0);
}
const root = process.env.BELAYD_DURABLE_MEMBERS_DIR;
const opened = openDurableStoreReader({ path: `${root}/${first.memberId}/store.sqlite` });
if (!opened.ok) throw new Error(opened.error);
const window = opened.store.readEntryWindow(first.conversationId, { limit: 200 });
console.log(`transcript: ${window.entries.length} entries, cursor ${window.cursor}, hasEarlier ${window.hasEarlier}`);
for (const entry of window.entries) console.log(`  ${entry.cursor} ${entry.kind} ${entry.role} ${entry.text.slice(0, 48)}`);
const live = annotateLiveGeneration(reduceLiveLiveness({ live: opened.store.readLiveGeneration(first.conversationId), now: Date.now() }));
console.log(`live: ${JSON.stringify(live)}`);
for (const task of opened.store.readTaskGraph()) console.log(`task: ${formatTaskLine(task)}`);
opened.store.close();
EOF
node /tmp/durable-read.mjs
```

Right after seeding:

```text
members: [{"memberId":"bd-186-fixture","conversationId":"bd-186-fixture:main","label":"bd-186 fixture","controlSocket":false,"readable":true,"live":true,"lastEntryAt":1793600178081,"taskCount":3,"receipts":1}]
transcript: 7 entries, cursor 8, hasEarlier false
  8 message user Implement bd-186: observe and steer durable memb
  9 message assistant Reading the bead, then the pi-web plugin contrac
  10 tool-call assistant
  11 tool-output tool Read 812 lines
  12 retry system provider rate limited; retrying in 2s
  13 compaction system compacted the transcript
  14 message assistant The plugin declares browser apiVersion 5 so the
live: {"conversationId":"bd-186-fixture:main","generationId":"gen-fixture","status":"tool-call","partialText":"Writing the contract parity test…",…,"attempt":2,"toolCalls":[{"callId":"call-2","name":"write","input":{"path":"src/__tests__/durable-member-contract-parity.test.ts"},"status":"running"}],"retry":{"attempt":2,"maxAttempts":3,"reason":"429 rate limited"}}
task: bd-186-implement [running] child:bd-186-fixture · waiting on bd-186-scout · foreground — implement the panel and control plane
task: bd-186-proof [blocked] child:bd-186-fixture · waiting on bd-186-implement · background — capture the panel screenshot
task: bd-186-scout [done] unowned · not waiting · foreground — scout the pi-web plugin contract
```

Same script more than 30 s after seeding adds the staleness annotation to the
live row and flips `"live"` to `false`:

```text
… "live":false …
live: {…,"stale":true,"staleReason":"no-heartbeat"}
```

Note `cursor 8`: the cursor is the entry's `seq` (an autoincrementing row id),
not a position in the list, so re-seeding advances it. Never hardcode it — read
it from the frame or from the store. `DURABLE_MEMBER=<memberId>` selects a member
other than the first one, which the later steps use.

`members` entries carry `readable`, `error` (when the store cannot be opened),
`controlSocket` (whether `control.sock` exists), `taskCount`, `receipts` and
`lastEntryAt`. A member whose store is unreadable is reported, never hidden.

### 5. Read half in the browser

Open pi-web (default `http://127.0.0.1:8504`), select a workspace, then open the
**Durable Member** tab, or press `Ctrl+K` / `Cmd+K` → **Open Durable Member**.
The action is offered only while a workspace is selected.

With the fixture seeded, the panel must show the following. The strings are the
panel's own output (`summarizeEntry`, `formatLiveBanner`, `formatTaskLine`,
`EMPTY_*` constants in `panel.js`, executed in this worktree); the browser
rendering itself is the one step of this guide that was not exercised here — see
[Unverified steps](#unverified-steps-in-this-worktree).

| Region | Expected |
|---|---|
| Member select | `bd-186-fixture (live)` (or `(idle)` once the heartbeat expires) |
| Status line | `1 member(s) · live` (`2 member(s)` once step 7 adds another member to the same root) |
| Transcript | `user` — *Implement bd-186: observe and steer durable members.*, then `assistant` — *Reading the bead, then the pi-web plugin contract.* |
| Tool call | `tool call · read` with the JSON input `{"path":"node_modules/@jmfederico/pi-web/dist/plugin-api.d.ts"}` |
| Tool output | `tool output · read` with body `Read 812 lines`; click the row to see its details (`{"bytes":41233,"lines":812}` from `entry-details`) |
| Retry marker | `retry 2 — 429 rate limited` |
| Compaction marker | `compaction 82000 → 21000 tokens` |
| Run failure | `run failed` with body `provider exploded` — only after you appended the row in step 3 |
| Live region | banner `tool-call · attempt 2 · retry 2/3`, then the partial text `Writing the contract parity test…`, then `[running] write` |
| Task graph | the three `task:` lines from step 4, verbatim: owner edge (`child:bd-186-fixture` / `unowned`), `[status]`, `waiting on …`, `foreground` / `background` |
| Controls | Steer, Follow up, Abort, Compact enabled; Configure and Reset disabled until the confirmation input equals `bd-186-fixture` |

With no member seeded, the empty state is the explicit:

```text
No durable members. A member appears here once its storage exists at `members/<memberId>/store.sqlite` under this plugin's data directory.
```

A member with a readable store but no committed entries shows:

```text
This member has no committed entries yet. Watch frames appear as it runs.
```

A host without the v5 backend the panel needs shows:

```text
This PI WEB host does not expose a scoped backend. Update PI WEB and restart the session daemon to stream durable members.
```

The panel never opens the store writable; the server module opens it with
`{ readOnly: true }` and asserts `store.readOnly === true` plus the absence of
`appendEntry` / `setLiveGeneration` / `upsertTask` / `resume` (step 9).

### 6. Load earlier and the transcript cursor

A frame carries a `cursor`: the `seq` of the oldest entry in the window. The
`Load earlier` button is shown only when `hasEarlier` is true, and it asks the
server for entries strictly **before** the current cursor
(`operation: "load-earlier"`). The page is merged into the view: dedupe by entry
id, order by `(timestamp, id)`, cap at the newest 200, and `hasEarlier` stays
true while the store reports older rows or anything was trimmed.

The gap case (a panel that attached late and only saw the tail) is what the
button is for. On a 257-entry store truncated to a 5-entry window:

```text
tail window: {"ids":["filler-246",…,"filler-250"],"cursor":"253","hasEarlier":true}
earlier page: {"ids":["filler-226",…,"filler-245"],"cursor":"233","hasEarlier":true}
merged: {"count":25,…,"cursor":"233","hasEarlier":true}
```

The cursor moves backwards (253 → 233) and the visible window grows by exactly
the page.

Two honest consequences of the 200-entry cap:

- the seeded fixture has 7 entries, so `hasEarlier` is false and the button stays
  hidden — nothing is broken;
- once the merged view is **at** the cap, loading an older page re-trims to the
  newest 200 and the visible head does not move (`hasEarlier` stays true). The
  cap is the scrollback limit; load-earlier is gap repair, not unbounded history.

To exercise the button, make a long store (> 200 entries) and then look again:

```bash
rm -rf /tmp/durable-long
node pi-web-plugins/durable-member/fixtures/seed-member.mjs /tmp/durable-long dm-long
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/tmp/durable-long/dm-long/store.sqlite");
const insert = db.prepare(
  "INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload) VALUES (?,?,?,?,?,?,?)",
);
for (let i = 1; i <= 250; i += 1) {
  insert.run(`filler-${String(i).padStart(3, "0")}`, "dm-long:main", "assistant", "message", 1_000 + i, `filler entry ${i}`, "{}");
}
db.close();
console.log("appended 250 entries");
'
BELAYD_DURABLE_MEMBERS_DIR=/tmp/durable-long node /tmp/durable-read.mjs | head -2
```

```text
members: [{"memberId":"dm-long","conversationId":"dm-long:main","label":"bd-186 fixture","controlSocket":false,"readable":true,"live":true,"lastEntryAt":1250,"taskCount":3,"receipts":1}]
transcript: 200 entries, cursor 58, hasEarlier true
```

### 7. A crashed member

The fixture writer is a real process that SIGKILLs itself, so nothing is closed,
checkpointed or flushed:

```bash
MEMBERS_ROOT="$HOME/.pi-web/plugin-data/durable-member/members"
node pi-web-plugins/durable-member/fixtures/seed-member.mjs "$MEMBERS_ROOT" member-a
node test/fixtures/durable-crash-writer.mjs "$MEMBERS_ROOT/member-a/store.sqlite" /tmp/durable-crash-ready --live
```

```text
seeded durable member member-a at /home/hugo/.pi-web/plugin-data/durable-member/members/member-a
Killed
```

(`Killed` is the shell reporting `SIGKILL`; the exit status is 137. The crash
writer needs the schema to exist, hence the seeder first, and it writes the
conversation `member-a:main` — the id the seeder gives `member-a`.)

Two distinct results, and the panel distinguishes them:

1. **Committed state still renders.** The `c-1`, `c-2`, `c-3` entries the dead
   writer committed are in the store, so the member appears in the list and the
   transcript shows them next to the fixture entries. Verify from the terminal:

   ```bash
   DURABLE_MEMBER=member-a BELAYD_DURABLE_MEMBERS_DIR="$MEMBERS_ROOT" node /tmp/durable-read.mjs
   ```

   ```text
   members: [{"memberId":"bd-186-fixture","conversationId":"bd-186-fixture:main","label":"bd-186 fixture","controlSocket":false,"readable":true,"live":false,"lastEntryAt":1793600178081,"taskCount":3,"receipts":1},{"memberId":"member-a","conversationId":"member-a:main","label":"bd-186 fixture","controlSocket":false,"readable":true,"live":true,"lastEntryAt":3,"taskCount":3,"receipts":1}]
   transcript: 10 entries, cursor 1, hasEarlier false
     1 message user Implement bd-186: observe and steer durable memb
     …
     8 message assistant committed entry 1
     9 message assistant committed entry 2
     10 message assistant committed entry 3
   live: {"conversationId":"member-a:main","generationId":"gen-crash","status":"streaming","partialText":"about to die",…,"attempt":1,"toolCalls":[]}
   ```

   Both members are listed, the dead writer's three entries are there, and its
   live row still claims `"status":"streaming"` — the claim that the next
   paragraph is about (`lastEntryAt: 3` is the crash writer's own timestamp).

2. **A committed *live* row is reported as the last known generation, never as
   streaming.** `--live` makes the writer commit `status: "streaming"` and then
   die, so the row's own claim survives its owner. Immediately after the crash
   the panel banner still reads `streaming · attempt 1` — that is the honest
   default, because nothing has told the reader the owner is gone. Once the
   heartbeat bound passes it becomes:

   ```text
   owner gone (no heartbeat) · last known generation · attempt 1
   ```

   and the member select flips from `bd-186-fixture (live)` / `member-a (live)`
   to `member-a (idle)`. The stale row is **annotated, not dropped**: the partial
   text `about to die` is still shown as the last thing the owner committed.

   With an owner-liveness probe that says the process is gone, the same row is
   stale immediately with the other reason:

   ```text
   owner gone · last known generation · attempt 1
   ```

   That path is the seam, not a default: `openDurableViewer({ ownerAlive: () => false })`
   in TypeScript, or the activation override `liveness.ownerAlive` in the plugin
   (`resolveLiveness` in `server-plugin.js`). `test/durable-readonly-viewer.integration.test.ts`
   asserts both reasons (`owner-gone` via the seam, `no-heartbeat` via an injected
   clock) against a real SIGKILLed writer.

**Say it plainly:** the browser panel is not given a liveness probe. Its seam
defaults to "unknown owner, treat as alive", so **a dead owner is only noticed at
the heartbeat bound** — 30 s — not at the moment of the crash. There is no
pre-30 s crash detection in the panel.

### 8. Observing the heartbeat bound without waiting 30 s

Two ways. The first needs no restart and is what the steps above use — age the
fixture's heartbeat and let the next watch tick (100 ms) re-reduce it:

```bash
cat > /tmp/durable-age-heartbeat.mjs <<'EOF'
import { DatabaseSync } from "node:sqlite";
const path = `${process.env.HOME}/.pi-web/plugin-data/durable-member/members/bd-186-fixture/store.sqlite`;
const db = new DatabaseSync(path);
const row = db.prepare("SELECT payload FROM live_generations").get();
const payload = JSON.parse(row.payload);
payload.updatedAt = Date.now() - 60_000;
db.prepare("UPDATE live_generations SET payload = ?").run(JSON.stringify(payload));
db.close();
console.log(`heartbeat backdated 60 s for ${payload.generationId}`);
EOF
node /tmp/durable-age-heartbeat.mjs
node /tmp/durable-read.mjs | grep -E "^live:"
```

```text
heartbeat backdated 60 s for gen-fixture
live: {…,"stale":true,"staleReason":"no-heartbeat"}
```

The banner flips on the next tick because the liveness reduction is part of the
watch frame's change signature (`server-plugin.js`), so a heartbeat crossing the
bound emits a frame even when no committed entry changed.

The second way is the supported setting, and it needs a session-daemon restart
because plugin settings are captured at activation. In `~/.config/pi-web/config.json`
(or `$PI_WEB_CONFIG`):

```json
{
  "plugins": {
    "durable-member": {
      "settings": { "staleAfterMs": 5000 }
    }
  }
}
```

The same leaf as an environment override for the session daemon (a systemd
drop-in, then `sudo systemctl restart pi-web-sessiond`):

```bash
PI_WEB_PLUGINS='{"durable-member":{"settings":{"staleAfterMs":5000}}}'
```

`staleAfterMs` is the only JSON setting: a non-numeric or non-positive value
falls back to the 30 000 ms default, and a process-local `liveness.staleAfterMs`
override wins over it. The clock and the owner probe are functions, so they are
`activate()` overrides, not settings.

In TypeScript the same knob is an option, so the bound is testable without
sleeping:

```typescript
const opened = openDurableViewer({
  storePath: "/tmp/durable-long/dm-long/store.sqlite",
  memberId: "dm-long",
  conversationId: "dm-long:main",
  staleAfterMs: 500,
  now: () => 1_000_000,
  ownerAlive: () => false,
});
```

The crossing is **inclusive**: a heartbeat exactly `staleAfterMs` old is stale.

### 9. The storage is never opened writable

Three independent checks.

a) The plugin reader has no write path at all:

```bash
grep -n "appendEntry\|setLiveGeneration\|upsertTask\|resume(" \
  pi-web-plugins/durable-member/store-reader.js
```

Expected: **no output** (exit status 1). The connection is opened
`new DatabaseSync(path, { readOnly: true })` and the handle exposes reads only.

b) A write attempt from the panel side is rejected by SQLite itself:

```bash
STORE="$HOME/.pi-web/plugin-data/durable-member/members/bd-186-fixture/store.sqlite"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
try {
  db.prepare("INSERT INTO entries (id, conversation_id, role, kind, timestamp, text, payload) VALUES (?,?,?,?,?,?,?)")
    .run("probe", "bd-186-fixture:main", "system", "message", 0, "", "{}");
  console.log("INSERT SUCCEEDED (unexpected)");
} catch (error) {
  console.log(`INSERT REJECTED: ${error.message}`);
}
db.close();
' "$STORE"
```

```text
INSERT REJECTED: attempt to write a readonly database
```

c) The reference store's own writer surface refuses too (after `pnpm build`,
which puts the library in `dist/src/`):

```bash
node --input-type=module -e '
const { openDurableStore } = await import(`${process.cwd()}/dist/src/durable-member/standalone-store.js`);
const opened = openDurableStore({ path: process.argv[1], readOnly: true });
console.log(`readOnly flag: ${opened.store.readOnly}`);
try {
  opened.store.appendEntry({ id: "probe", conversationId: "bd-186-fixture:main", role: "system", kind: "message", timestamp: 0, text: "" });
} catch (error) {
  console.log(`${error.name}: ${error.message}`);
}
opened.store.close();
' "$STORE"
```

```text
readOnly flag: true
ReadOnlySessionError: session was opened readOnly: appendEntry is not available
```

The plugin's server module additionally fails closed with
`durable-member server plugin refuses a writable store` if a future edit ever
hands it a handle that reports `readOnly: false`. `openDurableViewer()` proves
the same invariant before returning, on a scratch database in the temp directory
(the row `__belayd_readonly_probe__` can never reach real member data).

### 10. The three tiers, from the terminal

There is **one listener per member** (`<memberStateDir>/control.sock`, unix,
mode 0600) and **one credential file per authenticatable tier**:

```text
control.panel.token        0600   panel-human
control.supervisor.token   0600   fleet-supervisor   (only if that tier is served)
control.port               0600   optional 127.0.0.1 TCP fallback port
```

There is **no** `phase-subagent` credential: that tier cannot authenticate at
all. The listener creates a credential on first use, keeps it stable across
restarts, and compares it in constant time against every served candidate. The
tier is **whatever the presented credential derives** — never the `authority`
field in the frame, which is only an integrity-checked claim.

Start a control surface over a scratch member and drive it. Run
`pnpm build` first: this script uses the compiled library in `dist/src/`.

```bash
cat > /tmp/durable-control.mjs <<'EOF'
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = `${process.cwd()}/dist/src/durable-member`;
const { createDurableDispatcher } = await import(`${base}/dispatch.js`);
const { createDedupeLedger } = await import(`${base}/dedupe.js`);
const { startControlServer, sendMemberControlCommand, memberControlSocketPath } = await import(`${base}/socket.js`);

const stateDir = mkdtempSync(join(tmpdir(), "durable-control-"));
const memberId = "member-a";
const submitted = [];
const writer = {
  submit(input) { submitted.push(input); return { ok: true, submissionId: "sub-1" }; },
  submission() { return { abort() {} }; },
  abort() {},
  configure() {},
  compact() {},
  reset() {},
};

const dispatcherFor = (authority) => {
  const opened = createDedupeLedger({ stateDir });
  if (!opened.ok) throw new Error(opened.error);
  return createDurableDispatcher({ memberId, authority, writer, ledger: opened.ledger });
};

const started = await startControlServer({
  stateDir,
  memberId,
  tiers: [
    { authority: "panel-human", dispatcher: dispatcherFor("panel-human") },
    { authority: "fleet-supervisor", dispatcher: dispatcherFor("fleet-supervisor") },
  ],
});
if (!started.ok) throw new Error(started.error);

const command = (overrides) => ({
  requestId: `req-${Math.floor(Math.random() * 1e9)}`,
  memberId,
  authority: "panel-human",
  issuedAt: Date.now(),
  ...overrides,
});
const send = async (label, authority, body) => {
  const result = await sendMemberControlCommand({ stateDir, authority, command: body });
  console.log(`${label}: ${JSON.stringify(result)}`);
};

const steer = command({ kind: "steer", text: "look at the parity test" });
await send("panel-steer", "panel-human", steer);
await send("panel-steer-retried", "panel-human", steer);
await send("configure-no-confirmation", "panel-human", command({ kind: "configure", config: { model: "llmgateway/glm-5.3-flash" } }));
await send("configure-wrong-confirmation", "panel-human", command({ kind: "configure", config: { model: "llmgateway/glm-5.3-flash" }, confirmation: "member-b" }));
await send("configure-confirmed", "panel-human", command({ kind: "configure", config: { model: "llmgateway/glm-5.3-flash" }, confirmation: memberId }));
await send("supervisor-claims-panel", "fleet-supervisor", command({ kind: "steer", text: "x" }));
await send("supervisor-honest-steer", "fleet-supervisor", command({ kind: "steer", text: "x", authority: "fleet-supervisor" }));
await send("supervisor-abort", "fleet-supervisor", command({ kind: "abort", authority: "fleet-supervisor" }));
await send("wrong-member", "panel-human", command({ kind: "steer", text: "x", memberId: "member-b" }));

console.log(`control.sock mode ${statSync(memberControlSocketPath(stateDir)).mode.toString(8).slice(-4)}`);
for (const name of ["control.panel.token", "control.supervisor.token"]) {
  console.log(`${name} mode ${statSync(join(stateDir, name)).mode.toString(8).slice(-4)}`);
}
console.log(`writer.submit calls ${submitted.length} ${JSON.stringify(submitted)}`);
await started.close();
rmSync(stateDir, { recursive: true, force: true });
EOF
node /tmp/durable-control.mjs
```

```text
panel-steer: {"ok":true,"requestId":"req-101419026","duplicate":false}
panel-steer-retried: {"ok":true,"requestId":"req-101419026","duplicate":true}
configure-no-confirmation: {"ok":false,"code":"invalid-command","error":"configure requires confirmation equal to the member id (member-a)"}
configure-wrong-confirmation: {"ok":false,"code":"invalid-command","error":"configure confirmation does not match the member id (member-a)"}
configure-confirmed: {"ok":true,"requestId":"req-366844277","duplicate":false}
supervisor-claims-panel: {"ok":false,"code":"authority-mismatch","error":"command claims panel-human, this transport serves fleet-supervisor"}
supervisor-honest-steer: {"ok":false,"code":"invalid-command","error":"fleet-supervisor may not send steer"}
supervisor-abort: {"ok":true,"requestId":"req-630660523","duplicate":false}
wrong-member: {"ok":false,"code":"invalid-command","error":"command targets member member-b, this control surface owns member-a"}
control.sock mode 0600
control.panel.token mode 0600
control.supervisor.token mode 0600
writer.submit calls 1 [{"type":"message","text":"look at the parity test","whenBusy":"steer"}]
```

Read that output as the whole tier story: a supervisor-rooted caller cannot
content-steer (either `authority-mismatch` when it relabels its frame, or
`fleet-supervisor may not send steer` when it is honest), cannot reach
`configure`/`reset` at all, and can only run lifecycle (`abort` here). Note that
the socket folds every dispatch refusal into `code: "invalid-command"` and keeps
the reason in `error` — the specific codes `role-not-permitted`,
`confirmation-required`, `confirmation-mismatch`, `member-mismatch` appear
verbatim in the **file-transport receipts** (step 13), not on the wire.

### 11. Steer, follow up and abort from the panel

Select the member, type into the steer box, click the button. Each click mints a
fresh `requestId` (`crypto.randomUUID()`), so double-clicking steers twice; only
a *retried* command keeps its id.

| Control | What the owner does | What you see |
|---|---|---|
| **Steer** | `submit({ type: "message", text, whenBusy: "steer" })` — joins after the current tool round, same run | `steer delivered` under the buttons; the transcript gains the message **when the owner commits it**, not before |
| **Follow up** | `submit({ type: "message", text, whenBusy: "followup" })` — starts the next run | `followup delivered`; the entry appears at the start of the next run |
| **Abort** | `abort()` — the owner's own teardown point | `abort delivered`; the live banner disappears once the owner stops updating the row |
| **Compact** | `compact({ instructions? })` | `compact delivered`; a `compaction` marker entry follows when the owner commits one |

An empty steer box is refused by the panel before sending:

```text
Refused before send: steer requires bounded non-empty text
```

A refusal that came from the owner is rendered as
`<kind> refused: <owner error>`, and a retried `requestId` as
`<kind> already applied (duplicate requestId)`.

When the member is not running at all, the panel's request fails with the
credential error rather than hanging:

```text
steer refused: could not read /home/hugo/.pi-web/plugin-data/durable-member/members/bd-186-fixture/control.panel.token: ENOENT: no such file or directory, open '/home/hugo/.pi-web/plugin-data/durable-member/members/bd-186-fixture/control.panel.token'
```

That is the `socket-unavailable` code from step 15: the member has no control
surface yet, so queue the command instead (step 13).

**Abort scope, stated precisely:** this bead proves that `abort` reaches the
owner's `abort()` seam and that no content path is invoked for an abort. Whether
the conversation and its tasks actually stop is the owner's contract (bd-185).
`DurableWriter` has no task-abort surface, so task cancellation is not observable
from here.

### 12. `configure` and `reset`: the confirmation flow

Both change the agent's contract mid-run, so the owner gates them on
`confirmation` equal to the **member id** — deterministic and hard to misfire.
The panel only disables the button; the gate itself is `authority.ts`.

Panel behaviour, in order:

| State | Button | Message |
|---|---|---|
| confirmation box empty | disabled | `Type the member id (bd-186-fixture) to confirm configure.` |
| confirmation box holds anything else | disabled | `Confirmation must equal the member id; the owner refuses gated commands otherwise.` |
| confirmation equals the member id, model empty | disabled | `Configure needs a model (or tools / system prompt) before it can be sent.` |
| confirmation equals the member id, model filled | enabled | `configure delivered` |

The owner refuses, even when the panel is bypassed, with exactly:

```text
configure requires confirmation equal to the member id (member-a)
configure confirmation does not match the member id (member-a)
```

A supervisor-rooted caller never reaches the gate: `configure`/`reset` are not in
its allowed kinds, so it gets `fleet-supervisor may not send configure`
(`role-not-permitted`) whatever it puts in `confirmation`.

`reset` takes the same confirmation and passes `keepHistory` through to
`reset({ keepHistory })`.

### 13. The file transport: a command for a member that is not running

The socket needs a running member. Anything that must survive the member being
down goes through files in the member state dir:

```text
<memberStateDir>/commands/<requestId>.json      queued command (atomic tmp+rename, 0600)
<memberStateDir>/receipts/<requestId>.json      one receipt per attempt
<memberStateDir>/rejected/<requestId>.json      quarantined refusals / applied-but-unrecorded
<memberStateDir>/dedupe.jsonl                   requestId ledger, replayed on start
```

The queue is drained at start/turn start by the owner (bd-185 runtime), and the
tier is the **queue origin** the owner configured, never the file's own
`authority` field.

```bash
cat > /tmp/durable-mailbox.mjs <<'EOF'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = `${process.cwd()}/dist/src/durable-member`;
const { createDurableDispatcher } = await import(`${base}/dispatch.js`);
const { createDedupeLedger } = await import(`${base}/dedupe.js`);
const { drainDurableCommands, enqueueDurableCommand, memberCommandsDir } = await import(`${base}/mailbox.js`);

const stateDir = mkdtempSync(join(tmpdir(), "durable-mailbox-"));
const memberId = "member-a";
const submitted = [];
const writer = {
  submit(input) { submitted.push(input); return { ok: true }; },
  submission() { return null; },
  abort() {},
  configure() {},
  compact() {},
  reset() {},
};
const opened = createDedupeLedger({ stateDir });
if (!opened.ok) throw new Error(opened.error);
const dispatcher = createDurableDispatcher({ memberId, authority: "panel-human", writer, ledger: opened.ledger });

const command = (overrides) => ({
  requestId: "queued-1",
  memberId,
  authority: "panel-human",
  issuedAt: Date.now(),
  kind: "steer",
  text: "queued while the member was down",
  ...overrides,
});

enqueueDurableCommand({ stateDir, command: command({}) });
const path = join(memberCommandsDir(stateDir), "queued-1.json");
console.log(`queued ${path} mode ${statSync(path).mode.toString(8).slice(-4)}`);
console.log(`command file body: ${readFileSync(path, "utf8").trim()}`);

const first = await drainDurableCommands({ stateDir, memberId, authority: "panel-human", dispatcher });
console.log(`drain #1: ${JSON.stringify(first.result)}`);
console.log(`commands/ after drain #1: ${JSON.stringify(readdirSync(memberCommandsDir(stateDir)))}`);
console.log(`receipt: ${readFileSync(join(stateDir, "receipts", "queued-1.json"), "utf8").trim()}`);

enqueueDurableCommand({ stateDir, command: command({}) });
const second = await drainDurableCommands({ stateDir, memberId, authority: "panel-human", dispatcher });
console.log(`drain #2 (same requestId): ${JSON.stringify(second.result)}`);

enqueueDurableCommand({ stateDir, command: command({ requestId: "queued-super", authority: "fleet-supervisor" }) });
const third = await drainDurableCommands({ stateDir, memberId, authority: "panel-human", dispatcher });
console.log(`drain #3 (wrong-tier file): ${JSON.stringify(third.result)}`);
console.log(`rejected/: ${JSON.stringify(existsSync(join(stateDir, "rejected")) ? readdirSync(join(stateDir, "rejected")) : [])}`);
console.log(`writer.submit calls ${submitted.length} ${JSON.stringify(submitted)}`);
rmSync(stateDir, { recursive: true, force: true });
EOF
node /tmp/durable-mailbox.mjs
```

```text
queued /tmp/durable-mailbox-jkL3Cy/commands/queued-1.json mode 0600
command file body: {"requestId":"queued-1","memberId":"member-a","authority":"panel-human","issuedAt":1793600216450,"kind":"steer","text":"queued while the member was down"}
drain #1: {"applied":1,"duplicates":0,"rejected":0,"retained":0,"quarantined":0,"receipts":[{"requestId":"queued-1","memberId":"member-a","kind":"steer","appliedAt":1793600216456,"ok":true,"duplicate":false}]}
commands/ after drain #1: []
receipt: {"requestId":"queued-1","memberId":"member-a","kind":"steer","appliedAt":1793600216456,"ok":true,"duplicate":false}
drain #2 (same requestId): {"applied":0,"duplicates":1,"rejected":0,"retained":0,"quarantined":0,"receipts":[{"requestId":"queued-1","memberId":"member-a","kind":"steer","appliedAt":1793600216457,"ok":true,"duplicate":true}]}
drain #3 (wrong-tier file): {"applied":0,"duplicates":0,"rejected":1,"retained":0,"quarantined":1,"receipts":[{"requestId":"queued-super","memberId":"member-a","kind":"unknown","appliedAt":1793600216457,"ok":false,"code":"authority-mismatch","error":"command claims fleet-supervisor, this transport serves panel-human"}]}
rejected/: ["queued-super.json"]
writer.submit calls 1 [{"type":"message","text":"queued while the member was down","whenBusy":"steer"}]
```

What the dispositions mean for the four files after a drain:

| Outcome | Receipt | `commands/` | `rejected/` |
|---|---|---|---|
| applied | `ok: true, duplicate: false` | removed | — |
| already applied (same `requestId`) | `ok: true, duplicate: true` | removed | — |
| transient writer failure (`writer-failed`) | `ok: false`, code `writer-failed` | **retained** for the next drain | — |
| permanent refusal, or `applied-unrecorded` | `ok: false`, code as refused | removed | moved here as evidence |

Files settle in `issuedAt` order, not filename order, so a queued
steer-then-followup keeps its order regardless of how the ids sort.

### 14. The two-process WAL probe

This is the "why can a second reader be trusted" check: a real read-only process
must observe a real writer's committed deltas while the writer holds its
read-write connection, and its own write must be rejected.

```bash
pnpm vitest run --config vitest.integration.config.ts durable-readonly-viewer --reporter=verbose
```

```text
✓ test/durable-readonly-viewer.integration.test.ts (3 tests) 747ms
  ✓ durable member: read-only viewer as a second process > receives WAL deltas from a live writer and its write attempt is rejected 540ms
  ✓ durable member: read-only viewer as a second process > still renders the last committed state after the writer is killed 94ms
  ✓ durable member: read-only viewer as a second process > renders a live row committed by a writer that died as stale 111ms
Test Files  1 passed (1)
     Tests  3 passed (3)
```

The viewer child process prints one line per delta and a JSON summary; the test
asserts the summary and the panel's own read path over the same live file:

```text
observed 1 committed entries
observed 2 committed entries
observed 3 committed entries
observed 4 committed entries
observed 5 committed entries
{"observed":5,"last":5,"afterWrite":5,"writeRejected":true,"writeError":"attempt to write a readonly database"}
```

`observed >= 2` (deltas seen while the writer stayed connected), `last === 5`,
the second process's `INSERT` rejected with a read-only error, `afterWrite === 5`
(the rejected write left no row), and, after the writer exits, the sole-owner
read returns the same `w-1 … w-5`.

If it fails, stop and fix it before trusting the panel: either a second
read-only process no longer sees committed deltas (the viewer would show a frozen
transcript while the member runs), or a write from the read-only process
succeeded (the single-writer guarantee the whole control plane rests on is
broken). If `node:sqlite` is unavailable the test prints
`Skipping integration test: node:sqlite unavailable (<reason>)` and is marked
skipped — it never passes silently, so a `↓` is not a pass.

Gotcha: `pnpm test:integration -- durable-readonly-viewer` also *passes*, because
the extra argument is dropped and the whole integration suite runs (15 files / 111
tests, ~35 s). Use the `vitest run --config …` form above when you want only this
probe.

### 15. Failure modes

Everything below is quoted from the code, and each row was produced by one of the
scripts above. `Where` says which surface emits it: **wire** = control-socket
response, **receipt** = file-transport receipt (the specific codes survive
there), **panel** = browser message.

| Code / text | Where | Real text | What it means | What to do |
|---|---|---|---|---|
| `unauthorized` | wire | `credential does not match any tier this surface serves` | The presented credential matched no served tier: wrong, empty, oversized, or a command frame sent before auth. Deliberately generic — it never says which check refused. | Check that `control.panel.token` exists (`0600`) and that the owner serves the panel tier. A `phase-subagent` credential never exists, by design. |
| `authority-mismatch` | wire, receipt, panel | `command claims panel-human, this transport serves fleet-supervisor` · `the panel forwards only panel-human commands, got fleet-supervisor` | The frame's `authority` disagrees with the tier the credential derived. The claim is never honoured. | Send the tier your credential proves. The panel only ever sends `panel-human`. |
| `role-not-permitted` | receipt (on the wire it arrives as `invalid-command`) | `fleet-supervisor may not send steer` | Real tier, wrong kind: a supervisor-rooted caller gets lifecycle only (`abort`, `abort-submission`). | Use the panel credential for content; keep supervisors to lifecycle. |
| `confirmation-required` | receipt (wire: `invalid-command`) | `configure requires confirmation equal to the member id (member-a)` | A gated kind sent without `confirmation`. | Type the member id into the panel's confirmation box, or set `confirmation` to the member id. |
| `confirmation-mismatch` | receipt (wire: `invalid-command`) | `configure confirmation does not match the member id (member-a)` | `confirmation` was present but not the member id. | Retype it exactly; the panel disables the button until it matches. |
| `member-mismatch` | receipt (wire: `invalid-command`) | `command targets member member-b, this control surface owns member-a` | The command names another member. One socket per member, scoped by path. | Select the member that owns the socket; there is no cross-member control path. |
| `invalid-frame` | wire | `frame is not JSON` · `expected a command frame` · `command frame must be an object` | NDJSON framing is wrong, or the first frame was not `{"type":"auth",…}`. The channel closes. | Reconnect: send the auth frame first, then `{"type":"command","command":…}` one JSON object per line. |
| `invalid-command` | wire | the validator's own message (e.g. `steer requires bounded non-empty text`) | Shape, size, address or dispatch refusal. On the wire this code carries every dispatch refusal, with the reason in `error`. | Fix the command; for a queue file the receipt carries the specific code and the file is quarantined. |
| `frame-too-large` | wire | `frame exceeded 262144 bytes` (server) · `control response frame is too large` (client) | A single NDJSON frame over 256 KiB. Command text itself is capped at 64 KiB UTF-8. | Split the payload, or use a `write` command with a shorter entry. |
| `writer-failed` | receipt | the owner's own message (e.g. `owner is compacting`) | The owner's writer returned an error or threw. Nothing was recorded in the dedupe ledger. | Retryable: a queued file is **retained** in `commands/` and re-applied on the next drain. |
| `applied-unrecorded` | receipt | `command was applied but the dedupe ledger could not record it: <reason>` | The side effect happened but could not be remembered. Retrying would apply it twice. | **Do not retry.** Inspect `dedupe.jsonl`; the mailbox quarantines the file in `rejected/`. |
| `unknown-submission` | receipt (wire: `invalid-command`) | `no submission sub-9 is in flight` | `abort-submission` for an id the owner does not hold — the run already ended. | Drop it; nothing to abort. |
| `socket-unavailable` | wire, panel | `could not read <dir>/control.panel.token: ENOENT: no such file or directory, open '<dir>/control.panel.token'` | The member is not running (no credential, no socket). | Queue the command as a file in `commands/` (step 13) or start the member. |
| `timeout` | wire | `no response within 5000ms` | The connection was accepted but the owner never answered. | Check the member process; retry with the **same** `requestId` so a late apply is not doubled. |
| `protocol-error` | wire | `member closed the control channel before answering` · `control response is not JSON` | The channel died mid-command, or the peer is not a control surface. | Retry with the same `requestId`; dedupe makes the retry safe. |

Two panel-side conditions that are not owner refusals:

| Text | Meaning |
|---|---|
| `This PI WEB host does not expose a scoped backend. Update PI WEB and restart the session daemon to stream durable members.` | The browser entry needs apiVersion 5 for `context.backend`; the host is older. |
| `No durable members. A member appears here once its storage exists at members/<memberId>/store.sqlite under this plugin's data directory.` | The member root has no `<memberId>/store.sqlite`. Re-check the seeder path from step 3. |

### Unverified steps in this worktree

| Step | Why | What was verified instead |
|---|---|---|
| 5. The browser rendering | No browser and no interactive pi-web session in this environment | Every string in the expected-output table was produced by executing the panel's own helpers (`summarizeEntry`, `formatLiveBanner`, `formatTaskLine`, the `EMPTY_*` constants) against the seeded store |
| 2. The post-restart manifest entry | Restarting `pi-web-sessiond` interrupts live sessions, so it was not done from inside one | The **pre**-restart state was verified: with the symlink in place the endpoint returns no `durable-member` entry. The shape after restart is described from the host's catalog code, not pasted from a live run |
| 8. The `staleAfterMs` setting | Needs the same daemon restart | The heartbeat-aging route (no restart) was executed and its output quoted; the setting is read by `resolveLiveness` and its behaviour is covered by `server-plugin.test.js` |
| 11. A live owner applying a steer | The member runtime that drains and applies commands is bd-185; no member process runs here | The dispatcher/owner seam was driven directly (step 10) and the mailbox drain (step 13) shows the resulting `submit({whenBusy:"steer"})` |

---

## How to Use

### Mental model

Three sentences:

1. **One process owns a member's storage.** pi-durable has no cross-process
   locking, so single-writer is a fact, not a preference. Nothing outside that
   process ever writes the store.
2. **Everyone else reads, or sends a command.** The panel reads the store
   read-only; the socket and the file mailbox carry *commands* that the owner
   validates, authorizes, dedupes by `requestId` and applies through its own
   writer.
3. **The credential decides the tier.** A caller's `authority` field is a claim
   that is checked against the tier its credential proves; a supervisor
   credential can run lifecycle only.

```
member state dir                   pi-web daemon                  browser
──────────────────                 ─────────────                  ───────
store.sqlite ──readOnly:true──▶ server-plugin.js ──watch ch.──▶  panel.js
control.sock ◀──command─────────  (reader + forwarder)
```

### Install, enable, uninstall

```bash
# install / enable
ln -sfn /absolute/path/to/pi-web-plugins/durable-member "$HOME/.pi-web/plugins/durable-member"
sudo systemctl restart pi-web-sessiond      # server-backed plugin: daemon restart required
# then hard-reload the browser tab

# uninstall
rm -rf "$HOME/.pi-web/plugins/durable-member"
sudo systemctl restart pi-web-sessiond
```

The plugin is enabled by default (`defaultEnabled` is not set to `false`). To
disable it without removing it, set `plugins.durable-member.enabled: false` in
pi-web's config — that also takes effect on the next daemon start. A future
browser-only edit needs just a hard reload; a server-module edit needs the
restart.

### Where things live

```text
$HOME/.pi-web/plugin-data/durable-member/        ← the plugin's dataDirectory
└── members/                                     ← default member root
    └── <memberId>/
        ├── member.json              { conversationId, label? }  (default conversationId: "main")
        ├── store.sqlite             entries, live_generations, task_nodes
        ├── control.sock             0600, created by the running member
        ├── control.panel.token      0600, panel tier
        ├── control.supervisor.token 0600, only if that tier is served
        ├── control.port             0600, only with the 127.0.0.1 TCP fallback
        ├── commands/<requestId>.json   queued commands (atomic, 0600)
        ├── receipts/<requestId>.json   one per attempt
        ├── rejected/<requestId>.json   quarantined evidence
        └── dedupe.jsonl / dedupe.tombstones.jsonl
```

`BELAYD_DURABLE_MEMBERS_DIR` (in the session daemon's environment) overrides the
member root; changing it needs a daemon restart. Dropping a seeded directory into
`members/` does **not** — hit **Refresh** in the panel.

### Who may do what

Read the table by **credential**, not by intent: the tier is whatever the
presented credential derives.

| Command | `panel-human` (`control.panel.token`) | `fleet-supervisor` (`control.supervisor.token`) | `phase-subagent` (no credential) |
|---|---|---|---|
| `steer` (after the current tool round) | allow | refuse `role-not-permitted` | cannot authenticate |
| `followup` (next run) | allow | refuse | cannot authenticate |
| `write` (entry the model never sees) | allow | refuse | cannot authenticate |
| `abort-submission` | allow | allow | cannot authenticate |
| `abort` | allow | allow | cannot authenticate |
| `compact` | allow | refuse | cannot authenticate |
| `configure` | allow with `confirmation` = member id | refuse | cannot authenticate |
| `reset` | allow with `confirmation` = member id | refuse | cannot authenticate |

So a supervisor-rooted caller has **no route** to a content steer, a write, a
compaction, or `configure`/`reset`: the tier comes from its credential, and a
frame that relabels itself is `authority-mismatch`.

`write` is allowed for the panel tier but has no button in the panel: send it as
a command over the socket or as a queue file (step 13) when a harness note must
be committed as an entry the model never sees.

**Trust boundary, unchanged:** all credentials live in the member's state
directory under one uid. A hostile process running as the same user can read
`control.panel.token` and present it. This is a coordination boundary *inside one
user account* — the unix permissions of the state directory are the real boundary
between users. Do not rely on tier separation against code already running as
you.

### Day-to-day flows

**Watch a run.** Open the panel, pick the member, and leave it: the watch channel
publishes on change (default 100 ms cadence) — committed entries, the live
partial text, per-tool-call status and output, retries, compaction, and the task
graph with owner edge, status, `waiting on` and `background`. Click any row for
its full payload (`entry-details`). Scroll back with **Load earlier** when the
transcript is longer than the window.

**Steer vs follow up.** *Steer* joins the current run after the tool round in
flight; *follow up* starts the next run. Both are content, so both need the panel
tier. Type, click, and watch the transcript for the entry the owner commits —
the panel never fabricates an entry.

**Abort.** A click reaches the owner's `abort()`. Treat it as "ask the owner to
stop": the conversation and its tasks are torn down inside the owner (bd-185).

**Change the agent contract.** Fill in the model, type the member id into the
confirmation box, then click Configure. Reset behaves the same way and forwards
`keepHistory`. The confirmation exists because these change the contract mid-run.

**Queue a command for a cold member.** Write
`<memberStateDir>/commands/<requestId>.json` with the full command envelope
(`requestId`, `memberId`, `authority`, `issuedAt`, `kind`, plus kind-specific
fields). The owner drains it at start/turn start, applies it through the same
dispatcher, and writes `receipts/<requestId>.json`. Reuse the `requestId` on
retry: the ledger makes the second delivery a `duplicate: true` no-op. A file
whose `authority` does not match the queue origin is refused and quarantined.

Use the panel for interactive work and the file transport for anything that has
to survive a restart — the socket is per-process, the mailbox is per-directory.

**Triage a crashed member.** The committed transcript is still there, so the
panel opens it: read what the member did before it died. If a `live` row was left
behind, the panel says `owner gone (no heartbeat) · last known generation` and
keeps showing the last partial text instead of lying about `streaming`. The
member list shows it as `(idle)`. Re-seed or restart the member to make it
`(live)` again.

**Tune the heartbeat bound.** `plugins.durable-member.settings.staleAfterMs`
(daemon restart) if 30 s is wrong for your cadence. Lower it if you want a dead
owner noticed sooner and can afford false stales; raise it if the member legitimately
pauses between partials for long. There is no pre-bound crash detection without a
liveness probe.

### Uninstall and cleanup

```bash
rm -rf "$HOME/.pi-web/plugins/durable-member"
sudo systemctl restart pi-web-sessiond
rm -rf "$HOME/.pi-web/plugin-data/durable-member"   # removes seeded fixtures and receipts
```

### Related reading

- [Durable member panel and control plane](durable-member-panel.md) — contract,
  authority matrix, threat model, the WAL probe result, the deliberately
  out-of-scope list.
- [Durable Member plugin README](../pi-web-plugins/durable-member/README.md) —
  file-by-file internals and the test map.
- [pi-web service](pi-web-service.md) — units, restart rules, plugin catalog
  versions.
- [Proof of Work plugin](../pi-web-plugins/proof-of-work/README.md) — the sibling
  browser-only plugin, for the install/verify shape this guide follows.
