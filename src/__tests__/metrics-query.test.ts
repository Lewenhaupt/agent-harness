import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildDuckdbArgs,
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
    expect(report.queriesRun).toBe(1);
    expect(report.failures).toEqual([{ query: "bad", error: "boom" }]);
    expect(report.markdown).toContain("### q");
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
});
