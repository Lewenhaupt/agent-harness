-- How many runs a phase needed per task. >1 means either a gate retry or the
-- orchestrator re-ran the phase (review<->implement loop), which is the cheap
-- proxy available for history that predates gate events.
SELECT
  phase,
  count(*) AS runs,
  count(DISTINCT task) AS tasks,
  round(1.0 * count(*) / count(DISTINCT task), 2) AS runs_per_task
FROM read_json_auto(:metrics_glob:, union_by_name = true)
WHERE event = 'run_start'
GROUP BY phase
ORDER BY runs_per_task DESC, phase;
