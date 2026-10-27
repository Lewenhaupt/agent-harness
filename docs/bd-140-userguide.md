# Metrics event log, versioned queries and `belayd_metrics` (bd-140)

bd-140 turned the metrics log from a design note into a working subsystem: the five
event builders plus the best-effort appender in `src/metrics.ts`, `gate_result.runId`
(the field that ties a verdict to the spawn it judged), six git-tracked SQL files in
`metrics/queries/`, the read-only `belayd_metrics` tool (`extensions/index.ts`) that
runs them through DuckDB and renders markdown, and the session-corpus backfill
(`scripts/belayd-metrics-backfill.ts`).

Why a file, where it lives, what each event carries, the first-pass definition and
the backfill rules are owned by `docs/metrics.md`; this page is the operator
walkthrough. Run everything from the repository root inside the devShell
(`nix develop`), which provides `duckdb`, `jq` and `node`.

## How to Verify

### 1. Events are appended, and a gate retry writes attempt 1 then attempt 2

Fastest path — the wiring test drives the real extension factory, spawns a mocked
phase, fails the gate once and asserts the resulting log:

```bash
pnpm vitest run src/__tests__/extension-metrics.test.ts --reporter=verbose
```

Expected:

```text
 ✓ src/__tests__/extension-metrics.test.ts (2 tests)
   ✓ extension metrics wiring > appends run_start, both gate attempts and run_end, with attempt 2 on the retry
   ✓ extension metrics wiring > writes nothing when BELAYD_METRICS=0
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

To see it against a live phase, point the log at a temp directory in the shell that
starts the session, then run one phase:

```bash
export BELAYD_METRICS_DIR=$(mktemp -d)
./bin/pi
# in the session: /belayd bd-XX documentation --no-worktree
# then let it reach the implement phase (or call belayd_implement yourself)
```

The file is `events-<UTC year>-<UTC month>.jsonl` (`metricsFilePath`), one JSON
object per line. Field sets come from the interfaces in `src/metrics.ts`; a phase
with one gate retry produces exactly these lines (values illustrative, `ts`/`host`/
`runId` differ per run):

```json
{"event":"run_start","ts":1793110585882,"host":"desktop","task":"bd-a","phase":"implement","runId":"r1","workflowType":"documentation","model":"opencode-go/deepseek-v4.1-flash","session":"belayd-bd-a-sub-implement-r1"}
{"event":"gate_result","ts":1793110585890,"host":"desktop","task":"bd-a","phase":"implement","runId":"r1","attempt":1,"passed":false,"durationMs":5606,"failureKind":"tests"}
{"event":"gate_result","ts":1793110585900,"host":"desktop","task":"bd-a","phase":"implement","runId":"r1","attempt":2,"passed":true,"durationMs":4100}
{"event":"run_end","ts":1793110586000,"host":"desktop","task":"bd-a","phase":"implement","runId":"r1","status":"completed","exitCode":0,"toolCalls":3,"cost":0.25,"tokensIn":100,"tokensOut":50,"tokensCacheRead":900,"wallMs":1000,"model":"m"}
{"event":"phase_advance","ts":1793110586000,"host":"desktop","task":"bd-a","phase":"implement","nextPhase":"review"}
{"event":"review_findings","ts":1793110586000,"host":"desktop","task":"bd-a","critical":0,"warnings":1,"suggestions":2}
```

Checks that make it a verification and not a screenshot:

```bash
jq -c 'select(.event=="gate_result") | {runId, attempt, passed}' "$BELAYD_METRICS_DIR"/events-*.jsonl
# {"runId":"r1","attempt":1,"passed":false}
# {"runId":"r1","attempt":2,"passed":true}
jq -r '.runId' "$BELAYD_METRICS_DIR"/events-*.jsonl | sort | uniq -c
#       2 null      <- phase_advance and review_findings carry no runId
#       4 r1        <- run_start, both gate_results and run_end share one runId
```

`phase_advance` and `review_findings` carry no `runId`, and `run_start` carries no
`attempt` — the attempt counter belongs to `gate_result`. On a host whose log
predates this change, older `gate_result` rows have no `runId` at all; the temp-dir
run above is what proves the current code adds it.

### 2. Render the queries

There are six queries, named after their files in `metrics/queries/`:
`cost_by_phase`, `cost_per_delivered_phase`, `first_pass_by_phase`,
`review_findings`, `rework_by_phase`, `tool_calls_by_phase`. Each file starts with a
`--` comment block that becomes the table description, and uses the placeholder
`:metrics_glob:` where the events glob goes.

Seed a directory with the lines from step 1, then invoke the tool with no model in
the loop (same headless-driver pattern as `docs/belayd-outline.md`):

```bash
export BELAYD_REPO=$(pwd)
export DEMO=$(mktemp -d)
cat > "$DEMO/events-2026-10.jsonl" <<'EOF'
{"event":"run_start","ts":1793110585882,"host":"h","task":"bd-a","phase":"implement","runId":"r1","workflowType":"documentation","model":"m"}
{"event":"gate_result","ts":1793110585890,"host":"h","task":"bd-a","phase":"implement","runId":"r1","attempt":1,"passed":false,"durationMs":10,"failureKind":"tests"}
{"event":"gate_result","ts":1793110585900,"host":"h","task":"bd-a","phase":"implement","runId":"r1","attempt":2,"passed":true,"durationMs":10}
{"event":"run_end","ts":1793110586000,"host":"h","task":"bd-a","phase":"implement","runId":"r1","status":"completed","exitCode":0,"toolCalls":3,"cost":0.25,"tokensIn":100,"tokensOut":50,"tokensCacheRead":900,"wallMs":1000,"model":"m"}
{"event":"phase_advance","ts":1793110586000,"host":"h","task":"bd-a","phase":"implement","nextPhase":"review"}
{"event":"review_findings","ts":1793110586000,"host":"h","task":"bd-a","critical":0,"warnings":1,"suggestions":2}
EOF

cat > /tmp/belayd-metrics-tool.ts <<'TS'
interface ToolResult { content: Array<{ text: string }>; details: { exitCode: number } }
interface Tool { execute: (...args: unknown[]) => Promise<ToolResult> }
const repo = process.env.BELAYD_REPO ?? process.cwd();
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };
const tools = new Map<string, Tool>();
mod.default({
  registerTool: (def: Tool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {}, on: () => {}, sendMessage: () => {},
  getActiveTools: () => [], setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
});
const tool = tools.get("belayd_metrics");
if (tool === undefined) throw new Error("belayd_metrics was not registered");
const result = await tool.execute("doc", JSON.parse(process.argv[2] ?? "{}"), undefined, undefined, { cwd: repo });
console.log(result.content.map((part) => part.text).join("\n"));
console.error(`[exitCode=${result.details.exitCode}]`);
process.exit(result.details.exitCode ?? 0);
TS

BELAYD_METRICS_DIR=$DEMO node_modules/.bin/jiti /tmp/belayd-metrics-tool.ts '{"query":"first_pass_by_phase"}'
```

Expected (stderr banner first, then the report; exit 0). An unknown name exits 1
with `Unknown query '<name>'. Available: cost_by_phase, cost_per_delivered_phase,
first_pass_by_phase, review_findings, rework_by_phase, tool_calls_by_phase`; an
empty directory exits 0 with `No metrics events yet in <dir>`:

```text
Metrics log: `/tmp/tmp.XXXX` — 1 query

### first_pass_by_phase

Did a phase's first gate attempt pass? The number that decides whether a phase earns its keep. One row per (task, phase) is first collapsed so a retried phase counts once.

| phase | phase_runs | first_pass | first_pass_pct |
| --- | --- | --- | --- |
| implement | 1 | 0 | 0.0 |
```

Pass `{}` to run all six; each section has the same shape — `### <query name>`, the
description line from the SQL file's comment block, then a markdown table whose
columns are whatever the SQL selects. Failing queries are listed under
`**Failed queries**` and do not lose the others.

Without the tool, the same query is one `duckdb` call — note `union_by_name = true`,
which the tool gets from the query files and you must supply yourself, because
monthly files and the backfill file do not all carry every optional column:

```bash
duckdb -c "SELECT phase, count(*) AS phase_runs, count(*) FILTER (WHERE first_passed) AS first_pass, round(100.0 * count(*) FILTER (WHERE first_passed) / count(*), 1) AS first_pass_pct FROM (SELECT task, phase, bool_or(passed) FILTER (WHERE attempt = 1) AS first_passed FROM read_json_auto('$DEMO/events-*.jsonl', union_by_name = true) WHERE event = 'gate_result' GROUP BY task, phase) GROUP BY phase ORDER BY first_pass_pct ASC, phase;"
```

Or run a query file verbatim by substituting the placeholder — this proves the file
you are reading is the SQL that runs:

```bash
sed "s|:metrics_glob:|'$DEMO/events-*.jsonl'|g" metrics/queries/cost_per_delivered_phase.sql | duckdb
```

Both `duckdb` forms print DuckDB's box table on stdout with the same values the tool
puts in markdown — here `cost_per_delivered_phase` for the fixture:

```text
│   phase   │ total_usd │ delivered │ usd_per_delivered │
│ implement │      0.25 │         1 │              0.25 │
```

### 3. Kill switch

`BELAYD_METRICS=0` (also `false` / `off`, case-insensitive) makes
`resolveMetricsDir` return `undefined` and `appendMetricsEvent` return a disabled
result instead of writing:

```bash
pnpm build   # the check below imports dist/src/metrics.js
BELAYD_METRICS=0 node --input-type=module -e '
const m = await import("./dist/src/metrics.js");
console.log("dir:", m.resolveMetricsDir({ env: process.env }));
console.log(JSON.stringify(m.appendMetricsEvent({
  env: process.env,
  event: m.buildPhaseAdvanceEvent({ now: Date.now(), host: "h", task: "bd-x", phase: "scout", nextPhase: "plan" }),
})));'
```

Expected:

```text
dir: undefined
{"ok":false,"error":"metrics disabled","disabled":true}
```

No directory is created and no line is written, and the phase itself still runs
(`recordMetric` swallows the result; a real write error is warned once per process).
The second test in `src/__tests__/extension-metrics.test.ts` asserts exactly this
(`readdirSync(metricsDir)` stays `[]`).

Control, so the assertion is not vacuous:

```bash
D=$(mktemp -d); BELAYD_METRICS_DIR=$D node --input-type=module -e '
const m = await import("./dist/src/metrics.js");
console.log(JSON.stringify(m.appendMetricsEvent({
  env: process.env,
  event: m.buildRunStartEvent({ now: Date.now(), host: "h", task: "bd-x", phase: "scout", runId: "r1", workflowType: "feature", model: "m" }),
})));'
# {"ok":true,"path":"/tmp/tmp.XXXX/events-YYYY-MM.jsonl"}
```

### 4. First-pass numbers are sane, and backfill does not feed them

`first_pass_by_phase.sql` collapses per `(task, phase)` with
`bool_or(passed) FILTER (WHERE attempt = 1)`: a pair whose attempt 1 failed counts
as one run with `first_pass = 0`, no matter how many retries later passed, so
`phase_runs` counts phase-runs rather than gate rows. Check one known-retried task
against the live log:

```bash
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/belayd/metrics
duckdb -c "SELECT task, phase, list(attempt ORDER BY attempt) AS attempts, bool_or(passed) FILTER (WHERE attempt = 1) AS first_passed FROM read_json_auto('$STATE/events-*.jsonl', union_by_name = true) WHERE event = 'gate_result' GROUP BY task, phase HAVING sum(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) > 0 ORDER BY task, phase LIMIT 10;"
```

Observed here (2026-10 corpus): `bd-150 proof` has attempts `[1, 2, 3]` and
`first_passed = false`, `bd-150 implement` has attempts `[1, 1, 1, 1, 1, 2]` and
`first_passed = true`. Your ids will differ; what matters is that a pair with a
failed attempt 1 reads `false` and that a retried pair appears once in
`first_pass_by_phase`'s `phase_runs`.

Backfilled history cannot move those numbers, because a transcript never recorded
the gate that judged it:

```bash
grep -c '"event":"gate_result"' "$STATE"/events-backfill.jsonl   # 0
```

So `first_pass_by_phase` covers live runs only, while `cost_by_phase`,
`rework_by_phase` and `tool_calls_by_phase` read both files through the
`events-*.jsonl` glob — and `cost_per_delivered_phase` shows `NULL` for a phase with
cost but no `phase_advance` rows (observed `plan` on a backfill-heavy corpus).

### 5. The two touched test files

```bash
pnpm vitest run src/__tests__/extension-metrics.test.ts src/__tests__/metrics-query.test.ts
```

Expected `Test Files 2 passed (2)` / `Tests 22 passed (22)` (2 wiring tests, 20 query
tests). `src/__tests__/setup-env.ts` pins `BELAYD_METRICS=0` for the whole suite, so
neither file writes into `~/.local/state/belayd/metrics`; the wiring test opts back
in against its own `mkdtemp` directory. The first-pass test in
`metrics-query.test.ts` executes the real `first_pass_by_phase.sql` through `duckdb`
and prints `Skipping first-pass query test: duckdb not on PATH` instead of failing
when the binary is missing — a silent skip is a skipped assertion, so run it inside
the devShell.

## How to Use

### Where the log lives and what controls it

```text
${XDG_STATE_HOME:-~/.local/state}/belayd/metrics/events-YYYY-MM.jsonl
```

| Control | Effect |
|---|---|
| `BELAYD_METRICS_DIR` | override the directory (tests, alternate reporting) |
| `BELAYD_METRICS=0` | disable the log entirely (`false` / `off` also work) |

Monthly files rotate on their own — the month in the name comes from
`new Date(now)` in UTC (`metricsFilePath`), so nothing needs a cron.

It is **host-level, not per-worktree**, on purpose: `.belayd/` is gitignored and a
worktree is merged and deleted, so a log kept inside one dies with it. Fleet members
and background phase runs also write concurrently under one uid, which is why the
record is an append (`appendFileSync`) rather than a DuckDB table — DuckDB is a
single-writer engine and is used here as a query tool only.

### Asking a question of the log

The loop is always: **pick a query → `belayd_metrics` → read the table.** In a pi
session ask the agent to call the tool with a query name (the extension registers
`belayd_metrics` with one optional string parameter, `query`); headless, use the
driver in step 2. Omit `query` to render all six.

| Question | Query |
|---|---|
| Did a phase pass its gate on the first attempt? | `first_pass_by_phase` |
| What did an *accepted* change cost? | `cost_per_delivered_phase` |
| Where does the money go, and is prompt caching working? | `cost_by_phase` (`cache_hit_pct`) |
| Is a phase being re-run, or retried at the gate? | `rework_by_phase` (`runs_per_task`) |
| Is a phase exploring instead of executing? | `tool_calls_by_phase` (`avg_tool_calls`, `avg_completed`) |
| Are reviews finding anything? | `review_findings` (`empty_share`) |

`rework_by_phase` counts `run_start` rows, so it works on backfilled history too —
that is the proxy for rework that predates `gate_result`. `first_pass_by_phase` is
the only direct answer and needs live gate rows.

### Adding a new query

1. Author `metrics/queries/<name>.sql`. The file name (minus `.sql`) **is** the
   tool's `query` parameter, so kebab-case it like the rest.
2. Start the file with a `--` comment block: `parseMetricsQueryFile` turns it into
   the one-line description shown above the table, and the catalogue invariant test
   fails a query with no description.
3. Use `:metrics_glob:` wherever the events glob belongs (`renderMetricsSql`
   substitutes and single-quote-escapes it). The invariant test fails a query
   without the token, and fails one that filters on an `event` value the harness
   never emits (`METRICS_EVENT_NAMES`).
4. Filter on `event = '<name>'` and add `union_by_name = true` to `read_json_auto`.

It is picked up with no registration: `loadMetricsQueries` scans
`metrics/queries/` next to the loaded extension on every tool call, sorted by file
name. In this repo that is the worktree directory, so a new file is live
immediately; a packaged install carries the directory only because the flake copies
`metrics/` into `$out` (`flake.nix`, "Metric queries live beside the extension"),
so a packaged install needs a rebuild before the new query exists there.

Queries are versioned — one file per question, reviewable and diffable in git when
the event schema moves — which is the reason the SQL is not embedded in
`src/metrics-query.ts`.

### Backfill (one-off, not routine)

```bash
node scripts/belayd-metrics-backfill.ts --dry-run    # counts only, writes nothing
node scripts/belayd-metrics-backfill.ts              # rewrite events-backfill.jsonl
node scripts/belayd-metrics-backfill.ts --limit 50   # first 50 session files
```

It reads `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`) and writes
**one** file, `events-backfill.jsonl`, rewriting it wholesale on every run — so
re-running is idempotent and a half-read corpus cannot leave duplicates. Backfilled
rows carry `"source":"backfill"` and `"workflowType":"unknown"`; they contain
`run_start` / `run_end` only, which is why first-pass stays a live-only metric.
`BELAYD_METRICS=0` makes the script exit 1 with `metrics disabled (BELAYD_METRICS=0)`
and `--dry-run` prints
`[dry-run] <n> events from <m> sessions (<k> skipped) -> <path>`.

Do **not** schedule it. It exists to reconstruct the pre-log past once (and to
re-check the corpus when the session parser changes); it rewrites the file from
whatever transcripts still exist, so a deleted session silently drops from the
history it already contributed to.

### Caveats worth knowing before quoting a number

- **Append-only.** Nothing rewrites a live event. A bad row is corrected by the code
  that emits it, not by an edit; delete the file if you truly need a reset.
- **Monthly rotation.** Any question spanning months must union the files — the
  queries' `events-*.jsonl` glob already does; a hand-written `read_json_auto` on
  one `events-YYYY-MM.jsonl` answers for that month only.
- **Schema drift is tolerated, not fixed.** `union_by_name = true` plus DuckDB's
  NULL for an absent field lets one read span rows written by different versions
  (e.g. `gate_result` rows from before `runId` existed). Filter with
  `runId IS NOT NULL` before relying on it.
- **No harness dependency.** Events are plain JSON built from literals in
  `src/metrics.ts`; the file has no import of the extension, the agent registry or
  the workflow store, so it stays queryable after those are refactored or renamed.
  Renaming a field, however, splits every query silently — change the SQL and the
  docs in the same commit.
