-- Where the money goes, per phase and model. `cache_hit_pct` is the share of
-- input tokens served from the provider's prompt cache: a low value on a phase
-- that re-reads stable context is a caching bug, not a model problem.
SELECT
  phase,
  count(*) AS runs,
  round(sum(cost), 3) AS total_usd,
  round(avg(cost), 4) AS avg_usd,
  round(avg(wallMs) / 1000.0, 1) AS avg_seconds,
  round(100.0 * sum(tokensCacheRead) / nullif(sum(tokensIn) + sum(tokensCacheRead), 0), 1) AS cache_hit_pct
FROM (
  SELECT phase, cost, wallMs, tokensIn, tokensCacheRead
  FROM read_json_auto(:metrics_glob:, union_by_name = true)
  WHERE event = 'run_end'
)
GROUP BY phase
ORDER BY total_usd DESC;
