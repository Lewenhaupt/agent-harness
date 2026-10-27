-- Did a phase's first gate attempt pass? The number that decides whether a phase
-- earns its keep. One row per (task, phase) is first collapsed so a retried phase
-- counts once.
SELECT
  phase,
  count(*) AS phase_runs,
  count(*) FILTER (WHERE first_passed) AS first_pass,
  round(100.0 * count(*) FILTER (WHERE first_passed) / count(*), 1) AS first_pass_pct
FROM (
  SELECT
    task,
    phase,
    bool_or(passed) FILTER (WHERE attempt = 1) AS first_passed
  FROM read_json(
    :metrics_glob:,
    columns = {
      event: 'VARCHAR',
      task: 'VARCHAR',
      phase: 'VARCHAR',
      attempt: 'BIGINT',
      passed: 'BOOLEAN'
    },
    format = 'newline_delimited',
    union_by_name = true
  )
  WHERE event = 'gate_result'
  GROUP BY task, phase
)
GROUP BY phase
ORDER BY first_pass_pct ASC, phase;

-- Columns are declared explicitly instead of inferred: a backfill-only host has no
-- live file to supply `attempt`/`passed`, and read_json_auto's union_by_name would
-- then fail to bind them. A declared column reads as NULL where a file omits the
-- key, so the gate_result filter yields zero rows instead of a binder error.
