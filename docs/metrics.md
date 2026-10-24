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
