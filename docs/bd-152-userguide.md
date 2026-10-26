# The human answer channel: `belayd_ask_human` and bd `human` gates (bd-152)

Before bd-152 a workflow blocked on a decision only a human can make had no way
back. It guessed, or it stalled: the bead sat in "Needs You" and nothing the
human wrote could re-enter the session.

bd-152 makes the bead's bd state the channel:

- **ask** — `belayd_ask_human` posts the question as a `belayd:*`-authored
  comment, opens a bd `human` gate that **blocks the bead**, arms a 30 s
  self-poll and ends the turn;
- **wait** — every phase tool is *refused* (not discouraged) until an answer
  arrives, and the refusal names the bead and the reply command;
- **answer** — the first comment on the bead whose author is **not** `belayd:*`
  and which is newer than the gate becomes a real user turn:
  `<author> answered: <excerpt>`, and the gate is resolved;
- **accept** — unchanged. Answering a comment does **not** close the bead;
  `wt merge` / `bd close` is still the acceptance signal.

Nothing is persisted harness-side: the open bd gate *is* the durable state, so a
restart re-discovers the wait from `bd gate list` (that is why
`bd gate list <bead>` is the first thing to look at when a workflow seems stuck).

| Piece | Where |
| --- | --- |
| `belayd_ask_human` tool, poll, delivery, gate reap | `extensions/index.ts` (`askHuman`, `observeHumanAnswer`, `pollHumanAnswerOnce`) |
| Gate argv + `bd gate list` parsing | `src/bead-gates.ts` (exported from the `belayd-agent-harness` barrel) |
| Comment read + `isHumanComment` + excerpt cap | `src/bead-comments.ts` |
| Phase refusal while waiting | `src/process-gate.ts` (`AwaitingHuman`, `awaitingHumanRefusal`) |
| Real-bd proof | `test/human-answer.integration.test.ts` |

## How to Verify

Run everything from the repository root. Every command below was executed in
this worktree; the outputs shown are real (`bd version 1.3.0`).

### 1. Full gates

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
pnpm test:integration
```

Real output:

```text
$ tsc --noEmit
$ biome check .
Checked 235 files in 432ms. No fixes applied.
$ tsc

 Test Files  119 passed (119)
      Tests  2781 passed (2781)

 Test Files  12 passed (12)
      Tests  93 passed (93)
```

The bd-152 suite inside `pnpm test:integration`:

```text
 ✓ test/human-answer.integration.test.ts (2 tests) 13898ms
   ✓ human answer channel against a real bd > ask → human comment → resolve, with the bead left open  8679ms
   ✓ human answer channel against a real bd > builds the argv the real CLI accepts for every gate read and comment read  5218ms
```

### 2. Real-bd walkthrough (throwaway database)

Never do this in the repo's `.beads/`. `BEADS_ACTOR=` clears the inherited actor
so each write names its own author explicitly.

```bash
D=/tmp/bd152-verify
rm -rf $D && mkdir -p $D && cd $D && git init -q
export BEADS_ACTOR=
bd init >/dev/null 2>&1
ID=$(bd create "human answer probe" -t task --json | jq -r '.id')
echo "bead: $ID"

# The gate `belayd_ask_human` opens (same argv as buildGateCreateArgv).
bd gate --actor belayd:probe:orchestrator create --blocks "$ID" \
  --type=human --reason "Which option, A or B?" --json
```

Real output (ids come from the directory name, so yours will differ):

```json
{
  "await_type": "human",
  "created_at": "2026-10-26T21:22:05.743792083Z",
  "created_by": "belayd:probe:orchestrator",
  "description": "Ad-hoc gate blocking bd152-verify-ku1\n\nReason: Which option, A or B?",
  "id": "bd152-verify-6ph",
  "issue_type": "gate",
  "owner": "hugo.lewenhaupt@gmail.com",
  "priority": 2,
  "status": "open",
  "title": "Gate: human"
}
```

The wait is visible and blocking in bd — this is the same read
`lookupOpenHumanGate` performs on every poll tick:

```bash
bd gate list "$ID" --json      # open gates only; bd answers null when there are none
bd gate list "$ID"             # human form: "⏳ Open Gates (1): ○ <gate> - human"
bd blocked                     # the bead appears here
bd ready                       # the bead does NOT appear here
```

Real output:

```text
[P2] bd152-verify-ku1: human answer probe
  Blocked by 1 open dependencies: [bd152-verify-6ph]

✨ No ready work found (all issues have blocking dependencies)
```

Now the author filter. The harness's own question is attributed to a `belayd:*`
actor and the human reply is not:

```bash
printf 'Which option, A or B?'                    | bd comment --actor belayd:probe:orchestrator --stdin -- "$ID" >/dev/null
printf 'B — keep the compatibility shim.'          | bd comment --actor hugo --stdin -- "$ID" >/dev/null
bd comments "$ID" --json | jq -r '.[] | "\(if (.author|startswith("belayd:")) then "FILTERED (harness)" else "ANSWER" end)\t\(.author)\t\(.text)"'
```

Real output — exactly what `isHumanComment` decides:

```text
FILTERED (harness)	belayd:probe:orchestrator	Which option, A or B?
ANSWER	hugo	B — keep the compatibility shim.
```

Resolving the gate clears the wait and **leaves the work bead open**:

```bash
bd gate --actor belayd:probe:orchestrator resolve <gate-id>   # == bd close <gate-id>
bd gate list "$ID" --json                                     # null
bd show "$ID" --json | jq -r '.[0] | "\(.id)\t\(.status)"'
bd ready
```

Real output:

```text
✓ Gate resolved: bd152-verify-6ph
null
bd152-verify-ku1	open
○ bd152-verify-ku1 P2 human answer probe
Ready: 1 issues with no active blockers
```

`open` is the point: answering resolved the *question*, not the *task*.

### 3. The integration test uses a real bd

`test/human-answer.integration.test.ts` skips itself when `bd` is missing
(`describe.skipIf(!bdAvailable)` probes `bd version`) and otherwise runs the real
binary against a `mkdtemp` database — `bd init`, `bd create`, real
`gate create --json` → `parseCreatedGateId`, an authored `comment --stdin`, real
`gate list <bead> --json` → `status: "open"`, a human `comment --actor hugo`, real
`gate resolve` → `status: "none"`, and `bd show` proving the bead is still
`open`. There is no `vi.mock` in the file.

```bash
pnpm vitest run test/human-answer.integration.test.ts
```

Real output:

```text
 ✓ test/human-answer.integration.test.ts (2 tests) 13898ms
   ✓ human answer channel against a real bd > ask → human comment → resolve, with the bead left open  8679ms
   ✓ human answer channel against a real bd > builds the argv the real CLI accepts for every gate read and comment read  5218ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### 4. The same read path, out of band, against a real bd

The harness-side detection is exported, so you can run it without a model. Real
output of the following script (fresh temp db):

```bash
node --input-type=module -e '
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const m = await import("./dist/src/index.js");
const env = { ...process.env, BEADS_ACTOR: "" };
const dir = mkdtempSync(join(tmpdir(), "bd152-guide-"));
await exec("bd", ["init"], { cwd: dir, env });
const beadId = JSON.parse((await exec("bd", ["create", "guide probe", "-t", "task", "--json"], { cwd: dir, env })).stdout).id;
const runBd = async (argv, o) => ({ stdout: (await exec("bd", [...argv], { cwd: o.cwd, env, timeout: o.timeoutInMs, maxBuffer: o.maxBufferInBytes })).stdout });
const gate = await exec("bd", ["gate", "--actor", "belayd:bd-152:orchestrator", ...m.buildGateCreateArgv({ beadId, reason: "Which option, A or B?" }).slice(1), "--json"], { cwd: dir, env });
const gateId = m.parseCreatedGateId(gate.stdout, beadId);
const pipe = (argv, body) => new Promise((res, rej) => { const c = execFile("bd", [...argv], { cwd: dir, env }, (e, so) => e ? rej(e) : res(so)); c.stdin?.on("error", () => {}); c.stdin?.end(body); });
await pipe(["comment", "--actor", "belayd:bd-152:orchestrator", "--stdin", "--", beadId], "Which option, A or B?");
const open = await m.lookupOpenHumanGate({ beadId, cwd: dir, runBd });
console.log("gate read before answer:", JSON.stringify(open));
const thread = await m.lookupBeadComments({ beadId, cwd: dir, runBd });
console.log("thread:", thread.comments.map((c) => `${c.author} -> human=${m.isHumanComment(c)}`).join(", "));
const baseline = Date.parse(open.gate.createdAt);
const none = thread.comments.find((c) => m.isHumanComment(c) && m.commentTimeInMs(c) >= baseline);
console.log("answer detected:", none === undefined ? "none (wait stays armed)" : JSON.stringify(none.text));
await pipe(["comment", "--actor", "hugo", "--stdin", "--", beadId], "B — keep the shim.");
const thread2 = await m.lookupBeadComments({ beadId, cwd: dir, runBd });
const found = thread2.comments.find((c) => m.isHumanComment(c) && m.commentTimeInMs(c) >= baseline);
console.log("delivered message:", `${found.author} answered: ${m.excerptComment(found.text)}`);
await exec("bd", ["gate", "--actor", "belayd:bd-152:orchestrator", "resolve", gateId], { cwd: dir, env });
const after = await m.lookupOpenHumanGate({ beadId, cwd: dir, runBd });
const bead = JSON.parse((await exec("bd", ["show", beadId, "--json"], { cwd: dir, env })).stdout)[0];
console.log("gate after resolve:", JSON.stringify(after), "| bead status:", bead.status);
'
```

```text
gate read before answer: {"ok":true,"status":"open","gate":{"gateId":"bd152-guide-g3UjKk-1en","createdAt":"2026-10-26T21:23:02Z"}}
thread: belayd:bd-152:orchestrator -> human=false
answer detected: none (wait stays armed)
delivered message: hugo answered: B — keep the shim.
gate after resolve: {"ok":true,"status":"none"} | bead status: open
```

### 5. The refusal reason, without a live model

A live orchestrator is not needed to see the refusal: `checkToolAllowed` is the
function the tool gate calls, and it is exported from the built library. Real
output (`dist/` must be current — `pnpm build`):

```bash
node --input-type=module -e '
const { checkToolAllowed } = await import("./dist/src/index.js");
const awaiting = { beadId: "bd-152", askedAt: Date.UTC(2026, 9, 26, 21, 22, 5) };
for (const t of ["belayd_implement","belayd_start_followup","belayd_proof_verifier","belayd_ask_human","belayd_status","belayd_stop_task","read","bd","belayd_outline"]) {
  const r = checkToolAllowed(t, ["scout","plan"], true, undefined, "feature", undefined, undefined, awaiting);
  console.log(t.padEnd(24), r.allowed ? "allowed" : r.reason);
}
'
```

```text
belayd_implement         Waiting for a human answer on bd-152 (asked 2026-10-26T21:22:05.000Z). Post a comment on the bead (bd comment bd-152 --stdin, or reply in Scotty) — phase tools stay refused until the answer arrives.
belayd_start_followup    Waiting for a human answer on bd-152 (asked 2026-10-26T21:22:05.000Z). Post a comment on the bead (bd comment bd-152 --stdin, or reply in Scotty) — phase tools stay refused until the answer arrives.
belayd_proof_verifier    Waiting for a human answer on bd-152 (asked 2026-10-26T21:22:05.000Z). Post a comment on the bead (bd comment bd-152 --stdin, or reply in Scotty) — phase tools stay refused until the answer arrives.
belayd_ask_human         allowed
belayd_status            allowed
belayd_stop_task         allowed
read                     allowed
bd                       allowed
belayd_outline           allowed
```

The tests that pin the surrounding behaviour (run them, they are fast):

```bash
pnpm vitest run src/__tests__/process-gate.test.ts src/__tests__/extension-human-answer.test.ts
pnpm vitest run src/__tests__/extension-human-answer.test.ts -t "refuses phase tools"
pnpm vitest run src/__tests__/process-gate.test.ts -t "refuses every phase tool of the workflow"
```

Real output:

```text
 Test Files  2 passed (2)
      Tests  137 passed (137)

 ✓ src/__tests__/extension-human-answer.test.ts (25 tests | 24 skipped) 886ms
   ✓ belayd_ask_human > opens a human gate, posts an authored comment, and refuses phase tools
 ✓ src/__tests__/process-gate.test.ts (112 tests | 111 skipped)
      Tests  1 passed | 111 skipped (112)
```

Case names worth knowing, by what they prove:

| Test (`src/__tests__/…`) | Proves |
| --- | --- |
| `extension-human-answer` › `opens a human gate, posts an authored comment, and refuses phase tools` | asks, then refuses `belayd_implement`/`belayd_commit`/`belayd_start_followup`, allows ask/status/read |
| `extension-human-answer` › `refuses an over-long question before spawning bd (S3)` | 2 001 chars ⇒ `keep it under 2000`, zero bd calls |
| `extension-human-answer` › `delivers exactly once when the poll fires and the next turn also runs` | one delivery across both paths |
| `extension-human-answer` › `never treats a belayd-authored comment as the answer, whoever wrote it` | session actor, `belayd:supervisor` mirror, phase agent, proof verifier |
| `extension-human-answer` › `does not deliver a human comment posted before the gate was created` | the gate time is the baseline |
| `extension-human-answer` › `keeps the wait armed when the gate record does not parse (W1)` | fail-closed gate parsing |
| `extension-human-answer` › `degrades to no answer when bd is unavailable, without unblocking or throwing` | bd absent ⇒ still waiting |
| `extension-human-answer` › `reports a gate resolved without a comment so the workflow can proceed` | external `bd gate resolve` resumes |
| `extension-human-answer` › `reaps the gate and stops the poll on belayd_stop_task` / `… when /plan drops the workflow` / `stops the poll on session shutdown (C1)` | teardown paths |
| `extension-human-answer` › `re-arms the wait from the open bd gate and delivers the pending answer` | restart rediscovery |
| `bead-gates` › `reports “unrecognized” — never a resolution — when records do not parse` | five malformed shapes stay pending |
| `bead-comments` › `treats anything not authored by the harness as a human answer` | the whole author filter |

Cleanup:

```bash
rm -rf /tmp/bd152-verify /tmp/bd152-guide-*
```

## How to Use

### Asking a human

The orchestrator calls the tool with a question and then **ends its turn**:

```json
{
  "question": "bd-152 cannot satisfy both constraints. Do I (a) keep the shim and drop the strict mode, or (b) drop the shim and require a migration?",
  "beadId": "bd-152"
}
```

- `question` — required, trimmed, ≤ **2 000 characters**, no NUL bytes. The cap
  exists because the text goes into `bd gate create --reason` argv; put long
  detail in a bead note and ask the short question.
- `beadId` — optional; defaults to the active workflow's bead. With neither, the
  tool refuses: `belayd_ask_human: no bead to ask about. It needs an active
  workflow, or an explicit beadId.`

Underneath, two bd writes in this order (`bd gate` is deliberately *not* on the
allowlisted `bd` proxy; these are direct `runBdCommand` calls):

```text
bd gate --actor <actor> create --blocks <bead> --type=human --reason "<question>" --json
bd comment --actor <actor> --stdin -- <bead>          # stdin = the question
```

The gate comes first so the wait is visible in bd/Scotty even if the comment
write fails; the comment is `belayd:*`-authored, which is exactly what keeps the
question out of the answer filter. The tool answers with:

```text
Asked a human on bd-152 (gate bd-159).
The bead is blocked by a `human` gate and every phase tool is REFUSED until an answer arrives.
END YOUR TURN NOW — do not guess, do not proceed, do not call another phase tool. The answer arrives as a user message.
```

A second `belayd_ask_human` while one is open does **not** open a second gate or
arm a second poll; it returns `Already waiting for a human answer on bd-152 — END
YOUR TURN.`

### Answering

Reply on the bead. That is the whole protocol:

```bash
bd comment bd-152 --stdin                       # paste, then Ctrl-D
echo "option b — keep the shim" | bd comment bd-152 --stdin
bd comment bd-152 "option b"                    # short answers
bd comments add bd-152 "option b"               # plural form, same write
```

In Scotty, reply in the bead's comment thread — it is the same comment. Your
actor is whatever bd records (`$BEADS_ACTOR`, `git config user.name`, `$USER`);
any author that does not start with `belayd:` counts as a human answer, including
another tool's.

The harness sees it on its next 30 s tick (or on the next turn, if the timer
cannot wake the session) and injects:

```text
hugo answered: option b — keep the shim
```

- The answer is the **first** non-`belayd:*` comment **at or after the gate's
  `created_at`** (bd timestamps are second-granularity, hence "at or after"). A
  human comment written *before* the gate — an earlier answer on the same bead —
  does not auto-answer.
- The comment body is flattened to one line and capped at 2 000 characters with
  an `…` marker, because it is injected into a prompt.
- The session then resolves the gate (`bd gate resolve <gate-id>`) and phase
  tools come back. The work bead stays `open` — **answering is not accepting**.
  Finish the workflow, then `wt merge` / `bd close` as usual.

### Watching it from bd / Scotty

| Question | Command |
| --- | --- |
| Is a question open on this bead? | `bd gate list bd-152` / `bd gate list bd-152 --json` |
| What was asked? | `bd show <gate-id> --json` (the question is in `description`) |
| Which beads are waiting on me? | `bd blocked` |
| What can work proceed on? | `bd ready` — a gate-blocked bead is absent |
| What did I answer? | `bd comments bd-152 --json \| jq -r '.[] \| "\(.author)\t\(.text)"'` |
| Which comments the harness ignores | `bd comments bd-152 --json \| jq -r '.[] \| select(.author \| startswith("belayd:")) \| .author'` |

Answer out-of-band with `bd gate resolve <gate-id>` (or `bd close <gate-id>`) and
the workflow resumes without a comment, receiving:

```text
The human gate on bd-152 was resolved without a comment; you may proceed.
```

### Refusal surface while waiting

Refused (the whole workflow's phase tools, required and consultable, plus the
control tools that would advance or spawn work on the blocked bead):
`belayd_scout`/`_plan`/`_implement`/`_review`/`_test`/`_userguide`/`_proof`/`_commit`
and any consult phase tool of the workflow, plus `belayd_start_followup`,
`belayd_stack_rebase`, `belayd_proof_verifier`.

Still callable, so the session can ask again, report, and be stopped:
`belayd_ask_human`, `belayd_status`, `belayd_doctor`, `belayd_stop_task`,
`read`, `grep`, `find`, `ls`, `bash`, `bd`, `belayd_outline`, `belayd_archify`.

### Degradation (fail-closed)

| Situation | Behaviour |
| --- | --- |
| `bd` missing, slow (> 15 s), or non-JSON | read returns `{ ok: false }`; the wait **stays armed**, nothing is delivered, nothing throws |
| Gate JSON parses but is not an open `human` gate (renamed `status`/`await_type`, a timer or `gh:run` gate, a malformed entry) | treated as "unknown", wait stays armed, one warning per wait: `[belayd-harness] bd reported gates for <bead> that are not open human gates; the human wait stays armed (bd gate JSON may have changed).` |
| Gate create fails | no wait is armed and no phase tool is refused — the workflow is not blocked by a gate bd never created |
| Comment write fails, compensating resolve succeeds | tool returns exit 1, no wait: nothing is left blocking the bead |
| Comment write fails *and* gate resolve fails | wait **stays armed** (poll keeps watching) and the text warns the bead may be left blocked; recover with `bd gate list <bead>` + `bd gate resolve <gate>` |
| Gate resolved externally, no comment | wait clears, workflow resumes with the "resolved without a comment" message |
| `bd gate list` says there are no gates any more | that is a genuine resolution, not a parse failure |

The distinction that matters: **`none` unblocks, `unrecognized` never does.**
"bd changed its JSON" must never look like "a human answered".

### Teardown: the gate goes with the workflow

The wait, the 30 s poll (`HUMAN_ANSWER_POLL_INTERVAL_MS`, `unref()`'d so a pi
process does not live to wait) and the gate are reaped together:

| Event | Gate | Wait + poll |
| --- | --- | --- |
| `belayd_stop_task` | resolved | cleared |
| Workflow completion (last phase settles) | resolved | cleared |
| `/plan` dropping the workflow | resolved | cleared |
| `session_shutdown` | left alone (session is gone; bd state is the record) | cleared, so the timer cannot `sendUserMessage` into a dead session |
| Handoff to a child orchestrator / losing the orchestrator lease | left open on purpose — the new driver re-discovers it | cleared |
| Session restart | re-read from `bd gate list <bead>` and the poll re-armed | re-armed |

A teardown never fails because bd did: every reap is best-effort and bounded.

### Fleet mirror: supervisor notes are visible on the bead

Supervisor → member fleet notes are still delivered through the file mailbox
(that is the delivery/ack protocol, unchanged). bd-152 additionally *mirrors*
each note onto the recipient's bead as one comment, so the traffic is readable in
bd/Scotty:

```text
[belayd:supervisor->bd-150] main moved; rebase before review
```

- one comment per recipient (a broadcast writes one per member bead), excerpted
  to the same 2 000-character cap;
- authored by `belayd:supervisor` (or the session's own `belayd:*` actor), so a
  mirror is **never** mistaken for a human answer;
- best-effort: a bd failure logs `[belayd-harness] fleet note mirror failed: …`,
  audits `note-mirror-failed`, and the note is still delivered. The tool text says
  `Mirrored to N bd comment(s).`, or nothing when the mirror wrote none.

### Limits and known windows

- **Exactly once on the normal path.** The timer path and the turn-start path
  share one per-session claim, so an answer cannot be delivered twice even when
  both fire in either order.
- **Redelivery window (poll path).** The poll sends first and resolves after, so
  a process crash *after* the send but *before* `bd gate resolve` leaves the gate
  open; after a restart the wait is re-armed and the same comment is delivered
  again. Prefer repeating an answer to losing one.
- **Loss window (turn-start path).** When the answer is delivered as the message
  returned by `before_agent_start`, the wait has to settle before returning; a
  crash in that sliver loses the delivery. The comment remains in bd/Scotty for a
  human to re-post.
- **A comment older than the gate never auto-answers.** The baseline is the
  gate's `created_at`; re-state the answer after asking.
- **`belayd:*` comments are never answers**, whoever wrote them: the
  orchestrator's own question, a phase agent's note, the fleet mirror, a proof
  verifier. Only a non-`belayd:` author counts.
- **A permanently failing `bd` does not unblock.** It logs
  `[belayd-harness] human answer check failed: …` and keeps waiting; the
  `unrecognized` warning is emitted once per wait, the read failure is not
  rate-limited.
- **Answering is not accepting.** Nothing in this channel closes the bead — see
  `bd-150` for the assignee lifecycle that runs alongside it.

### Library use

The read half is exported from `belayd-agent-harness`, so scripts and tests can
use the exact filter the harness uses:

```typescript
import { execFile } from "node:child_process";
import {
  buildBeadCommentsArgv,
  buildGateCreateArgv,
  buildGateListArgv,
  buildGateResolveArgv,
  commentTimeInMs,
  excerptComment,
  isHumanComment,
  lookupBeadComments,
  lookupOpenHumanGate,
  parseCreatedGateId,
  parseOpenHumanGate,
} from "belayd-agent-harness";

const runBd = async (argv: readonly string[], options: { cwd: string }) => ({
  stdout: (await execFile("bd", [...argv], { cwd: options.cwd })).stdout,
});

// The gate `belayd_ask_human` opens.
buildGateCreateArgv({ beadId: "bd-152", reason: "Which option, A or B?" });
// ["gate", "create", "--blocks", "bd-152", "--type=human", "--reason", "Which option, A or B?"]
buildGateListArgv("bd-152");      // ["gate", "list", "bd-152", "--json"]
buildGateResolveArgv("bd-159");   // ["gate", "resolve", "bd-159"]

// Three distinct outcomes — "unrecognized" must never be read as "resolved".
const gate = await lookupOpenHumanGate({ beadId: "bd-152", cwd: "/repo", runBd });
// { ok: true, status: "open", gate: { gateId, createdAt } }
// | { ok: true, status: "none" }
// | { ok: true, status: "unrecognized" }
// | { ok: false, error }

if (gate.ok && gate.status === "open") {
  const thread = await lookupBeadComments({ beadId: "bd-152", cwd: "/repo", runBd });
  if (thread.ok) {
    const baseline = Date.parse(gate.gate.createdAt ?? "");
    const answer = thread.comments.find(
      (comment) => isHumanComment(comment) && commentTimeInMs(comment) >= baseline,
    );
    if (answer !== undefined) console.log(`${answer.author} answered: ${excerptComment(answer.text)}`);
  }
}

// Pure helpers, no bd needed.
isHumanComment({ author: "belayd:bd-152:review" }); // false — harness
isHumanComment("hugo");                             // true  — human
excerptComment("line one\n\nline two");             // "line one line two"
parseOpenHumanGate([{ id: "bd-159", status: "open", await_type: "human" }], "bd-152");
// { gateId: "bd-159" } (a non-human await_type, a closed gate, or the bead's own id → undefined)
parseCreatedGateId('{"id":"bd-159"}', "bd-152");    // "bd-159"
```

All of these return errors as values and never throw, and the bd runner is
injected — which is how `test/human-answer.integration.test.ts` runs them against
a real `bd` while the unit suites run them against a stub.
