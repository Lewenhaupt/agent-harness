-- Tool calls per run, split by outcome. A phase with many calls and few delivered
-- runs is exploring instead of executing (see the review phase's 38-turn median).
SELECT
  phase,
  count(*) AS runs,
  round(avg(toolCalls), 1) AS avg_tool_calls,
  round(avg(toolCalls) FILTER (WHERE status = 'completed'), 1) AS avg_completed,
  round(avg(toolCalls) FILTER (WHERE status <> 'completed'), 1) AS avg_failed
FROM read_json_auto(:metrics_glob:, union_by_name = true)
WHERE event = 'run_end'
GROUP BY phase
ORDER BY avg_tool_calls DESC;
