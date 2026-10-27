import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDuckdbArgs,
  formatMetricsFailures,
  formatMetricsHeader,
  formatMetricsResults,
  formatMetricsTable,
  loadMetricsQueries,
  METRICS_EVENT_NAMES,
  METRICS_GLOB_TOKEN,
  type MetricsQuery,
  parseCsv,
  parseMetricsQueryFile,
  parseMetricsTable,
  renderMetricsSql,
  runMetricsQueries,
} from "../metrics-query.js";

function findDuckdb(): string | null {
  const onPath = spawnSync("sh", ["-c", "command -v duckdb"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout.trim();
  return onPath === "" ? null : onPath;
}

const DUCKDB_PATH = findDuckdb();

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-metrics-query-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal gate_result row; the query reads only these fields. */
function gateEvent(input: {
  task: string;
  phase: string;
  attempt: number;
  passed: boolean;
}): Record<string, unknown> {
  return {
    event: "gate_result",
    ts: 1,
    host: "h",
    runId: "r1",
    durationMs: 1,
    ...input,
  };
}

const query: MetricsQuery = {
  name: "q",
  description: "d",
  sql: `SELECT * FROM read_json_auto(${METRICS_GLOB_TOKEN})`,
};

describe("renderMetricsSql", () => {
  it("substitutes the glob as a quoted literal", () => {
    expect(renderMetricsSql(query, "/state/events-*.jsonl")).toBe(
      "SELECT * FROM read_json_auto('/state/events-*.jsonl')",
    );
  });

  it("escapes an apostrophe so a path cannot break out of the literal", () => {
    expect(renderMetricsSql(query, "/home/o'brien/events-*.jsonl")).toContain(
      "'/home/o''brien/events-*.jsonl'",
    );
  });
});

describe("buildDuckdbArgs", () => {
  it("asks for CSV so the output is parseable", () => {
    expect(buildDuckdbArgs({ sql: "SELECT 1" })).toEqual(["-csv", "-c", "SELECT 1"]);
  });
});

describe("parseCsv", () => {
  it("splits a plain table", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps embedded commas, quotes and newlines", () => {
    expect(parseCsv('"a,1","say ""hi""","line\nbreak"\n')).toEqual([
      ["a,1", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("keeps empty trailing fields", () => {
    expect(parseCsv("a,b,c\n1,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("parseMetricsTable", () => {
  it("uses the first row as the header and drops a blank tail", () => {
    expect(parseMetricsTable("phase,pct\nreview,0.0\n\n")).toEqual({
      columns: ["phase", "pct"],
      rows: [["review", "0.0"]],
    });
  });

  it("returns an empty table for empty output", () => {
    expect(parseMetricsTable("")).toEqual({ columns: [], rows: [] });
  });
});

describe("formatMetricsTable", () => {
  it("renders a markdown table with a description", () => {
    const text = formatMetricsTable({
      query,
      table: { columns: ["phase", "pct"], rows: [["review", "0.0"]] },
    });

    expect(text).toContain("### q");
    expect(text).toContain("| phase | pct |");
    expect(text).toContain("| review | 0.0 |");
  });

  it("says no rows rather than printing an empty header", () => {
    expect(formatMetricsTable({ query, table: { columns: [], rows: [] } })).toContain("_no rows_");
  });
});

describe("runMetricsQueries", () => {
  it("runs every query and keeps going after a failure", async () => {
    const seen: string[][] = [];
    const report = await runMetricsQueries({
      queries: [query, { ...query, name: "bad", sql: "SELECT BOOM;" }],
      glob: "/g/*.jsonl",
      run: async (args) => {
        seen.push(args);
        return args[2]?.includes("BOOM") === true
          ? { ok: false, error: "boom" }
          : { ok: true, stdout: "phase\nreview\n" };
      },
    });

    expect(seen).toHaveLength(2);
    expect(report.ok).toBe(false);
    expect(report.queriesRun).toBe(1);
    expect(report.failures).toEqual([{ query: "bad", error: "boom" }]);
    expect(report.markdown).toContain("### q");
  });

  it("is ok only when every requested query ran", async () => {
    const report = await runMetricsQueries({
      queries: [query, { ...query, name: "q2" }],
      glob: "/g/*.jsonl",
      run: async () => ({ ok: true, stdout: "phase,pct\nreview,0.0\n" }),
    });

    expect(report.ok).toBe(true);
    expect(report.queriesRun).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.markdown).toContain("| review | 0.0 |");
  });

  it("signals failure for a single named query, with the duckdb message", async () => {
    const binderError = 'Binder Error: Referenced column "attempt" not found in FROM clause!';
    const report = await runMetricsQueries({
      queries: [{ ...query, name: "first_pass_by_phase" }],
      glob: "/g/*.jsonl",
      run: async () => ({ ok: false, error: binderError }),
    });

    expect(report.ok).toBe(false);
    expect(report.queriesRun).toBe(0);
    expect(report.failures).toEqual([{ query: "first_pass_by_phase", error: binderError }]);
    expect(report.markdown).toContain("No metrics queries ran");
  });

  it("keeps the successful tables and names only the failing query", async () => {
    const report = await runMetricsQueries({
      queries: [query, { ...query, name: "rework_by_phase", sql: "SELECT BOOM;" }],
      glob: "/g/*.jsonl",
      run: async (args) =>
        args[2]?.includes("BOOM") === true
          ? { ok: false, error: "Parser Error: syntax error at or near BOOM" }
          : { ok: true, stdout: "phase,pct\nreview,0.0\n" },
    });

    expect(report.ok).toBe(false);
    expect(report.markdown).toContain("### q");
    expect(report.markdown).toContain("| review | 0.0 |");
    expect(report.failures.map((failure) => failure.query)).toEqual(["rework_by_phase"]);
    expect(report.failures[0]?.error).toContain("BOOM");
    // The header must not read like a successful 1-query run.
    expect(
      formatMetricsHeader({ dir: "/state/metrics", queriesRun: report.queriesRun, requested: 2 }),
    ).toBe("Metrics log: `/state/metrics` — 1 of 2 queries\n\n");
    // And it stays exactly as today when nothing failed.
    expect(formatMetricsHeader({ dir: "/state/metrics", queriesRun: 6, requested: 6 })).toBe(
      "Metrics log: `/state/metrics` — 6 queries\n\n",
    );
  });

  it("reports when nothing ran", async () => {
    const report = await runMetricsQueries({
      queries: [],
      glob: "/g/*.jsonl",
      run: async () => ({ ok: true, stdout: "" }),
    });

    expect(formatMetricsResults([])).toContain("No metrics queries ran");
    expect(report.markdown).toContain("No metrics queries ran");
  });
});

describe("formatMetricsFailures", () => {
  it("is empty when nothing failed", () => {
    expect(formatMetricsFailures({ failures: [], requested: 2 })).toBe("");
  });

  it("names every failing query with its message and the requested count", () => {
    const text = formatMetricsFailures({
      failures: [
        { query: "cost_by_phase", error: "Binder Error: boom" },
        { query: "review_findings", error: "Parser Error: bang" },
      ],
      requested: 6,
    });

    expect(text).toContain("**Failed queries** (2 of 6)");
    expect(text).toContain("- cost_by_phase: Binder Error: boom");
    expect(text).toContain("- review_findings: Parser Error: bang");
  });
});

describe("parseMetricsQueryFile", () => {
  it("names the query from the file and describes it from the comment", () => {
    const parsed = parseMetricsQueryFile({
      fileName: "first_pass_by_phase.sql",
      sql: "-- First pass.\n-- Second line.\nSELECT 1;\n",
    });

    expect(parsed).toHaveProperty("name", "first_pass_by_phase");
    expect(parsed.description).toBe("First pass. Second line.");
    expect(parsed.sql).toContain("SELECT 1");
  });

  it("falls back to a generated description", () => {
    expect(parseMetricsQueryFile({ fileName: "x.sql", sql: "SELECT 1;" }).description).toBe(
      "metrics query x",
    );
  });
});

describe("loadMetricsQueries", () => {
  it("loads every .sql file in name order", () => {
    const files: Record<string, string> = {
      "/q/b.sql": "-- b\nSELECT 2;",
      "/q/a.sql": "-- a\nSELECT 1;",
      "/q/notes.md": "ignored",
    };
    const loaded = loadMetricsQueries("/q", {
      readDir: () => Object.keys(files).map((path) => path.split("/").pop() ?? ""),
      readFile: (path) => files[path] ?? "",
    });

    expect(loaded.map((entry) => entry.name)).toEqual(["a", "b"]);
  });
});

describe("query catalogue invariants", () => {
  // Guards the real files, not a fixture: a query added without the glob token,
  // or filtering on an event name the harness never emits, fails here.
  const queries = loadMetricsQueries(new URL("../../metrics/queries/", import.meta.url).pathname, {
    readDir: (dir) => readdirSync(dir),
    readFile: (path) => readFileSync(path, "utf8"),
  });

  it("loads at least one query", () => {
    expect(queries.length).toBeGreaterThan(0);
  });

  it("every query reads the events glob", () => {
    for (const entry of queries) {
      expect(entry.sql, `${entry.name} has no ${METRICS_GLOB_TOKEN}`).toContain(METRICS_GLOB_TOKEN);
    }
  });

  it("every query only filters on emitted event names", () => {
    for (const entry of queries) {
      const referenced = [...entry.sql.matchAll(/event\s*=\s*'([a-z_]+)'/g)].map(
        (match) => match[1],
      );
      for (const name of referenced) {
        expect(
          METRICS_EVENT_NAMES as readonly string[],
          `${entry.name} filters on ${name}`,
        ).toContain(name);
      }
    }
  });

  it("every query has a description", () => {
    for (const entry of queries) {
      expect(entry.description.length, `${entry.name} has no description`).toBeGreaterThan(10);
    }
  });

  it("computes first pass from the attempt==1 verdict, collapsed per (task, phase)", () => {
    if (DUCKDB_PATH === null) {
      console.warn("Skipping first-pass query test: duckdb not on PATH (devShell provides it)");
      return;
    }
    const firstPass = queries.find((entry) => entry.name === "first_pass_by_phase");
    expect(firstPass).toBeDefined();
    if (firstPass === undefined) return;

    const dir = tempDir();
    const events = [
      // Retried: attempt 1 failed, attempt 2 passed → not a first pass.
      gateEvent({ task: "bd-a", phase: "implement", attempt: 1, passed: false }),
      gateEvent({ task: "bd-a", phase: "implement", attempt: 2, passed: true }),
      // Clean: passed on the first attempt.
      gateEvent({ task: "bd-b", phase: "review", attempt: 1, passed: true }),
    ];
    writeFileSync(
      join(dir, "events-2026-05.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const sql = renderMetricsSql(firstPass, join(dir, "events-*.jsonl"));
    const stdout = execFileSync(DUCKDB_PATH, buildDuckdbArgs({ sql }), { encoding: "utf8" });
    const table = parseMetricsTable(stdout);

    expect(table.columns).toEqual(["phase", "phase_runs", "first_pass", "first_pass_pct"]);
    const byPhase = new Map(table.rows.map((row) => [row[0], row]));
    // The retried (task, phase) counts once and its attempt 1 decides: 0%.
    expect(byPhase.get("implement")?.slice(1)).toEqual(["1", "0", "0.0"]);
    expect(byPhase.get("review")?.slice(1)).toEqual(["1", "1", "100.0"]);
  });

  it("returns zero rows on a backfill-only dir instead of a binder error", () => {
    if (DUCKDB_PATH === null) {
      console.warn("Skipping backfill-only query test: duckdb not on PATH (devShell provides it)");
      return;
    }
    const firstPass = queries.find((entry) => entry.name === "first_pass_by_phase");
    expect(firstPass).toBeDefined();
    if (firstPass === undefined) return;

    // Backfill writes run_start/run_end only: no `attempt` or `passed` column
    // exists in any file, which is what made read_json_auto fail to bind.
    const dir = tempDir();
    const events = [
      { event: "run_start", ts: 1, host: "h", task: "bd-a", phase: "implement", runId: "r1" },
      { event: "run_end", ts: 2, runId: "r1", status: "failed", exitCode: 1, cost: 0.1 },
    ];
    writeFileSync(
      join(dir, "events-backfill.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const sql = renderMetricsSql(firstPass, join(dir, "events-*.jsonl"));
    const outcome = spawnSync(DUCKDB_PATH, buildDuckdbArgs({ sql }), { encoding: "utf8" });

    expect(outcome.stderr).not.toContain("Binder Error");
    expect(outcome.status).toBe(0);
    expect(parseMetricsTable(outcome.stdout)).toEqual({
      columns: ["phase", "phase_runs", "first_pass", "first_pass_pct"],
      rows: [],
    });
  });
});
