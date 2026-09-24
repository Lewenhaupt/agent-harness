import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location (src/__tests__ -> repo root)
// rather than process.cwd(), so the test is invariant to the Vitest working directory.
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const panelPath = join(repoRoot, "pi-web-plugins", "proof-of-work", "panel.js");
const readmePath = join(repoRoot, "pi-web-plugins", "proof-of-work", "README.md");

// Read once; a missing file surfaces a clear failure rather than a silent skip,
// because these hints are the artifact the regression guard exists to protect.
function readSource(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const panelSource = readSource(panelPath);
const readmeSource = readSource(readmePath);

/** Narrow a nullable source read, failing loudly instead of skipping assertions. */
function requireSource(source: string | null, path: string): string {
  if (source === null) {
    throw new Error(`could not read ${path}`);
  }
  return source;
}

describe("bd-69: proof panel trace-viewer fallback hint", () => {
  it("panel.js and README are readable from the test file location", () => {
    expect(requireSource(panelSource, panelPath).length).toBeGreaterThan(0);
    expect(requireSource(readmeSource, readmePath).length).toBeGreaterThan(0);
  });

  it("panel.js no longer tells users to run `npx playwright`", () => {
    const source = requireSource(panelSource, panelPath);
    // `npx` fetches a playwright whose expected browser revisions drift from
    // PLAYWRIGHT_BROWSERS_PATH, causing the viewer to half-load on NixOS (bd-64 class).
    expect(source).not.toContain("npx playwright");
  });

  it("openTrace fallback names the host `playwright show-trace` binary", () => {
    const source = requireSource(panelSource, panelPath);
    // Match the whole error-state string literal, not just the first line that
    // mentions it, so a future reword that wraps the message still asserts and a
    // duplicated copy elsewhere cannot satisfy the wrong occurrence.
    const match = source.match(/"[^"]*does not expose the terminal helper[^"]*"/);
    if (match === null) {
      throw new Error("openTrace terminal-helper fallback string not found");
    }
    expect(match[0]).toContain("playwright show-trace");
  });

  it("openTrace fallback documents the project devShell escape hatch", () => {
    const source = requireSource(panelSource, panelPath);
    const match = source.match(/"[^"]*does not expose the terminal helper[^"]*"/);
    if (match === null) {
      throw new Error("openTrace terminal-helper fallback string not found");
    }
    // Either escape hatch is acceptable; both are documented in README/docs.
    const fallback = match[0];
    expect(fallback.includes("direnv exec") || fallback.includes("nix develop")).toBe(true);
  });

  it("showTraceCommand not-found error keeps bd-64's sentence and adds the devShell hint", () => {
    const source = requireSource(panelSource, panelPath);
    // Span the whole not-found branch so the appended hint is asserted as a unit.
    const match = source.match(/if \[ -z "\$PW" \][\s\S]*?exit 1; fi/);
    if (match === null) {
      throw new Error("showTraceCommand not-found branch not found");
    }
    const block = match[0];
    // bd-64's wording must survive verbatim as a fragment...
    expect(block).toContain("playwright CLI not found on PATH");
    expect(block).toContain("PLAYWRIGHT_BROWSERS_PATH");
    // ...and the escape hatch is appended to the same message.
    expect(block.includes("direnv exec") || block.includes("nix develop")).toBe(true);
    expect(block).toContain("playwright show-trace");
    // The hint must quote the trace argument so paths with spaces survive a
    // copy-paste (bd-69's core bug class); the printf format supplies the quotes.
    expect(block).toContain('--port %s "%s"');
  });

  it("showTraceCommand invocation quotes the port and trace arguments", () => {
    const source = requireSource(panelSource, panelPath);
    // Guards shellQuote/quoting behaviour: bare `$TRACE` inside the double-quoted
    // echo would word-split on spaces, so the real invocation must keep quoting.
    expect(source).toContain('"$PW" show-trace --port "$PORT" "$TRACE"');
  });

  it("README trace-viewer row documents the manual `playwright show-trace` fallback", () => {
    const source = requireSource(readmeSource, readmePath);
    const match = source.match(/^\| `\.trace\.zip`.*$/m);
    if (match === null) {
      throw new Error("README trace-viewer row not found");
    }
    const traceRow = match[0];
    expect(traceRow).toContain("playwright show-trace");
    expect(traceRow.includes("direnv exec") || traceRow.includes("nix develop")).toBe(true);
  });

  // Executable guard for bd-69's word-splitting bug class. The source-text
  // guards above prove the *text* quotes the trace arg, but they cannot prove
  // the quoting actually survives shell expansion. Pre-fix, the branch used an
  // unquoted `echo ... $TRACE ...` that word-split on spaces; this test runs the
  // real branch text through bash with a space-containing trace path and asserts
  // the emitted message keeps it as one argument.
  it("showTraceCommand not-found branch keeps a spaced trace path as one argument (executable)", () => {
    const source = requireSource(panelSource, panelPath);
    // Extract the verbatim not-found branch line. Fail loudly if it is missing —
    // never silently skip, since this is the line under test.
    const lineMatch = source.match(/^.*if \[ -z "\$PW" \][^\n]*exit 1; fi.*$/m);
    if (lineMatch === null) {
      throw new Error("showTraceCommand not-found branch line not found in panel.js");
    }
    // The branch is a JS template-literal element inside an array literal, so
    // the captured text carries leading indentation and surrounding backticks /
    // a trailing comma. Strip those JS delimiters so what we hand bash is the
    // real shell text — the branch itself is otherwise unmodified.
    const branchLine = lineMatch[0].replace(/^\s*`/, "").replace(/`,?$/, "");

    // A structural guard: the printf format must consume exactly 4 `%s`
    // conversions and be fed exactly 4 quoted arguments. A future edit that
    // unbalances either side silently changes the emitted message.
    const percentConversions = branchLine.match(/%s/g);
    const quotedArgs = branchLine.match(/"\$PORT"|"\$TRACE"/g);
    if (percentConversions === null || quotedArgs === null) {
      throw new Error("printf %s conversions or quoted args not found in branch");
    }
    expect(percentConversions.length).toBe(4);
    expect(quotedArgs.length).toBe(4);

    // Run the branch verbatim through real bash with PW unset/empty, a fixed
    // PORT, and a TRACE containing a space. The branch ends with `exit 1`, so
    // prepend a function override (`exit() { return 0; }`) that neutralises it
    // and the subprocess exits 0 with stdout captured normally. A trailing
    // `true` is a second neutraliser in case a future edit drops the `exit`
    // override scope. The branch text itself is NOT rewritten.
    const port = "9323";
    const tracePath = "/tmp/my proof dir/trace.zip";
    const script = `exit() { return 0; }\n${branchLine}\ntrue`;

    // Guard against a missing bash: fail with a clear message rather than skip.
    let bashBin: string;
    try {
      execFileSync("bash", ["--version"], { stdio: "pipe", timeout: 5_000 });
      bashBin = "bash";
    } catch {
      throw new Error("bash not available on PATH; cannot run executable branch test");
    }

    let stdout: string;
    try {
      const buf = execFileSync(bashBin, ["-c", script], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PW: "", PORT: port, TRACE: tracePath },
        timeout: 10_000,
        encoding: "utf8",
      });
      stdout = buf;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`bash execution of not-found branch failed: ${message}`);
    }

    // The exact assertion that fails on the pre-fix `echo` version: the spaced
    // path must appear as one correctly quoted argument, not word-split.
    expect(stdout).toContain(`--port ${port} "${tracePath}"`);
    expect(stdout).not.toContain(`--port ${port} ${tracePath}`);

    // Message content is still asserted by the executable path, not only the
    // source-text guards.
    expect(stdout).toContain("playwright CLI not found on PATH");
    expect(stdout.includes("direnv exec") || stdout.includes("nix develop")).toBe(true);
  });
});
