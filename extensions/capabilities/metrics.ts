/**
 * Metrics capability: the read-only `belayd_metrics` query tool (bd-179).
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveMetricsDir } from "../../src/metrics.js";
import {
  formatMetricsFailures,
  formatMetricsHeader,
  loadMetricsQueries,
  type MetricsQuery,
  runMetricsQueries,
} from "../../src/metrics-query.js";
import { errorText, textToolResult } from "./context.js";

/**
 * Register `belayd_metrics`; the composer supplies the pi API.
 *
 * Read-only analytics over the append-only metrics log (bd-140). The SQL lives
 * in metrics/queries/*.sql so it is reviewable in git, and DuckDB answers with
 * CSV that this tool renders as markdown. Deliberately not in the gated tool
 * set: metrics is a post-hoc question, and the gated surface has a budget.
 */
export function registerMetrics(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "belayd_metrics",
    label: "Belayd Metrics",
    description:
      "Query the harness metrics log (gate first-pass per phase, cost per phase, rework rate, " +
      "tool calls, review findings) with DuckDB. Read-only; pass a query name, or omit it to run all.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Query name from metrics/queries (omit to run every query)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      const dir = resolveMetricsDir({ env: process.env });
      if (dir === undefined) {
        return textToolResult("Metrics log is disabled (BELAYD_METRICS=0). Nothing to query.", 1);
      }
      // DuckDB errors on a glob that matches nothing, so check first: an empty
      // log is a normal state (fresh host), not a failed query.
      const eventFiles = (() => {
        try {
          return readdirSync(dir).filter(
            (entry) => entry.startsWith("events-") && entry.endsWith(".jsonl"),
          );
        } catch {
          return [];
        }
      })();
      if (eventFiles.length === 0) {
        return textToolResult(
          `No metrics events yet in ${dir}. Run a phase (or its gate) and query again.`,
          0,
        );
      }
      const queryDir = fileURLToPath(new URL("../../metrics/queries/", import.meta.url));
      let queries: MetricsQuery[];
      try {
        queries = loadMetricsQueries(queryDir, {
          readDir: (target) => readdirSync(target),
          readFile: (target) => readFileSync(target, "utf8"),
        });
      } catch (error) {
        return textToolResult(
          `Metrics queries are not installed at ${queryDir} (${errorText(error)}). ` +
            "Rebuild the harness package, which installs metrics/.",
          1,
        );
      }
      const selected =
        params.query === undefined
          ? queries
          : queries.filter((candidate) => candidate.name === params.query);
      if (selected.length === 0) {
        const names = queries.map((entry) => entry.name).join(", ");
        return textToolResult(`Unknown query '${params.query}'. Available: ${names}`, 1);
      }
      const report = await runMetricsQueries({
        queries: selected,
        glob: join(dir, "events-*.jsonl"),
        run: (args) =>
          new Promise((resolve) => {
            execFile("duckdb", args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error === null) {
                resolve({ ok: true, stdout });
                return;
              }
              const detail = stderr.trim() === "" ? errorText(error) : stderr.trim();
              resolve({
                ok: false,
                error: detail.includes("ENOENT")
                  ? "duckdb not found on PATH (devShell and pi-web runtime env provide it)"
                  : detail,
              });
            });
          }),
      });
      const failures = formatMetricsFailures({
        failures: report.failures,
        requested: selected.length,
      });
      const header = formatMetricsHeader({
        dir,
        queriesRun: report.queriesRun,
        requested: selected.length,
      });
      // A partial report is readable, but the outcome must not look successful:
      // a script or downstream consumer has to be able to detect that a query
      // failed, so the non-zero exit code carries the failure.
      return textToolResult(`${header}${report.markdown}${failures}`, report.ok ? 0 : 1);
    },
  });
}
