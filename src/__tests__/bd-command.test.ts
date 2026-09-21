import { describe, expect, it } from "vitest";
import {
  BD_ALLOWED_SUBCOMMANDS,
  bdCommandReadsStdin,
  parseBdCommand,
  validateBdCommand,
} from "../bd-command.js";

describe("parseBdCommand", () => {
  it("splits on whitespace without a shell", () => {
    expect(parseBdCommand("show bd-42")).toEqual({ ok: true, argv: ["show", "bd-42"] });
  });

  it("keeps quoted arguments as a single token", () => {
    expect(parseBdCommand('note bd-1 "line one"')).toEqual({
      ok: true,
      argv: ["note", "bd-1", "line one"],
    });
  });

  it("preserves real newlines inside double quotes", () => {
    expect(parseBdCommand('update bd-1 --description "line one\nline two"')).toEqual({
      ok: true,
      argv: ["update", "bd-1", "--description", "line one\nline two"],
    });
  });

  it("preserves markdown metacharacters verbatim", () => {
    const argv = parseBdCommand('note bd-1 "table | cell `code` <tag> $(sub)"');
    expect(argv).toEqual({
      ok: true,
      argv: ["note", "bd-1", "table | cell `code` <tag> $(sub)"],
    });
  });

  it("does not split on metacharacters (no shell chaining)", () => {
    expect(parseBdCommand("show bd-42; rm -rf /")).toEqual({
      ok: true,
      argv: ["show", "bd-42;", "rm", "-rf", "/"],
    });
    expect(parseBdCommand("show bd-42\nls")).toEqual({
      ok: true,
      argv: ["show", "bd-42", "ls"],
    });
  });

  it("honors single quotes and backslash escapes", () => {
    expect(parseBdCommand("note bd-1 'it is fine'")).toEqual({
      ok: true,
      argv: ["note", "bd-1", "it is fine"],
    });
    expect(parseBdCommand("note bd-1 it\\ is\\ fine")).toEqual({
      ok: true,
      argv: ["note", "bd-1", "it is fine"],
    });
    expect(parseBdCommand('note bd-1 "say \\"hi\\""')).toEqual({
      ok: true,
      argv: ["note", "bd-1", 'say "hi"'],
    });
  });

  it("keeps an empty quoted argument", () => {
    expect(parseBdCommand('note bd-1 ""')).toEqual({ ok: true, argv: ["note", "bd-1", ""] });
  });

  it("rejects an unterminated quote", () => {
    expect(parseBdCommand('note bd-1 "oops')).toHaveProperty("ok", false);
    expect(parseBdCommand("note bd-1 'oops")).toHaveProperty("ok", false);
  });
});

describe("validateBdCommand", () => {
  it("accepts read-only subcommands", () => {
    for (const subcommand of [
      "show",
      "list",
      "search",
      "query",
      "ready",
      "blocked",
      "prime",
      "memories",
    ]) {
      const result = validateBdCommand(subcommand);
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("subcommand", subcommand);
      expect(result).toHaveProperty("argv", [subcommand]);
    }
  });

  it("accepts task-management subcommands", () => {
    for (const subcommand of [
      "create",
      "update",
      "label",
      "tag",
      "note",
      "link",
      "dep",
      "remember",
    ]) {
      const result = validateBdCommand(`${subcommand} bd-42`);
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("subcommand", subcommand);
    }
  });

  it("accepts flags and quoted arguments", () => {
    const result = validateBdCommand('create --title="Fix login" --type=bug');
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("subcommand", "create");
    expect(result).toHaveProperty("argv", ["create", "--title=Fix login", "--type=bug"]);
  });

  it("accepts multiline quoted content", () => {
    const result = validateBdCommand('update bd-42 --description "## Findings\n- x"');
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("argv", ["update", "bd-42", "--description", "## Findings\n- x"]);
  });

  it("trims surrounding whitespace", () => {
    const result = validateBdCommand("  show bd-42  ");
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("subcommand", "show");
    expect(result).toHaveProperty("argv", ["show", "bd-42"]);
  });

  it("rejects an empty command", () => {
    const result = validateBdCommand("");
    expect(result).toHaveProperty("ok", false);
    expect(result).toHaveProperty("error", "Empty bd command.");
  });

  it("rejects a whitespace-only command", () => {
    expect(validateBdCommand("   ")).toHaveProperty("ok", false);
  });

  it("rejects NUL bytes", () => {
    expect(validateBdCommand("show bd-42\u0000")).toHaveProperty("ok", false);
  });

  it("rejects disallowed subcommands", () => {
    for (const subcommand of ["close", "delete", "edit", "sql", "admin", "purge", "prune"]) {
      const result = validateBdCommand(`${subcommand} bd-42`);
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error", expect.stringContaining(subcommand));
    }
  });

  it("rejects chaining attempts disguised as extra args", () => {
    // Without a shell these are inert, but the subcommand must still be safe.
    expect(validateBdCommand("close bd-42; rm -rf /")).toHaveProperty("ok", false);
  });

  it("exposes only safe subcommands in the allowlist", () => {
    for (const unsafe of ["close", "delete", "edit", "sql", "admin", "create-form"]) {
      expect(BD_ALLOWED_SUBCOMMANDS).not.toContain(unsafe);
    }
    expect(BD_ALLOWED_SUBCOMMANDS).toContain("create");
    expect(BD_ALLOWED_SUBCOMMANDS).toContain("show");
  });

  it("rejects --parent on any subcommand", () => {
    expect(validateBdCommand("create --parent bd-42 --title=x")).toHaveProperty("ok", false);
    expect(validateBdCommand("create --parent=bd-42 --title=x")).toHaveProperty("ok", false);
  });

  it("rejects parent-child link tokens on any subcommand", () => {
    expect(validateBdCommand("link bd-1 bd-2 --type parent-child")).toHaveProperty("ok", false);
    expect(validateBdCommand("link bd-1 bd-2 --type=parent-child")).toHaveProperty("ok", false);
  });

  it("rejects --status and --claim on create/update", () => {
    expect(validateBdCommand("update bd-42 --status in_progress")).toHaveProperty("ok", false);
    expect(validateBdCommand("update bd-42 --status=in_progress")).toHaveProperty("ok", false);
    expect(validateBdCommand("update bd-42 --claim")).toHaveProperty("ok", false);
    expect(validateBdCommand("create --title=x --status open")).toHaveProperty("ok", false);
  });

  it("does not treat --status inside quoted content as a guarded flag", () => {
    expect(
      validateBdCommand('update bd-42 --description "--status is fine to mention"'),
    ).toHaveProperty("ok", true);
    expect(validateBdCommand('update bd-42 --append-notes "--claim disabled"')).toHaveProperty(
      "ok",
      true,
    );
  });

  it("keeps --status allowed on read subcommands", () => {
    const result = validateBdCommand("list --status=open");
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("subcommand", "list");
  });

  it("keeps notes/description/design flags allowed on update", () => {
    expect(validateBdCommand("update bd-42 --append-notes x")).toHaveProperty("ok", true);
  });
});

describe("bdCommandReadsStdin", () => {
  it("detects --stdin", () => {
    expect(bdCommandReadsStdin(["note", "bd-1", "--stdin"])).toBe(true);
  });

  it("detects --file - and --body-file -", () => {
    expect(bdCommandReadsStdin(["note", "bd-1", "--file", "-"])).toBe(true);
    expect(bdCommandReadsStdin(["create", "--body-file", "-"])).toBe(true);
    expect(bdCommandReadsStdin(["note", "bd-1", "--file=-"])).toBe(true);
  });

  it("is false without a stdin-reading flag", () => {
    expect(bdCommandReadsStdin(["note", "bd-1", "text"])).toBe(false);
    expect(bdCommandReadsStdin(["note", "bd-1", "--file", "notes.txt"])).toBe(false);
  });
});
