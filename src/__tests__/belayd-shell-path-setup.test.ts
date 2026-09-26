import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRenderedScripts,
  createShellHarness,
  renderScript,
  runScript,
  type ShellHarness,
} from "./helpers/belayd-script-harness.js";

describe("belayd-shell-path-setup (unit)", () => {
  let harness: ShellHarness;
  let setup: string;
  let settings: string;
  const target = "/nix/store/example-belayd-shell/bin/belayd-shell";

  beforeEach(() => {
    harness = createShellHarness();
    setup = renderScript("belayd-shell-path-setup", {
      realShell: harness.realShell,
      jqPath: harness.jqPath,
    }).path;
    settings = join(harness.root, "agent", "settings.json");
  });

  afterEach(() => {
    harness.cleanup();
    cleanupRenderedScripts();
  });

  const run = (args: string[]) => runScript(setup, args, { cwd: harness.root, env: harness.env });

  it("creates the file with 0600 when missing", () => {
    const result = run(["--settings", settings, "--shell", target]);

    expect(result).toHaveProperty("status", 0);
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ shellPath: target });
    expect(statSync(settings).mode & 0o777).toBe(0o600);
  });

  it("merges shellPath without clobbering other keys", () => {
    mkdirSync(join(harness.root, "agent"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ defaultModel: "x", shellPath: "old" }));

    const result = run(["--settings", settings, "--shell", target]);

    expect(result).toHaveProperty("status", 0);
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({
      defaultModel: "x",
      shellPath: target,
    });
  });

  it("is idempotent and does not rewrite when already set", () => {
    mkdirSync(join(harness.root, "agent"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ shellPath: target }));
    const before = statSync(settings, { bigint: true }).mtimeNs;

    const result = run(["--settings", settings, "--shell", target]);

    expect(result).toHaveProperty("status", 0);
    expect(statSync(settings, { bigint: true }).mtimeNs).toBe(before);
  });

  it("preserves the existing file mode", () => {
    mkdirSync(join(harness.root, "agent"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ shellPath: "old" }));
    chmodSync(settings, 0o640);

    run(["--settings", settings, "--shell", target]);

    expect(statSync(settings).mode & 0o777).toBe(0o640);
  });

  it("exits 1 in strict mode on corrupt JSON and leaves the file untouched", () => {
    const corrupt = "{ not json";
    mkdirSync(join(harness.root, "agent"), { recursive: true });
    writeFileSync(settings, corrupt);

    const result = run(["--settings", settings, "--shell", target, "--strict"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    expect(readFileSync(settings, "utf-8")).toBe(corrupt);
  });

  it("warns and exits 0 in non-strict mode on corrupt JSON", () => {
    const corrupt = "{ not json";
    mkdirSync(join(harness.root, "agent"), { recursive: true });
    writeFileSync(settings, corrupt);

    const result = run(["--settings", settings, "--shell", target]);

    expect(result).toHaveProperty("status", 0);
    expect(result.stderr).toContain("not valid JSON");
    expect(readFileSync(settings, "utf-8")).toBe(corrupt);
  });

  it("writes through a symlinked settings.json and preserves the target mode (W3)", () => {
    const dir = join(harness.root, "agent");
    mkdirSync(dir, { recursive: true });
    const linkTarget = join(dir, "target.json");
    writeFileSync(linkTarget, JSON.stringify({ defaultModel: "x", shellPath: "old" }));
    chmodSync(linkTarget, 0o640);
    symlinkSync("target.json", settings);

    const result = run(["--settings", settings, "--shell", target]);

    expect(result).toHaveProperty("status", 0);
    // The symlink survives; only the resolved target is rewritten.
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(linkTarget, "utf-8"))).toEqual({
      defaultModel: "x",
      shellPath: target,
    });
    expect(statSync(linkTarget).mode & 0o777).toBe(0o640);
  });

  it("warns and exits 0 (non-strict) when the temp file cannot be created (W2)", () => {
    const dir = join(harness.root, "agent");
    const roTmp = join(harness.root, "ro-tmp");
    mkdirSync(dir, { recursive: true });
    mkdirSync(roTmp, { recursive: true });
    chmodSync(dir, 0o555);
    chmodSync(roTmp, 0o555);
    try {
      const env = { ...harness.env, TMPDIR: roTmp };
      const result = runScript(
        setup,
        ["--settings", join(dir, "settings.json"), "--shell", target],
        { cwd: harness.root, env },
      );

      expect(result).toHaveProperty("status", 0);
      expect(result.stderr).toContain("temp file");
    } finally {
      chmodSync(dir, 0o755);
      chmodSync(roTmp, 0o755);
    }
  });

  it("fails loudly (exit 1) in strict mode when the temp file cannot be created (W2)", () => {
    const dir = join(harness.root, "agent");
    const roTmp = join(harness.root, "ro-tmp");
    mkdirSync(dir, { recursive: true });
    mkdirSync(roTmp, { recursive: true });
    chmodSync(dir, 0o555);
    chmodSync(roTmp, 0o555);
    try {
      const env = { ...harness.env, TMPDIR: roTmp };
      const result = runScript(
        setup,
        ["--settings", join(dir, "settings.json"), "--shell", target, "--strict"],
        { cwd: harness.root, env },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("temp file");
    } finally {
      chmodSync(dir, 0o755);
      chmodSync(roTmp, 0o755);
    }
  });
});
