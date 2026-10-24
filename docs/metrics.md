# Metrics log

The harness can price a phase; this log is what lets it say whether a phase
*worked*. One JSON object per line, appended by the phase lifecycle, read with
DuckDB.

## Why a file and not a database

- **Concurrency.** Fleet members and background phase runs write concurrently
  under one uid; DuckDB is a single-writer engine. Appending one line is
  permission-free and crash-safe.
- **No new dependency.** A Node DuckDB client is a native module that would move
  the flake's `fetchPnpmDeps` hash on every bump. `duckdb` is in `devShellTools`
  (and therefore in `pi-web-runtime-env`) as a *query* tool only.
- **Durability.** `.belayd/` is per-worktree and disappears when a worktree is
  merged; `.belayd/runs/*.json` is a resume mechanism, not a history.

## Location and controls

```
${XDG_STATE_HOME:-~/.local/state}/belayd/metrics/events-YYYY-MM.jsonl
```

| Env var | Effect |
|---|---|
| `BELAYD_METRICS_DIR` | override the directory (tests, alternate reporting) |
| `BELAYD_METRICS=0` | disable the log entirely (`false`/`off` also work) |

Monthly rotation keeps a single file from growing without bound. A write failure
is reported once per process and never fails the phase.

## Events

| Event | Emitted when | Key fields |
|---|---|---|
| `run_start` | a phase run spawns | `task, phase, runId, workflowType, model, session` |
| `gate_result` | each gate evaluation, including retries | `task, phase, attempt, passed, durationMs, failureKind` |
| `run_end` | a run settles and delivers | `runId, status, exitCode, toolCalls, cost, tokens{In,Out,CacheRead}, wallMs` |
| `phase_advance` | a gate-owned run completes its phase | `task, phase, nextPhase` |
| `review_findings` | a successful review delivery | `critical, warnings, suggestions` |

Every event also carries `ts` (epoch ms) and `host`.

## First-pass rate

The metric this log exists for: for each `(task, phase)`, did `gate_result` with
`attempt = 1` pass? That is the number that decides whether a phase earns its
keep (`userguide`, `proof`, `plan`), and it composes with `run_end.cost` for cost
per accepted phase and with `attempt > 1` for retry rate.

```sql
-- first-pass rate per phase, per workflow type
SELECT phase,
       count(*)                                          AS runs,
       count(*) FILTER (WHERE first_passed)               AS first_pass,
       round(100.0 * count(*) FILTER (WHERE first_passed) / count(*), 1) AS pct
FROM (
  SELECT task, phase, workflow_type,
         bool_or(passed) FILTER (WHERE attempt = 1) AS first_passed
  FROM read_json_auto('$STATE/belayd/metrics/events-*.jsonl')
  WHERE event = 'gate_result'
  GROUP BY task, phase, workflow_type
)
GROUP BY phase
ORDER BY pct;
```

## Status

Phase 1 (this page) is the event log plus the DuckDB binary. Phase 2 adds the
versioned queries and a `belayd_metrics` tool; phase 3 backfills the existing
session corpus into the same file. See bd-140.

## Backfill (recorded sessions)

The live log starts empty. `scripts/belayd-metrics-backfill.ts` reconstructs
history from `~/.pi/agent/sessions/**/*.jsonl`:

```bash
node scripts/belayd-metrics-backfill.ts --dry-run   # counts only
node scripts/belayd-metrics-backfill.ts             # rewrites events-backfill.jsonl
```

It writes **one** file, `events-backfill.jsonl`, and rewrites it wholesale on
every run, so re-running is idempotent. Live events keep their monthly files; the
query glob picks up both.

| Recoverable | Not recoverable |
|---|---|
| `run_start`, `run_end` (model, cost, tokens, tool calls, wall time) | `gate_result` — a transcript records the agent's work, never the gate that judged it |
| run counts per (task, phase) — the `rework_by_phase` proxy | `phase_advance`, `review_findings` |

Two rules keep the history honest:

- A `-fallback-N` session is the **same run** on another provider (quota/rate-limit
  failover), so it does not add a run. `-retry-N` and `-run-N` are distinct spawns
  and do. Getting this wrong made implement read 6.1 runs/task instead of 2.2.
- Backfilled events carry `"source": "backfill"`, so a query can separate
  reconstructed history from live events (which also have real workflow types).

## Test isolation

The extension tests drive the real extension code, so the metrics append would
otherwise write fixture events into the operator's state directory (2940 of them,
observed). `vitest.config.ts` and `vitest.integration.config.ts` load
`src/__tests__/setup-env.ts`, which sets `BELAYD_METRICS=0`; a test that asserts on
metrics sets its own `BELAYD_METRICS_DIR`.
