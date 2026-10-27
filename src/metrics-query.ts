/**
 * Query layer for the metrics log (bd-140, phase 2).
 *
 * The SQL lives in `metrics/queries/*.sql` so a query is reviewable in git and
 * diffable when the event schema changes. This module owns the parts that are
 * easy to get wrong and worth testing without a DuckDB binary: the catalogue,
 * the CLI argv, the CSV parse, and the markdown rendering.
 */

import { join } from "node:path";

import type { MetricsEvent } from "./metrics.js";

/** Placeholder a query uses where the events glob belongs. */
export const METRICS_GLOB_TOKEN = ":metrics_glob:";

/** One named query from the catalogue. */
export interface MetricsQuery {
  /** Stable name used as the tool parameter, e.g. `first_pass_by_phase`. */
  name: string;
  /** One-line description shown to the model. */
  description: string;
  /** SQL with {@link METRICS_GLOB_TOKEN} where the glob goes. */
  sql: string;
}

/** A parsed result table. */
export interface MetricsTable {
  columns: string[];
  rows: string[][];
}

/** Everything the formatter needs for one query run. */
export interface MetricsQueryResult {
  query: MetricsQuery;
  table: MetricsTable;
  /** Wall time of the DuckDB invocation, when measured. */
  durationMs?: number;
}

/** One query that failed, named so a caller can say exactly which ones broke. */
export interface MetricsQueryFailure {
  query: string;
  error: string;
}

/**
 * Replace the glob token with a quoted SQL string literal.
 *
 * Single quotes are doubled per SQL string-literal rules, so a path containing an
 * apostrophe (a user name, a directory) cannot break out of the literal.
 */
export function renderMetricsSql(query: MetricsQuery, glob: string): string {
  return query.sql.split(METRICS_GLOB_TOKEN).join(`'${glob.replaceAll("'", "''")}'`);
}

/** DuckDB argv for one query. `-csv` keeps the output parseable. */
export function buildDuckdbArgs(options: { sql: string }): string[] {
  return ["-csv", "-c", options.sql];
}

/**
 * Parse DuckDB's `-csv` output.
 *
 * Handles quoted fields with embedded commas, quotes, and newlines. Unlike a
 * naive `split(",")`, a query returning a path or a message column stays intact.
 */
export function parseCsv(text: string): string[][] {
  const input = text.endsWith("\n") ? text.slice(0, -1) : text;
  let state: CsvState = { rows: [], row: [], field: "", quoted: false };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const step = state.quoted
      ? consumeQuoted(state, char, input[index + 1])
      : consumePlain(state, char);
    state = step.state;
    index += step.consumed;
  }
  state.row.push(state.field);
  state.rows.push(state.row);
  return state.rows;
}

/** Parser state, threaded through the two single-purpose step helpers. */
interface CsvState {
  rows: string[][];
  row: string[];
  field: string;
  quoted: boolean;
}

/** One character consumed, plus any extra characters a doubled quote covers. */
interface CsvStep {
  state: CsvState;
  consumed: number;
}

function consumeQuoted(state: CsvState, char: string, next: string | undefined): CsvStep {
  if (char !== '"') return { state: { ...state, field: state.field + char }, consumed: 0 };
  if (next === '"') return { state: { ...state, field: `${state.field}"` }, consumed: 1 };
  return { state: { ...state, quoted: false }, consumed: 0 };
}

function consumePlain(state: CsvState, char: string): CsvStep {
  if (char === '"') return { state: { ...state, quoted: true }, consumed: 0 };
  if (char === ",") {
    return { state: { ...state, row: [...state.row, state.field], field: "" }, consumed: 0 };
  }
  if (char === "\n") {
    return {
      state: { ...state, rows: [...state.rows, [...state.row, state.field]], row: [], field: "" },
      consumed: 0,
    };
  }
  return { state: { ...state, field: state.field + char }, consumed: 0 };
}

/** Turn DuckDB's CSV output into a header plus rows, dropping an empty tail row. */
export function parseMetricsTable(text: string): MetricsTable {
  const rows = parseCsv(text).filter(
    (row) => row.length > 1 || (row[0] !== undefined && row[0] !== ""),
  );
  const [header, ...body] = rows;
  if (header === undefined) return { columns: [], rows: [] };
  return { columns: header, rows: body };
}

/** Render one query result as a markdown table. Empty results say so. */
export function formatMetricsTable(result: MetricsQueryResult): string {
  const lines = [`### ${result.query.name}`, "", result.query.description, ""];
  const { columns, rows } = result.table;
  if (columns.length === 0) {
    lines.push("_no rows_");
    return lines.join("\n");
  }
  lines.push(`| ${columns.join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${columns.map((_, index) => row[index] ?? "").join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Render several query results. */
export function formatMetricsResults(results: readonly MetricsQueryResult[]): string {
  if (results.length === 0) return "No metrics queries ran.";
  return results.map(formatMetricsTable).join("\n\n");
}

/**
 * Render the report header.
 *
 * `queriesRun` is how many queries produced a table, so on a partial failure it
 * is smaller than what the caller asked for. The header has to say both numbers
 * or a failed run reads like a successful short one; when nothing failed it stays
 * the plain count so existing output does not churn.
 */
export function formatMetricsHeader(options: {
  dir: string;
  queriesRun: number;
  requested: number;
}): string {
  const succeeded = `${options.queriesRun} ${options.queriesRun === 1 ? "query" : "queries"}`;
  const count =
    options.queriesRun === options.requested
      ? succeeded
      : `${options.queriesRun} of ${options.requested} queries`;
  return `Metrics log: \`${options.dir}\` — ${count}\n\n`;
}

/**
 * Render the failures footnote, naming exactly which queries broke and why.
 *
 * Kept out of the tool so the report text is a pure function of the outcome, and
 * so a partial report never hides a failure behind a "successful" tool call.
 */
export function formatMetricsFailures(options: {
  failures: readonly MetricsQueryFailure[];
  requested: number;
}): string {
  if (options.failures.length === 0) return "";
  const items = options.failures.map((failure) => `- ${failure.query}: ${failure.error}`);
  return (
    `\n\n**Failed queries** (${options.failures.length} of ${options.requested})` +
    `\n${items.join("\n")}`
  );
}

/**
 * What the metrics tool returns to the model.
 *
 * `ok` is false when any requested query failed: a partial report is still
 * useful to read, but the outcome must not look successful to a caller (the tool
 * maps `ok` onto its exit code). The success branch carries an empty failure
 * list so `ok` and `failures` cannot disagree.
 */
export type MetricsReport =
  | { ok: true; markdown: string; queriesRun: number; failures: readonly [] }
  | { ok: false; markdown: string; queriesRun: number; failures: readonly MetricsQueryFailure[] };

/**
 * Run a set of queries through an injected DuckDB runner.
 *
 * The runner is injected so the orchestration (partial failures, aggregation) is
 * testable without a binary, and a single failing query does not lose the
 * others: it is reported alongside the results that worked.
 */
export async function runMetricsQueries(options: {
  queries: readonly MetricsQuery[];
  glob: string;
  run: (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
}): Promise<MetricsReport> {
  const results: MetricsQueryResult[] = [];
  const failures: MetricsQueryFailure[] = [];
  for (const query of options.queries) {
    const startedAt = Date.now();
    const outcome = await options.run(
      buildDuckdbArgs({ sql: renderMetricsSql(query, options.glob) }),
    );
    if (!outcome.ok) {
      failures.push({ query: query.name, error: outcome.error });
      continue;
    }
    results.push({
      query,
      table: parseMetricsTable(outcome.stdout),
      durationMs: Date.now() - startedAt,
    });
  }
  const markdown = formatMetricsResults(results);
  if (failures.length === 0) {
    return { ok: true, markdown, queriesRun: results.length, failures: [] };
  }
  return { ok: false, markdown, queriesRun: results.length, failures };
}

/** Event names a query may filter on; used to validate the catalogue in tests. */
export const METRICS_EVENT_NAMES = [
  "run_start",
  "gate_result",
  "run_end",
  "phase_advance",
  "review_findings",
] as const satisfies ReadonlyArray<MetricsEvent["event"]>;

/** Filesystem access for the catalogue, injected so loading is testable. */
export interface MetricsQueryIo {
  readDir: (dir: string) => string[];
  readFile: (path: string) => string;
}

/**
 * Parse one query file.
 *
 * The name comes from the file name (a stable tool parameter) and the
 * description from the leading `--` comment block, so a query and the sentence
 * explaining it cannot drift apart in two files.
 */
export function parseMetricsQueryFile(options: { fileName: string; sql: string }): MetricsQuery {
  const name = options.fileName.replace(/\.sql$/, "");
  const descriptionLines: string[] = [];
  for (const line of options.sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) {
      descriptionLines.push(trimmed.replace(/^--\s?/, ""));
      continue;
    }
    if (trimmed === "") continue;
    break;
  }
  const description = descriptionLines.join(" ").trim();
  return {
    name,
    description: description === "" ? `metrics query ${name}` : description,
    sql: options.sql,
  };
}

/** Load every `*.sql` file in a directory, sorted by name. */
export function loadMetricsQueries(dir: string, io: MetricsQueryIo): MetricsQuery[] {
  return io
    .readDir(dir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) =>
      parseMetricsQueryFile({
        fileName: entry,
        sql: io.readFile(join(dir, entry)),
      }),
    );
}
