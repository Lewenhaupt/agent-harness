-- What reviews actually report. A phase that mostly returns zero findings is
-- either reviewing clean code or not looking hard enough; both are actionable.
SELECT
  count(*) AS reviews,
  sum(critical) AS critical,
  sum(warnings) AS warnings,
  sum(suggestions) AS suggestions,
  round(1.0 * count(*) FILTER (WHERE critical + warnings + suggestions = 0) / count(*), 2) AS empty_share
FROM read_json_auto(:metrics_glob:, union_by_name = true)
WHERE event = 'review_findings';
