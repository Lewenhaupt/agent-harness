-- Cost of a phase divided by the phases it actually advanced. This is the
-- "what did an accepted change cost" number a workflow decision should use.
WITH phase_cost AS (
  SELECT task, phase, sum(cost) AS cost
  FROM read_json_auto(:metrics_glob:, union_by_name = true)
  WHERE event = 'run_end'
  GROUP BY task, phase
),
advanced AS (
  SELECT task, phase, count(*) AS advanced_runs
  FROM read_json_auto(:metrics_glob:, union_by_name = true)
  WHERE event = 'phase_advance'
  GROUP BY task, phase
)
SELECT
  phase_cost.phase,
  round(sum(phase_cost.cost), 3) AS total_usd,
  sum(coalesce(advanced.advanced_runs, 0)) AS delivered,
  round(sum(phase_cost.cost) / nullif(sum(coalesce(advanced.advanced_runs, 0)), 0), 4) AS usd_per_delivered
FROM phase_cost
LEFT JOIN advanced USING (task, phase)
GROUP BY phase_cost.phase
ORDER BY total_usd DESC;
