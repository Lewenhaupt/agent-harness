# Ownership and "Needs you" in the fleet status view (bd-153)

Before bd-153 the fleet view could say *what* every workflow was doing, but not
*who owns it* and not *whether a person is blocking it*. It read five bead fields
(`id`, `title`, `status`, `priority`, `labels`) from one batched
`bd show <ids> --json`, so a bead a human had to look at was invisible unless you
opened the bead yourself, and the newest comment on a bead never appeared in any
harness surface.

bd-153 adds two read-only column groups to the existing tools:

- **`belayd_fleet_status`** — every member's bead block gains `owner:`,
  `assignee:`, `human:`, `bead updated:`, `comment count:`, `awaiting human:` and
  `newest comment:`, and a `Needs you (<n>): <ids>` block under the `states:`
  line names every member that carries bd's `human` label or has an open `human`
  gate;
- **`belayd_status`** — the bead this session drives gets an ownership/human
  section (`**Bead <id>**` … `**Needs you** — <id> is waiting on a human.`).

Both are **display only**: nothing is claimed, closed, delivered or written. The
new reads are `bd comments <id> --json` and `bd gate list <id> --json`, which is
also where the bd-152 `human` gate is observed — the old
`.belayd/human-question.json` marker is obsolete (bd-152 replaced it) and bd-153
never looks for it.

**This guide describes terminal surfaces only.** `belayd_status` and
`belayd_fleet_status` are pi tools whose entire output is plain text in a tool
result: there is no browser, no screenshot, and no UI state to prove. Everything
below is a command and its real output, run in this worktree with
`bd version 1.3.0 (dev)` and `node v24.18.0`.

| Piece | Where |
| --- | --- |
| Pure types, `applyFleetBeadEngagement`, `beadNeedsHuman`, `formatNeedsYou`, `formatBeadOwnership` | `src/fleet-status.ts` |
| The reader: `lookupFleetBeadEngagement`, `ENGAGEMENT_CONCURRENCY` | `src/fleet-bead-engagement.ts` |
| Comment parsing with a dropped-record count, code-point excerpt cap | `src/bead-comments.ts` |
| Tool wiring for both tools | `extensions/index.ts` (`readFleetEngagement`, `readBeadOwnership`) |
| Reading guides | `docs/fleet-status.md`, `docs/fleet.md` |

## How to Verify

Run everything from the repository root unless a step says otherwise.

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
Checked 239 files in 444ms. No fixes applied.
$ tsc

 Test Files  120 passed (120)
      Tests  2870 passed (2870)

 Test Files  13 passed (13)
      Tests  98 passed (98)
```

The three suites that own this change:

```bash
pnpm vitest run src/__tests__/fleet-bead-engagement.test.ts \
  src/__tests__/fleet-status.test.ts \
  src/__tests__/extension-fleet-status-tool.test.ts
```

```text
 ✓ src/__tests__/extension-fleet-status-tool.test.ts (23 tests) 775ms
 Test Files  3 passed (3)
      Tests  142 passed (142)
```

### 2. A throwaway beads database with four differently-shaped beads

Never do this in the repository's own `.beads/`. Each write names its actor,
`BEADS_ACTOR=` clears the inherited one, and `bd init -p bd` yields `bd-<hash>`
ids — the shape bd-153's task-id pattern (`isValidTaskId`) accepts.

```bash
export T=/tmp/bd153-verify          # scratch repo (not the bead ids below)
rm -rf "$T" && mkdir -p "$T" && cd "$T" && git init -q .
git config user.email t@example.com && git config user.name t
echo hi > README.md && git add README.md && git commit -qm init
export BEADS_ACTOR=
bd init -p bd >/dev/null 2>&1

A=$(bd create "Ownership probe: labelled human, assigned, answered" -t task --json | jq -r .id)
B=$(bd create "Ownership probe: open human gate, unassigned" -t task --json | jq -r .id)
C=$(bd create "Ownership probe: plain, empty thread" -t task --json | jq -r .id)
D=$(bd create "Ownership probe: plain, belayd comment only" -t task --json | jq -r .id)

bd label add "$A" human >/dev/null              # the bd-side "needs a person" flag
bd assign "$A" "Hugo Lewenhaupt" >/dev/null     # a person owns it
bd assign "$C" "belayd:$C:implement" >/dev/null # an agent phase owns it
printf 'Should I keep the compatibility shim?\n' | bd comment --actor belayd:bd-153:orchestrator --stdin -- "$A" >/dev/null
printf 'Yes - keep the shim and drop strict mode.\n' | bd comment --actor hugo --stdin -- "$A" >/dev/null
printf 'phase deliverable: test phase done\n'    | bd comment --actor "belayd:$D:test" --stdin -- "$D" >/dev/null

# After the comments, the gate bd-152's belayd_ask_human opens (blocks the bead).
G=$(bd gate --actor belayd:bd-153:orchestrator create --blocks "$B" --type=human \
      --reason "Which option, A or B?" --json | jq -r .id)

echo "A=$A B=$B C=$C D=$D G=$G"
```

Real output (ids are hashed from the bead content; yours will differ — every
output below uses this set, so substitute your own ids as you go):

```text
A=bd-891 B=bd-iwd C=bd-xa6 D=bd-5j8 G=bd-8w4
```

The four shapes the view has to distinguish, straight from `bd show --json`
(`cd "$T"` first — everything below runs inside the scratch repo):

```bash
cd "$T"
bd show "$A" "$B" "$C" "$D" --json \
  | jq -r '.[] | "\(.id)\tassignee=\(.assignee // "<absent>")\towner=\(.owner // "<absent>")\tlabels=\((.labels//[])|join(","))\tcomments=\(.comment_count)\tupdated=\(.updated_at)"'
```

```text
bd-891	assignee=Hugo Lewenhaupt	owner=t@example.com	labels=human	comments=2	updated=2026-10-27T08:50:26Z
bd-iwd	assignee=<absent>	owner=t@example.com	labels=	comments=0	updated=2026-10-27T08:50:25Z
bd-xa6	assignee=belayd:bd-xa6:implement	owner=t@example.com	labels=	comments=0	updated=2026-10-27T08:50:26Z
bd-5j8	assignee=<absent>	owner=t@example.com	labels=	comments=1	updated=2026-10-27T08:50:25Z
```

`assignee` is **omitted** by bd for an unassigned bead — that absence is the
`(unassigned)` column, not an error. The view only renders beads that are *fleet
members*, so give each one a worktree holding a `workflow.json`:

```bash
cd "$T"
for pair in a:"$A" b:"$B" c:"$C" d:"$D"; do
  wt=${pair%%:*}; id=${pair##*:}
  git worktree add -q -b "bd-153/$id" "wt-$wt"
  mkdir -p "wt-$wt/.belayd"
  cat > "wt-$wt/.belayd/workflow.json" <<EOF
{"schemaVersion":1,"taskId":"$id","workflowType":"feature","branch":"bd-153/$id","originalCwd":"/tmp/bd153-verify/wt-$wt","phaseOrder":["scout","plan","implement","review","test"],"completedPhaseNames":["scout"],"startedAt":1761554400000,"updatedAt":1761554400000}
EOF
done
git worktree list
```

```text
/tmp/bd153-verify      105798b [main]
/tmp/bd153-verify/wt-a 105798b [bd-153/bd-891]
/tmp/bd153-verify/wt-b 105798b [bd-153/bd-iwd]
/tmp/bd153-verify/wt-c 105798b [bd-153/bd-xa6]
/tmp/bd153-verify/wt-d 105798b [bd-153/bd-5j8]
```

### 3. Render the view through the compiled surface

This is the composition `belayd_fleet_status` performs (`extensions/index.ts`,
`readFleetBeads` → `readFleetEngagement` → `applyFleetBeadLookup` +
`applyFleetBeadEngagement` → `formatFleetStatus`). Save it as
`/tmp/bd153-render.mjs` (`dist/` must be current — `pnpm build`).

```javascript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as m from "/home/hugo/git/feat-bd-153/dist/src/index.js";

const exec = promisify(execFile);
const cwd = "/tmp/bd153-verify";
const runBd = async (argv, options = {}) => ({
  stdout: (
    await exec("bd", [...argv], {
      cwd: options.cwd ?? cwd,
      timeout: options.timeoutInMs,
      maxBuffer: options.maxBufferInBytes,
      env: { ...process.env, BEADS_ACTOR: "" },
    })
  ).stdout,
});

const read = m.readFleetStatus({ cwd, fleetId: m.DEFAULT_FLEET_ID });
if (!read.ok) { console.error(read.error); process.exit(1); }
const taskIds = m.fleetBeadTaskIds(read.value);
const beads = await m.lookupFleetBeads({ taskIds, cwd, runBd });
const engagement = await m.lookupFleetBeadEngagement({ taskIds, cwd, runBd });
console.log("bead task ids:", taskIds.join(", "));
console.log("engagement lookup ok:", engagement.ok);
console.log(
  m.formatFleetStatus(
    m.applyFleetBeadEngagement(m.applyFleetBeadLookup(read.value, beads), engagement),
  ),
);
```

Run it behind a `bd` shim that records argv (step 6 uses the log):

```bash
mkdir -p /tmp/bd153-bin
cat > /tmp/bd153-bin/bd <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> /tmp/bd153-argv.log
exec /nix/store/cfswmdsz67fk6rglclgcjcqcmk2bhy05-beads-1.3.0/bin/bd "$@"
EOF
chmod +x /tmp/bd153-bin/bd

cd "$T" && rm -f /tmp/bd153-argv.log
PATH=/tmp/bd153-bin:$PATH node /tmp/bd153-render.mjs
```

Real output:

```text
bead task ids: bd-5j8, bd-891, bd-iwd, bd-xa6
engagement lookup ok: true entries: 4
===== formatFleetStatus =====
Fleet default
  intent: none recorded
  members: 4
  states: active=4 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Needs you (2): bd-891, bd-iwd
  - bd-891 (assignee Hugo Lewenhaupt) — hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
  - bd-iwd (assignee (unassigned), awaiting human) — (no comments yet)

Member bd-5j8 — active
  worktree: /tmp/bd153-verify/wt-d (branch bd-153/bd-5j8)
  bead: Ownership probe: plain, belayd comment only (open)
  owner: t@example.com
  assignee: (unassigned)
  human: no
  bead updated: 2026-10-27T08:50:25Z
  comment count: 1
  awaiting human: no
  newest comment: belayd:bd-5j8:test 2026-10-27T08:50:27Z: "phase deliverable: test phase done"
  workflow: feature 1/5 phases complete
  pending: plan, implement, review, test
  awaiting review response: no
  interrupted runs: 0
  orchestrator lease: none
  last updated: 2025-10-27T08:40:00.000Z
  latest runs: none

Member bd-891 — active
  worktree: /tmp/bd153-verify/wt-a (branch bd-153/bd-891)
  bead: Ownership probe: labelled human, assigned, answered (open)
  owner: t@example.com
  assignee: Hugo Lewenhaupt
  human: yes
  bead updated: 2026-10-27T08:50:26Z
  comment count: 2
  awaiting human: no
  newest comment: hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
  workflow: feature 1/5 phases complete
  pending: plan, implement, review, test
  awaiting review response: no
  interrupted runs: 0
  orchestrator lease: none
  last updated: 2025-10-27T08:40:00.000Z
  latest runs: none

Member bd-iwd — active
  worktree: /tmp/bd153-verify/wt-b (branch bd-153/bd-iwd)
  bead: Ownership probe: open human gate, unassigned (open)
  owner: t@example.com
  assignee: (unassigned)
  human: no
  bead updated: 2026-10-27T08:50:25Z
  comment count: 0
  awaiting human: yes
  newest comment: (none)
  workflow: feature 1/5 phases complete
  pending: plan, implement, review, test
  awaiting review response: no
  interrupted runs: 0
  orchestrator lease: none
  last updated: 2025-10-27T08:40:00.000Z
  latest runs: none

Member bd-xa6 — active
  worktree: /tmp/bd153-verify/wt-c (branch bd-153/bd-xa6)
  bead: Ownership probe: plain, empty thread (open)
  owner: t@example.com
  assignee: belayd:bd-xa6:implement
  human: no
  bead updated: 2026-10-27T08:50:26Z
  comment count: 0
  awaiting human: no
  newest comment: (none)
  workflow: feature 1/5 phases complete
  pending: plan, implement, review, test
  awaiting review response: no
  interrupted runs: 0
  orchestrator lease: none
  last updated: 2025-10-27T08:40:00.000Z
  latest runs: none
```

What this output proves, line by line:

- `Needs you (2)` names **both** waiters and nothing else: `bd-iwd` (open gate,
  no `human` label) and `bd-891` (`human` label, gate resolved). `bd-5j8` and
  `bd-xa6` are not waiting and are absent.
- `awaiting human: yes` for `bd-iwd` comes from the bd-152 gate while `human: no`
  says the *label* is absent — the two signals are independent and `Needs you`
  is their OR.
- `newest comment: (none)` appears for `bd-iwd` and `bd-xa6` and both are
  genuine empty threads: the read succeeded. `(none)` is unreachable any other
  way (step 5).
- `assignee: (unassigned)` (`bd-iwd`, `bd-5j8`) is bd reporting no assignee;
  `bd-xa6` shows a `belayd:<task>:<phase>` phase owner and `bd-891` a person.
- `bead updated:` is printed exactly as bd returned it (`2026-10-27T08:50:26Z`) —
  the view has no clock of its own, so repeated calls are byte-identical.
  `last updated:` is the unrelated workflow-file timestamp.
- Both comment authors render: the human reply on `bd-891`, a `belayd:*` phase
  comment on `bd-5j8`.

### 4. Per-bead degradation vs. total outage

A `bd` that fails for **one** bead's engagement reads must not spoil the rest.
Shim that fails only `comments`/`gate list` for `bd-iwd` (the gate-bearing bead
above — substitute the id your own run produced, `B` in step 2):

```bash
mkdir -p /tmp/bd153-partial
cat > /tmp/bd153-partial/bd <<'EOF'
#!/usr/bin/env bash
case "$1" in
  comments|gate)
    for arg in "$@"; do
      if [ "$arg" = "bd-iwd" ]; then
        echo "Error: cannot open beads database: no such database" >&2
        exit 1
      fi
    done
    ;;
esac
exec /nix/store/cfswmdsz67fk6rglclgcjcqcmk2bhy05-beads-1.3.0/bin/bd "$@"
EOF
chmod +x /tmp/bd153-partial/bd

cd "$T"
PATH=/tmp/bd153-partial:$PATH node /tmp/bd153-render.mjs | head -12
PATH=/tmp/bd153-partial:$PATH node /tmp/bd153-render.mjs | sed -n '/Member bd-iwd/,/workflow:/p'
PATH=/tmp/bd153-partial:$PATH node /tmp/bd153-render.mjs | grep -c Warnings
```

Real output:

```text
bead task ids: bd-5j8, bd-891, bd-iwd, bd-xa6
engagement lookup ok: true entries: 4
===== formatFleetStatus =====
Fleet default
  intent: none recorded
  members: 4
  states: active=4 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Needs you (1): bd-891
  - bd-891 (assignee Hugo Lewenhaupt) — hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."

Member bd-5j8 — active
Member bd-iwd — active
  worktree: /tmp/bd153-verify/wt-b (branch bd-153/bd-iwd)
  bead: Ownership probe: open human gate, unassigned (open)
  owner: t@example.com
  assignee: (unassigned)
  human: no
  bead updated: 2026-10-27T08:50:25Z
  comment count: 0
  awaiting human: unknown
  newest comment: (unknown)
  workflow: feature 1/5 phases complete
0
```

`awaiting human: unknown` / `newest comment: (unknown)`, siblings untouched, and
**no warning at all** (the last line is `grep -c Warnings` → `0`). Note the
honest consequence: `bd-iwd` also dropped out of `Needs you`, because its gate
could no longer be read — `unknown` never counts as "waiting". The member block
is where you see it.

Now a total outage — a `bd` that always fails (missing binary, dead database):

```bash
mkdir -p /tmp/bd153-broken
cat > /tmp/bd153-broken/bd <<'EOF'
#!/usr/bin/env bash
echo "Error: cannot open beads database: no such database" >&2
exit 1
EOF
chmod +x /tmp/bd153-broken/bd

cd "$T" && PATH=/tmp/bd153-broken:$PATH node /tmp/bd153-render.mjs | tail -16
```

Real output:

```text
bead task ids: bd-5j8, bd-891, bd-iwd, bd-xa6
engagement lookup ok: false entries: Command failed: bd comments bd-5j8 --json
Error: cannot open beads database: no such database

===== formatFleetStatus =====
...
  latest runs: none

Warnings (2):
  - bead metadata unavailable (bd read failed): Command failed: bd show bd-5j8 bd-891 bd-iwd bd-xa6 --json Error: cannot open beads database: no such database
  - bead engagement unavailable (bd read failed): Command failed: bd comments bd-5j8 --json Error: cannot open beads database: no such database
```

Exactly one `bead engagement unavailable` warning for the whole fleet — never one
per member — and the derived workflow view (states, phases, runs) is intact. A
total bd outage shows two warnings because the pre-existing batched `bd show`
also fails; each warning appears once, never per member.

### 5. Fail-closed: a malformed gate record must never say `no`

bd's schema drifting is not "nobody is waiting". Feed the real reader a
malformed gate record (no `await_type`) and a comment payload whose records have
no usable `id`/`text`; `show` still passes through to the real `bd`:

```javascript
// /tmp/bd153-malformed.mjs — only the two engagement reads are crafted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as m from "/home/hugo/git/feat-bd-153/dist/src/index.js";

const exec = promisify(execFile);
const cwd = "/tmp/bd153-verify";
const REAL = "/nix/store/cfswmdsz67fk6rglclgcjcqcmk2bhy05-beads-1.3.0/bin/bd";
const runBd = async (argv, options = {}) => {
  if (argv[0] === "comments") return { stdout: JSON.stringify([{ author: "hugo", body: "renamed field" }]) };
  if (argv[0] === "gate") return { stdout: JSON.stringify([{ id: "bd-999", status: "open" }]) };
  return {
    stdout: (
      await exec(REAL, [...argv], {
        cwd: options.cwd ?? cwd,
        timeout: options.timeoutInMs,
        maxBuffer: options.maxBufferInBytes,
        env: { ...process.env, BEADS_ACTOR: "" },
      })
    ).stdout,
  };
};

const read = m.readFleetStatus({ cwd, fleetId: m.DEFAULT_FLEET_ID });
const taskIds = m.fleetBeadTaskIds(read.value);
const beads = await m.lookupFleetBeads({ taskIds, cwd, runBd });
const engagement = await m.lookupFleetBeadEngagement({ taskIds, cwd, runBd });
const text = m.formatFleetStatus(
  m.applyFleetBeadEngagement(m.applyFleetBeadLookup(read.value, beads), engagement),
);
console.log("engagement ok:", engagement.ok);
console.log(text.split("\n").filter((l) => /awaiting human:|newest comment:|Needs you|^  - bd-/.test(l)).join("\n"));
const ownershipLines = text.split("\n").filter((l) => /awaiting human:|newest comment:/.test(l));
console.log("any 'awaiting human: no'      :", ownershipLines.some((l) => l.includes("awaiting human: no")));
console.log("any 'newest comment: (none)'  :", ownershipLines.some((l) => l.includes("newest comment: (none)")));
console.log("all 'awaiting human: unknown' :", ownershipLines.filter((l) => l.includes("awaiting human:")).every((l) => l.endsWith("unknown")));
console.log("all 'newest comment: (unknown)':", ownershipLines.filter((l) => l.includes("newest comment:")).every((l) => l.includes("(unknown)")));
```

Real output:

```text
engagement ok: true
Needs you (1): bd-891
  - bd-891 (assignee Hugo Lewenhaupt) — (comments unknown)
  awaiting human: unknown
  newest comment: (unknown)
  awaiting human: unknown
  newest comment: (unknown)
  awaiting human: unknown
  newest comment: (unknown)
  awaiting human: unknown
  newest comment: (unknown)
any 'awaiting human: no'      : false
any 'newest comment: (none)'  : false
all 'awaiting human: unknown' : true
all 'newest comment: (unknown)': true
```

- every member's `awaiting human:` is `unknown` and `no` appears **nowhere**;
- every `newest comment:` is `(unknown)` and `(none)` appears **nowhere** —
  records came back that the parser could not use (`dropped > 0`), which is
  schema drift, not an empty thread;
- `Needs you` still names `bd-891` (its `human` *label* parsed fine) but prints
  `(comments unknown)` instead of `(no comments yet)`;
- `bd-iwd` is **not** listed, because an unparsable gate is not evidence of a
  wait. `unknown` is an invitation to check bd, never a claim either way.

Mirrored unit cases: `fleet-bead-engagement.test.ts` › `treats a malformed gate
record as unknown, never as resolved`, `renders (unknown), never (none), when bd
returned records that all failed to parse`; `fleet-status.test.ts` › `renders
unknown for an unrecognized gate and never says no`.

### 6. Read-only, proven live

Snapshot every file of the scratch repo (excluding `.git/` and `.beads/`, bd's
own database), render, compare:

```bash
cd "$T"
find . -path ./.git -prune -o -path ./.beads -prune -o -type f -print | sort | xargs sha256sum > /tmp/bd153-before.sha
git status --porcelain
rm -f /tmp/bd153-argv.log
PATH=/tmp/bd153-bin:$PATH node /tmp/bd153-render.mjs >/dev/null
find . -path ./.git -prune -o -path ./.beads -prune -o -type f -print | sort | xargs sha256sum > /tmp/bd153-after.sha
git status --porcelain
diff /tmp/bd153-before.sha /tmp/bd153-after.sha && echo "IDENTICAL: harness created/modified no file"
find . -name human-question.json -o -name fleet -type d
ls -a .git | grep -i belayd || echo "no .git/belayd directory"
echo "== argv issued on that call =="; cat /tmp/bd153-argv.log
ls -l .beads/last-touched        # bd's own bookkeeping, updated by bd, not by the harness
```

Real output:

```text
?? wt-a/
?? wt-b/
?? wt-c/
?? wt-d/
?? wt-a/
?? wt-b/
?? wt-c/
?? wt-d/
IDENTICAL: harness created/modified no file
no .git/belayd directory
== argv issued on that call ==
show bd-5j8 bd-891 bd-iwd bd-xa6 --json
comments bd-5j8 --json
comments bd-891 --json
comments bd-iwd --json
comments bd-xa6 --json
gate list bd-5j8 --json
gate list bd-iwd --json
gate list bd-891 --json
gate list bd-xa6 --json
-rw------- 1 hugo users 7 okt 27 09:51 .beads/last-touched
```

Only `show`, `comments`, `gate list` — no `comment`, `close`, `update`, `label`,
`gate create`, `gate resolve`, `sync`. No `human-question.json`, no fleet
directory, and even `<git-common-dir>/belayd/` is not created. (If you snapshot
`.beads/` too, the one file that changes is `.beads/last-touched`: bd's own
marker, written by the `bd` CLI on any read. The harness path itself writes
nothing.)

Cost is **one** batched `show` plus **two** calls per member (`1 + 2N` — 9 for
this 4-member fleet), at most `ENGAGEMENT_CONCURRENCY = 4` beads in flight (each
bead reads its two sources sequentially, so at most 4 engagement processes run
at once), each read under a 15 s runner timeout plus a watchdog, and an empty
member set spawns nothing at all.

The test that pins the exact argv set (one member ⇒ exactly three read-only
invocations, no marker file, no fleet directory):

```bash
pnpm vitest run src/__tests__/extension-fleet-status-tool.test.ts -t "issues only read subcommands"
```

```text
 ✓ src/__tests__/extension-fleet-status-tool.test.ts (23 tests | 22 skipped) 710ms
   ✓ belayd_fleet_status tool > belayd_fleet_status writes nothing and issues only read subcommands  709ms
 Test Files  1 passed (1)
      Tests  1 passed | 22 skipped (23)
```

### 7. `belayd_status`: the same columns for the session's own bead

`belayd_status` appends whatever `formatBeadOwnership` returns, between the
process-state section and the active-runs section, and runs `show` concurrently
with the `comments` + `gate list` pair. Save as `/tmp/bd153-status.mjs`:

```javascript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as m from "/home/hugo/git/feat-bd-153/dist/src/index.js";

const exec = promisify(execFile);
const cwd = "/tmp/bd153-verify";
const runBd = async (argv, options = {}) => ({
  stdout: (await exec("bd", [...argv], {
    cwd: options.cwd ?? cwd,
    timeout: options.timeoutInMs,
    maxBuffer: options.maxBufferInBytes,
    env: { ...process.env, BEADS_ACTOR: "" },
  })).stdout,
});

const section = async (taskId) => {
  const beads = await m.lookupFleetBeads({ taskIds: [taskId], cwd, runBd });
  const engagement = await m.lookupFleetBeadEngagement({ taskIds: [taskId], cwd, runBd });
  const bead = beads.ok ? beads.beads[0] : undefined;
  const entry = engagement.ok ? engagement.entries.find((e) => e.taskId === taskId) : undefined;
  return m.formatBeadOwnership({
    cwdTaskId: taskId,
    ...(bead === undefined ? {} : { bead }),
    ...(entry === undefined ? {} : { engagement: entry.engagement }),
  });
};

for (const id of ["bd-891", "bd-iwd", "bd-xa6"]) {
  console.log(`───── belayd_status ownership section for ${id}`);
  console.log(await section(id));
  console.log();
}
console.log("───── bd unreadable (spawn bd ENOENT)");
console.log(m.formatBeadOwnership({ cwdTaskId: "bd-891", error: "spawn bd ENOENT" }));
console.log();
console.log("───── no task id recorded");
console.log(m.formatBeadOwnership({ cwdTaskId: "" }));
```

```bash
cd "$T" && node /tmp/bd153-status.mjs
```

Real output:

```text
───── belayd_status ownership section for bd-891
**Bead bd-891**
- title: Ownership probe: labelled human, assigned, answered
- status: open
- owner: t@example.com
- assignee: Hugo Lewenhaupt
- human: yes
- bead updated: 2026-10-27T08:50:26Z
- comment count: 2
- awaiting human: no
- newest comment: hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
**Needs you** — bd-891 is waiting on a human.

───── belayd_status ownership section for bd-iwd
**Bead bd-iwd**
- title: Ownership probe: open human gate, unassigned
- status: open
- owner: t@example.com
- assignee: (unassigned)
- human: no
- bead updated: 2026-10-27T08:50:25Z
- comment count: 0
- awaiting human: yes
- newest comment: (none)
**Needs you** — bd-iwd is waiting on a human.

───── belayd_status ownership section for bd-xa6
**Bead bd-xa6**
- title: Ownership probe: plain, empty thread
- status: open
- owner: t@example.com
- assignee: belayd:bd-xa6:implement
- human: no
- bead updated: 2026-10-27T08:50:26Z
- comment count: 0
- awaiting human: no
- newest comment: (none)

───── bd unreadable (spawn bd ENOENT)
bead detail unavailable (bd read failed): spawn bd ENOENT

───── no task id recorded
undefined
```

A session recording no task id prints **no** new section at all (the tool result
is byte-identical to pre-bd-153), and a bd that cannot be read prints one bounded
line instead of throwing — `belayd_status` is the surface you still have while
you are blocked.

### 8. Tests that pin each rule

| Test (`src/__tests__/…`) | Proves |
| --- | --- |
| `fleet-bead-engagement` › `spawns nothing when there is no task id` | empty member set ⇒ zero `bd` calls |
| `fleet-bead-engagement` › `runs exactly one comments read and one gate list per bead, read-only` | exactly two read-only calls per bead, no writes |
| `fleet-bead-engagement` › `bounds the number of beads read at once and keeps input order` | `ENGAGEMENT_CONCURRENCY` cap, deterministic order |
| `fleet-bead-engagement` › `bounds a seam that never settles instead of hanging the fleet view` | watchdog fires, no timer leak |
| `fleet-bead-engagement` › `lets a slow read succeed instead of firing the watchdog` | a slow-but-settling read is not killed |
| `fleet-bead-engagement` › `treats a malformed gate record as unknown, never as resolved` | fail-closed gate tri-state |
| `fleet-bead-engagement` › `degrades one bead's failed reads without failing the others` / `contains one bead's failed reads without failing the fleet view or warning` | per-bead isolation, zero warnings on a mixed result |
| `fleet-bead-engagement` › `degrades a fleet-wide bd outage to exactly one warning` | `bead-engagement-unavailable` appears once |
| `fleet-bead-engagement` › `renders (unknown), never (none), when the comments read failed` | `(none)` needs a successful read |
| `fleet-bead-engagement` › `renders (none) only when the read succeeded and the thread is empty` | the positive case |
| `fleet-bead-engagement` › `renders (unknown), never (none), when bd returned records that all failed to parse` | schema drift is `unknown` |
| `fleet-bead-engagement` › `still shows the newest usable comment from a partially malformed thread` | partial malformation keeps the usable record |
| `fleet-bead-engagement` › `strips control characters out of comment fields before rendering` / `replaces embedded quotes so the one-line quoting still holds` | terminal safety of the one-line excerpt |
| `fleet-bead-engagement` › `renders an astral-only comment without a lone surrogate` | code-point excerpt cap (no `\ud83d` mojibake) |
| `fleet-bead-engagement` › `breaks equal timestamps by comment id, deterministically` | newest-comment tie-break |
| `fleet-status` › `parses ownership fields and degrades each one independently` | each new field is `.catch(undefined)` |
| `fleet-status` › `keeps id, title and labels when all four ownership fields are malformed` | partial schema tolerance, no fabricated columns |
| `fleet-status` › `parses a real bd 1.3.0 \`bd show --json\` payload` | fixture `fixtures/bd-show-real.json` captured verbatim |
| `fleet-status` › `flags the bd human label` | `human: yes` from the label |
| `fleet-status` › `attaches engagement by task id, case-insensitively, and leaves a missing member unknown` | `applyFleetBeadEngagement` contract |
| `fleet-status` › `degrades engagement to exactly one fleet-level warning` / `bounds a runaway engagement read error into one line` | one warning, one bounded line |
| `fleet-status` › `renders owner, assignee and the human flag under the bead line` | the member columns |
| `fleet-status` › `says (unknown) for an unreported owner and (unassigned) for a missing assignee` | the two absences are distinct |
| `fleet-status` › `renders an unread comment column as unknown, never none` / `renders (none) only when the comment read succeeded and the thread is empty` | the tri-state comment column |
| `fleet-status` › `caps the per-member newest-comment excerpt` / `caps a multi-byte excerpt by code point, not by byte length` | `NEEDS_YOU_EXCERPT_MAX_CHARS = 120`, counted in code points |
| `fleet-status` › `renders byte-identically across calls and member orderings, with no relative age` | determinism, bd's timestamp verbatim |
| `fleet-status` › `names every waiting bead together, with assignee and newest comment` | the `Needs you` block |
| `fleet-status` › `includes a bead with an open human gate even without the human label` | OR of label and gate |
| `fleet-status` › `says (unknown) for the assignee when the bead record failed to read` | `(unknown)` ≠ `(unassigned)` |
| `fleet-status` › `caps the needs-you list and names the remainder` | `NEEDS_YOU_LIST_MAX = 10` ⇒ `…and N more` |
| `fleet-status` › `orders the listed beads by task id` | deterministic order |
| `fleet-status` › `renders unknown for an unrecognized gate and never says no` | fail-closed on the `belayd_status` surface |
| `fleet-status` › `keeps the bead columns when only the engagement read failed` | partial reads are not thrown away |
| `extension-fleet-status-tool` › `belayd_fleet_status writes nothing and issues only read subcommands` / `belayd_status reads only show/comments/gate list and writes nothing` | exact argv set, no marker/fleet file, both tools |
| `extension-fleet-status-tool` › `emits exactly one engagement warning for a fleet-wide bd outage` | one warning end to end, no invented member lines |
| `extension-fleet-status-tool` › `degrades one bead's failed reads and emits no warning for the rest` | mixed outcome end to end |
| `extension-fleet-status-tool` › `belayd_status keeps its existing sections when bd is absent` | ENOENT ⇒ one bounded line, tool still exits 0 |
| `extension-fleet-status-tool` › `belayd_status renders (unknown), never (none), when only the comments read failed` | `awaiting human: no` + `newest comment: (unknown)` coexist |
| `extension-fleet-status-tool` › `renders ownership, the human wait, the newest comment and the Needs you block` | the whole surface end to end |

Spot-run the fail-closed group:

```bash
pnpm vitest run src/__tests__/fleet-bead-engagement.test.ts -t "fail-closed"
```

```text
 ✓ src/__tests__/fleet-bead-engagement.test.ts (22 tests | 11 skipped) 12ms
 Test Files  1 passed (1)
      Tests  11 passed | 11 skipped (22)
```

### 9. Cleanup

```bash
rm -rf /tmp/bd153-verify /tmp/bd153-bin /tmp/bd153-partial /tmp/bd153-broken \
       /tmp/bd153-render.mjs /tmp/bd153-malformed.mjs /tmp/bd153-status.mjs \
       /tmp/bd153-unknown-assignee.mjs /tmp/bd153-argv.log /tmp/bd153-*.sha
```

## How to Use

### `belayd_fleet_status`, field by field

Two excerpts of the step 3 rendering (the `Needs you` block, then one member
block):

```text
Needs you (2): bd-891, bd-iwd
  - bd-891 (assignee Hugo Lewenhaupt) — hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
  - bd-iwd (assignee (unassigned), awaiting human) — (no comments yet)

Member bd-iwd — active
  worktree: /tmp/bd153-verify/wt-b (branch bd-153/bd-iwd)
  bead: Ownership probe: open human gate, unassigned (open)
  owner: t@example.com
  assignee: (unassigned)
  human: no
  bead updated: 2026-10-27T08:50:25Z
  comment count: 0
  awaiting human: yes
  newest comment: (none)
  workflow: feature 1/5 phases complete
  pending: plan, implement, review, test
```

| Line | Meaning |
| --- | --- |
| `Needs you (<n>): <ids>` | Members whose bead carries bd's `human` label **or** has a parsed open `human` gate. The list is bounded to 10 beads (`…and N more` before the member blocks) and ordered like the member blocks (by task id). Omitted entirely when nothing needs a person |
| `  - <id> (assignee <a>, awaiting human) — <comment>` | Who to chase, and what they said: assignee, `awaiting human` only for a bead with an open gate, then the newest comment excerpt (120 characters). `(unassigned)` when bd reported no assignee, `(unknown)` when the bead record itself could not be read, `(no comments yet)` / `(comments unknown)` when there is no usable newest comment |
| `owner:` | `owner` from `bd show --json` (usually an email). `(unknown)` when bd reported none or renamed the field — a bad field degrades only that column |
| `assignee:` | bd's assignee: a person, or `belayd:<task>:<phase>` while a phase agent holds the bead. `(unassigned)` only when bd reported none |
| `human: yes\|no` | The bead carries the `human` label. Independent of the gate column |
| `bead updated:` | `updated_at` exactly as bd printed it — not a relative age, so two calls are byte-identical. Omitted when bd did not report it |
| `comment count:` | `comment_count` from `bd show --json`. Printed only when bd reported it (never a fabricated `0`) |
| `awaiting human: yes\|no\|unknown` | **`yes`** an open bd `human` gate blocks the bead; **`no`** the gate read succeeded and reported none; **`unknown`** the read failed or a gate record did not parse. Malformed is always `unknown`, never `no` |
| `newest comment: <author> <ISO>: "<excerpt>"` | Newest parsable comment, flattened to one line, 120 characters max, control characters/ANSI stripped, embedded `"` turned into `'`. `(none)` = the read succeeded and the thread is empty; `(unknown)` = failed read, watchdog, or records none of which parsed |

The two column groups come from different reads, so they fail independently: the
`show` fields (`owner`/`assignee`/`human`/`bead updated`/`comment count`) can be
missing while `awaiting human:`/`newest comment:` still render, and vice versa.

### Reading `Needs you`, and what to do next

`Needs you` is the point of the change: it answers "which of my beads is waiting
on me" in one line, without opening a single bead.

```text
Needs you (2): bd-891, bd-iwd
  - bd-891 (assignee Hugo Lewenhaupt) — hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
  - bd-iwd (assignee (unassigned), awaiting human) — (no comments yet)
```

1. `awaiting human` in the entry (or an open gate in `bd gate list <id>`) means a
   bd-152 wait is armed: the member's session has *asked* and its phase tools are
   refused until an answer arrives.
2. Answer on the bead — `bd comment <id> --stdin` (or the comment thread in
   Scotty):

   ```bash
   bd comment bd-iwd --stdin        # paste, then Ctrl-D
   echo "option b" | bd comment bd-iwd --stdin
   ```

3. The member's own session polls the thread (30 s tick) and **resolves the gate
   itself** when it sees the non-`belayd:*` comment. `belayd_fleet_status` does
   not deliver anything and cannot clear the wait — it only reports it.
4. An entry **without** `awaiting human` is there because of the `human` label
   only (`bd-891` above): no armed wait, just a bead a person has to look at.
   Pick it up (`bd update <id> --claim`) or drop the label when it no longer
   applies (`bd label remove <id> human`).

### `belayd_status`: the same view for one bead

`belayd_status` describes **the bead this session's worktree drives** — one bead,
no fleet — and appends the section between process state and active runs:

```text
**Bead bd-iwd**
- title: Ownership probe: open human gate, unassigned
- status: open
- owner: t@example.com
- assignee: (unassigned)
- human: no
- bead updated: 2026-10-27T08:50:25Z
- comment count: 0
- awaiting human: yes
- newest comment: (none)
**Needs you** — bd-iwd is waiting on a human.
```

While a gate is open you see `awaiting human: yes` (or `unknown` if the read
failed), the `newest comment:` line with the pending question, and the
`**Needs you** — …` footer. That is deliberate: a blocked session must be able
to report *what* it is blocked on with the one status tool it still has.

Differences from the fleet view worth knowing: no `Needs you (<n>)` list (there
is only one bead), markdown bullets instead of indented columns, no fleet
header, no other member's data, and the read is scoped to the session's own
`cwd`.

### "Why does it say `unknown`?"

`unknown` is the fail-closed default for three different inputs:

| Situation | What you see |
| --- | --- |
| `bd` missing, timing out (15 s per read, plus a watchdog), or erroring | `awaiting human: unknown`, `newest comment: (unknown)` |
| bd's JSON drifted: a gate record without `await_type`/`status`, or comment records with no usable `id`/`text` | same, via `unrecognized` / `dropped > 0` |
| a partial outage affecting only this bead | same, for this bead only, siblings intact, **no warning** |

Treat `unknown` as "check bd" — never as "not waiting". The view can only say
`no` when bd explicitly answered "no gates", and `(none)` only when the comment
read actually succeeded.

```bash
bd gate list <id> --json          # the authority for awaiting human
bd comments <id> --json           # the authority for newest comment
```

### "Why `(unassigned)` vs `(unknown)`?"

`(unassigned)` means bd answered and the record has no `assignee` — a fact.
`(unknown)` means there is no bead record to read at all, so the view knows
nothing. Only a `Needs you` entry can print `(unknown)`, because a member can be
listed on its gate alone when its bead record did not come back. Real output,
from the step 3 script with one crafted read — `runBd` filters `bd-iwd`'s own
`show` record out of the batched payload (the comments/gate reads stay real):

```javascript
const runBd = async (argv, options = {}) => {
  const out = (await exec(REAL, [...argv], { cwd, env: { ...process.env, BEADS_ACTOR: "" } })).stdout;
  if (argv[0] !== "show") return { stdout: out };
  return { stdout: JSON.stringify(JSON.parse(out).filter((r) => r.id !== "bd-iwd")) };
};
```

```text
Needs you (2): bd-891, bd-iwd
  - bd-891 (assignee Hugo Lewenhaupt) — hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
  - bd-iwd (assignee (unknown), awaiting human) — (no comments yet)
```

### "Why is `Needs you` empty when Scotty shows a human bead?"

This view is **member-scoped**: it lists only beads that a worktree in *this
repository's fleet* holds (`<worktree>/.belayd/workflow.json` → `taskId`). Live
proof — a brand-new human-labelled bead that no worktree holds:

```bash
cd "$T" && export BEADS_ACTOR=
X=$(bd create "Not a fleet member: needs a person" -t task --json | jq -r .id)
bd label add "$X" human            # no worktree, no workflow.json for this bead
bd show "$X" --json | jq -r '.[0] | "\(.id)\thuman label: \((.labels//[])|index("human") != null)"'
node /tmp/bd153-render.mjs | sed -n '/states:/,+3p'
```

```text
bd-6gs	human label: true
  states: active=4 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0

Needs you (2): bd-891, bd-iwd
  - bd-891 (assignee Hugo Lewenhaupt) — hugo 2026-10-27T08:50:27Z: "Yes - keep the shim and drop strict mode."
```

The human-labelled `bd-6gs` is not named, because it is not a fleet member. For
the repository-wide picture use bd itself (`bd blocked`, `bd ready`,
`bd show <id>`); there is also no cross-repo aggregation — one fleet, one
repository's worktrees.

### "Does this ever write?"

No. Both tools issue only `bd show --json` (once, batched), `bd comments <id>
--json` and `bd gate list <id> --json`. No `bd comment`, `close`, `update`,
`label`, `gate create`/`resolve`, no `sync`; no `.belayd/` file is created or
modified (step 6 shows the before/after hash snapshot and the argv of one real
call, and `extension-fleet-status-tool` › `… writes nothing and issues only read
subcommands` pins it). If you want the wait *resolved*, answer the bead; the
member's session does the resolving.

### Limits

- **Display only.** No delivery, no claim, no close, no gate resolution. Nothing
  here changes a bead's lifecycle (`bd-150` owns the assignee lifecycle, `bd-152`
  the answer channel).
- **The excerpt is not the comment.** `newest comment:` is one collapsed,
  120-character, quoting-safe line for a status view; read the thread in bd or
  Scotty for the real text.
- **`Needs you` is bounded** (`NEEDS_YOU_LIST_MAX = 10`): beyond ten waiting
  beads the header still counts them all and the list ends with `…and N more`.
  Use bd if you need the full set.
- **A waiting bead can be missing from `Needs you`** when its gate read failed —
  it then shows `awaiting human: unknown` in its member block instead. `unknown`
  is never treated as a wait, so the list is not exhaustive during a bd outage.
  This errs toward silence rather than a false "you are needed".
- **No cross-repo aggregation**, and only worktrees with a readable
  `.belayd/workflow.json` are members at all: a bead with no worktree never
  appears.
- **No clock, no urgency sort.** `bead updated:` is bd's string verbatim and
  blocks are ordered by task id, so repeated calls are byte-identical.
- **Two bd calls per member** (`1 + 2N` per call, 4 beads at a time). On a very
  wide fleet the view is slower than the pre-bd-153 one; it is still read-only
  and still degrades per bead.
