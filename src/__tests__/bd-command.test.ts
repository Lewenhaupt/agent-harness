import { describe, expect, it } from "vitest";
import { BD_ALLOWED_SUBCOMMANDS, validateBdCommand } from "../bd-command.js";

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
      expect(validateBdCommand(subcommand)).toEqual({ ok: true, subcommand });
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
      expect(validateBdCommand(`${subcommand} bd-42`)).toEqual({ ok: true, subcommand });
    }
  });

  it("accepts flags and quoted arguments", () => {
    const result = validateBdCommand('create --title="Fix login" --type=bug');
    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("subcommand", "create");
  });

  it("trims surrounding whitespace", () => {
    const result = validateBdCommand("  show bd-42  ");
    expect(result).toEqual({ ok: true, subcommand: "show" });
  });

  it("rejects an empty command", () => {
    const result = validateBdCommand("");
    expect(result).toHaveProperty("ok", false);
    expect(result).toHaveProperty("error");
  });

  it("rejects a whitespace-only command", () => {
    const result = validateBdCommand("   ");
    expect(result).toHaveProperty("ok", false);
  });

  it("rejects disallowed subcommands", () => {
    for (const subcommand of ["close", "delete", "edit", "sql", "admin", "purge", "prune"]) {
      const result = validateBdCommand(`${subcommand} bd-42`);
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error", expect.stringContaining(subcommand));
    }
  });

  it("rejects shell command chaining", () => {
    for (const command of [
      "show bd-42; rm -rf /",
      "show bd-42 && echo hi",
      "show bd-42 | cat",
      "show bd-42 &",
      "show bd-42\nls",
    ]) {
      expect(validateBdCommand(command)).toHaveProperty("ok", false);
    }
  });

  it("rejects redirection and substitution", () => {
    for (const command of [
      "show bd-42 > /tmp/out",
      "show bd-42 < /etc/passwd",
      "show bd-42 `id`",
      "show bd-42 $(id)",
      "show bd-42 $" + "{HOME}",
    ]) {
      expect(validateBdCommand(command)).toHaveProperty("ok", false);
    }
  });

  it("exposes only safe subcommands in the allowlist", () => {
    for (const unsafe of ["close", "delete", "edit", "sql", "admin", "create-form"]) {
      expect(BD_ALLOWED_SUBCOMMANDS).not.toContain(unsafe);
    }
    expect(BD_ALLOWED_SUBCOMMANDS).toContain("create");
    expect(BD_ALLOWED_SUBCOMMANDS).toContain("show");
  });
});
