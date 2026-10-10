import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Plain-JS vitest coverage for the proof-of-work panel helpers.
 *
 * panel.js defines a custom element that extends HTMLElement at module scope,
 * so Node needs the browser globals referenced during module evaluation.
 * `HTMLElement` is read while the class body is created; `customElements` is
 * stubbed too so defineProofPanelElement() stays callable from future tests.
 * window/document are only touched inside methods, never at import time.
 */
vi.stubGlobal("HTMLElement", class {});
let capturedPanelClass;
vi.stubGlobal("customElements", {
  get: () => undefined,
  define: (_name, constructor) => {
    capturedPanelClass = constructor;
  },
});

const { showTraceCommand, defineProofPanelElement } = await import("./panel.js");
// Capture the panel constructor via the stubbed registry so prototype methods
// (launchTraceViewer) can be exercised without constructing real shadow DOM.
defineProofPanelElement();

afterAll(() => {
  // Drop the stubbed module from the registry so other test files re-evaluate
  // panel.js with their own globals instead of inheriting the cached class.
  vi.resetModules();
  vi.unstubAllGlobals();
});

/** Validate a shell command's syntax by piping it to `bash -n` on stdin. */
function bashSyntaxError(command) {
  const result = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  if (result.error) return String(result.error);
  return result.status === 0 ? undefined : (result.stderr ?? "").trim();
}

/** `bash -n` is a dev-host dependency; skip the syntax checks where it is absent. */
const bashAvailable = spawnSync("bash", ["--version"], { encoding: "utf8" }).error === undefined;

describe("showTraceCommand", () => {
  const tracePath = "/abs/proof-of-work/bd-63/trace.zip";

  it("reclaims the viewer-owned pidfile before launching a new server", () => {
    const command = showTraceCommand({ port: 9323, host: "0.0.0.0", tracePath });

    // A viewer-owned pidfile (under $XDG_RUNTIME_DIR, falling back to
    // $HOME/.cache/belayd) is the only thing the command may kill: it must
    // verify the recorded PID is alive AND is a show-trace process first, so a
    // recycled PID can never take down an unrelated process.
    expect(command).toContain('PIDDIR="${XDG_RUNTIME_DIR:-$HOME/.cache/belayd}"');
    expect(command).toContain('PIDFILE="$PIDDIR/playwright-trace.pid"');
    expect(command).toContain('if [ -f "$PIDFILE" ]; then');
    expect(command).toContain('kill -0 "$OLD_PID"');
    expect(command).toContain("grep -q 'show-trace'");
    expect(command).toContain('kill "$OLD_PID"');
    // bd-108 W-2: the reclaimed viewer's direct children can briefly hold the
    // LISTEN socket after the parent dies, so they are signaled too (scoped
    // strictly to "$OLD_PID" descendants; unrelated PIDs are never touched).
    expect(command).toContain('pkill -P "$OLD_PID"');
    expect(command).toContain("could not stop the previous trace viewer");
    expect(command).toContain("not a playwright show-trace process");
    // The guard must require both `show-trace` and a playwright cmdline, so a
    // recycled/unrelated PID is never killed.
    expect(command).toContain("grep -Eq 'playwright(-core)?'");

    // The launched server runs in the background so its PID can be verified,
    // then the shell waits on it so the terminal stays attached to the viewer.
    expect(command).toContain('"$PW" show-trace --host "$HOST" --port "$PORT" "$TRACE" &');
    expect(command).toContain("VIEWER_PID=$!");
    expect(command).toContain('wait "$VIEWER_PID"');

    // Port ownership is verified before the pidfile is written: a pre-existing
    // :9323 owner (never in our pidfile) must abort our launch, not be killed.
    expect(command).toContain("command -v ss");
    expect(command).toContain("ss -ltnp");
    expect(command).toContain('pid=$VIEWER_PID,');
    expect(command).toContain('pgrep -P "$VIEWER_PID"');
    expect(command).toContain("cannot verify :$PORT ownership");
    expect(command).toContain("another process owns :$PORT");
    expect(command).toContain("port reclaim is disabled for this session");

    // N-2: the post-launch abort must escalate to SIGKILL for our own PID only.
    expect(command).toContain('kill -9 "$VIEWER_PID"');

    // Pre-launch foreign-owner abort: after our own viewer is reclaimed, any
    // LISTEN socket still on :$PORT belongs to an unknown owner. It must be
    // detected before the show-trace invocation so the shell fails fast and
    // never launches a viewer that would bind a random port.
    expect(command).toContain("another process already owns :$PORT");
    const foreignIndex = command.indexOf("another process already owns :$PORT");
    const launchIndex = command.indexOf('"$PW" show-trace --host "$HOST" --port "$PORT" "$TRACE" &');
    expect(foreignIndex).toBeGreaterThan(-1);
    expect(launchIndex).toBeGreaterThan(foreignIndex);

    // bd-108 W-2: the pre-launch foreign-owner abort must be gated behind a
    // bounded wait for our just-reclaimed viewer's socket to clear, so a
    // surviving own-child listener is a transient condition, not a false
    // positive that aborts a normal relaunch.
    expect(command).toContain('ss -ltn 2>/dev/null | grep -Eq');
    const portFreeWaitIndex = command.indexOf('ss -ltn 2>/dev/null | grep -Eq');
    expect(portFreeWaitIndex).toBeGreaterThan(-1);
    expect(portFreeWaitIndex).toBeLessThan(foreignIndex);

    // The pidfile write must come after the ownership gate and be tolerated if
    // it fails.
    const ownershipIndex = command.indexOf("another process owns :$PORT");
    const pidfileWriteIndex = command.indexOf('printf \'%s\\n\' "$VIEWER_PID" > "$PIDFILE"');
    expect(ownershipIndex).toBeGreaterThan(-1);
    expect(pidfileWriteIndex).toBeGreaterThan(ownershipIndex);
  });

  it("escapes the find parentheses so bash groups them", () => {
    const command = showTraceCommand({ port: 9323, host: "0.0.0.0", tracePath });

    // These assert the runtime string, not the source template literal: each
    // grouping paren find uses must carry one literal backslash. The pre-fix
    // template literal collapsed `\(` to `(`, so bash aborted before running.
    expect(command).toContain("find . \\(");
    expect(command).toContain("\\) -prune");
    expect(command).toContain("\\( -type f -o -type l \\)");
    expect(command).toContain('TRACE="/abs/proof-of-work/bd-63/trace.zip"');
    expect(command).toContain('PORT="9323"');
    expect(command).toContain('HOST="0.0.0.0"');
    expect(command).toContain('show-trace --host "$HOST" --port "$PORT"');
  });

  it.skipIf(!bashAvailable)("is valid bash syntax (bash -n)", () => {
    expect(bashSyntaxError(showTraceCommand({ port: 9323, host: "0.0.0.0", tracePath }))).toBeUndefined();
  });

  it.skipIf(!bashAvailable)("quotes the trace path so the shell cannot expand it", () => {
    const command = showTraceCommand({ port: 9323, host: "0.0.0.0", tracePath: "/a b/$(whoami)/x.zip" });

    expect(command).toContain('TRACE="/a b/\\$(whoami)/x.zip"');
    expect(command).not.toContain('TRACE="/a b/$(whoami)/x.zip"');
    expect(bashSyntaxError(command)).toBeUndefined();
  });

  it.skipIf(!bashAvailable)("quotes the host so metacharacters cannot expand", () => {
    const host = "$(whoami)`id`; echo pwned";
    const command = showTraceCommand({ port: 9323, host, tracePath });

    expect(command).toContain('HOST="\\$(whoami)\\`id\\`; echo pwned"');
    expect(command).not.toContain('HOST="$(whoami)`id`; echo pwned"');
    expect(bashSyntaxError(command)).toBeUndefined();

    // Execute just the assignment: if shellQuote leaked, the command
    // substitution / backticks would run and HOST would not round-trip.
    const hostLine = command.split("\n").find((line) => line.startsWith("HOST="));
    if (hostLine === undefined) throw new Error("HOST assignment not found in command");
    const result = spawnSync("bash", ["-c", `${hostLine}\nprintf '%s' "$HOST"`], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe(host);
  });

  it.skipIf(!bashAvailable)("refuses to kill a pidfile PID whose cmdline is not a show-trace process", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "bd-108-pidfile-"));
    // A live process whose /proc cmdline is not a playwright show-trace server.
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      if (victim.pid === undefined) throw new Error("could not spawn a victim process");
      writeFileSync(join(pidDir, "playwright-trace.pid"), `${victim.pid}\n`);

      const command = showTraceCommand({ port: 9323, host: "0.0.0.0", tracePath });
      const result = spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, XDG_RUNTIME_DIR: pidDir },
      });

      // The guard must abort before launching a second viewer.
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("not a playwright show-trace process");
      // The unrelated process must still be alive: it was never killed.
      expect(() => process.kill(victim.pid, 0)).not.toThrow();
    } finally {
      victim.kill("SIGKILL");
      rmSync(pidDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bashAvailable)("refuses to kill a PID whose cmdline has show-trace but no playwright", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "bd-108-pidfile-"));
    // A script whose path contains "show-trace" but whose cmdline has no
    // `playwright` token. The tightened guard (show-trace AND
    // playwright/playwright-core) must refuse it even though the old
    // permissive show-trace-only guard would have killed it.
    const scriptPath = join(pidDir, "show-trace");
    writeFileSync(scriptPath, "#!/usr/bin/env bash\nsleep 30\n");
    chmodSync(scriptPath, 0o755);
    const victim = spawn(scriptPath, [], { stdio: "ignore" });
    try {
      if (victim.pid === undefined) throw new Error("could not spawn a victim process");
      writeFileSync(join(pidDir, "playwright-trace.pid"), `${victim.pid}\n`);

      const command = showTraceCommand({ port: 9323, host: "0.0.0.0", tracePath });
      const result = spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, XDG_RUNTIME_DIR: pidDir },
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("not a playwright show-trace process");
      expect(() => process.kill(victim.pid, 0)).not.toThrow();
    } finally {
      victim.kill("SIGKILL");
      rmSync(pidDir, { recursive: true, force: true });
    }
  });
});

describe("launchTraceViewer navigation gating", () => {
  const params = {
    filePath: "proof-of-work/bd-108/trace.zip",
    absolutePath: "/abs/base/bd-108/trace.zip",
    viewerUrl: "https://playwright-trace.example/",
  };

  /** Build a terminal context whose completed run resolves with `completed`. */
  function makeContext(completed) {
    return {
      files: {
        listFiles: async (path) => ({
          path,
          entries: [{ name: "trace.zip", path: `${path}/trace.zip`, type: "file" }],
        }),
      },
      terminal: {
        runCommand: async () => ({ run: { id: "run-1" }, completed: Promise.resolve(completed) }),
      },
    };
  }

  function makeWindowRef(writes = []) {
    return {
      closed: false,
      location: { href: "" },
      close() {
        this.closed = true;
      },
      document: { write: (html) => writes.push(html) },
    };
  }

  function makeInstance() {
    const instance = Object.create(capturedPanelClass.prototype);
    instance.viewer = { innerHTML: "" };
    // A stale viewer may already answer the trace URL; the gating must not
    // depend on the URL being down.
    instance.waitForServer = async () => true;
    return instance;
  }

  it("does not navigate and renders the error when the run reports failed", async () => {
    const instance = makeInstance();
    const windowRef = makeWindowRef();

    await instance.launchTraceViewer(makeContext({ status: "failed", exitCode: 1 }), windowRef, params);

    expect(windowRef.location.href).toBe("");
    expect(windowRef.closed).toBe(true);
    expect(instance.viewer.innerHTML).toContain("Could not start the Trace Viewer.");
    expect(instance.viewer.innerHTML).toContain("Another process");
  });

  it("navigates the pending tab when the run succeeds", async () => {
    const instance = makeInstance();
    const windowRef = makeWindowRef();

    await instance.launchTraceViewer(makeContext({ status: "succeeded", exitCode: 0 }), windowRef, params);

    expect(windowRef.location.href).toBe(params.viewerUrl);
    expect(windowRef.closed).toBe(false);
  });

  it("keeps the did-not-start path and never navigates when no server answers", async () => {
    const instance = makeInstance();
    instance.waitForServer = async () => false;
    const writes = [];
    const windowRef = makeWindowRef(writes);

    await instance.launchTraceViewer(makeContext({ status: "running" }), windowRef, params);

    expect(windowRef.location.href).toBe("");
    expect(writes.join("")).toContain("did not start in time");
  });

  it("navigates when the completed promise rejects (treated as not failed)", async () => {
    const instance = makeInstance();
    const windowRef = makeWindowRef();
    const context = makeContext({ status: "succeeded" });
    const completed = Promise.reject(new Error("no handle"));
    // Pre-attach a handler so the intentionally rejected promise is not an
    // unhandled rejection before the SUT attaches its own guard.
    completed.catch(() => {});
    context.terminal.runCommand = async () => ({ run: { id: "run-1" }, completed });

    await instance.launchTraceViewer(context, windowRef, params);

    expect(windowRef.location.href).toBe(params.viewerUrl);
  });
});
