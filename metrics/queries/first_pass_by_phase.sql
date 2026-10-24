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
  FROM read_json_auto(:metrics_glob:, union_by_name = true)
  WHERE event = 'gate_result'
  GROUP BY task, phase
)
GROUP BY phase
ORDER BY first_pass_pct ASC, phase;
