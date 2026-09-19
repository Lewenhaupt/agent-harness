import { describe, expect, it } from "vitest";
import { castToText, cleanTerminalOutput, parseCast, readCastToText } from "../cast-utils.js";

describe("cleanTerminalOutput", () => {
  it("strips ANSI escape sequences", () => {
    expect(cleanTerminalOutput("hello \u001b[35mworld\u001b[0m")).toBe("hello world");
  });

  it("strips OSC sequences terminated by BEL", () => {
    expect(cleanTerminalOutput("\u001b]2;shell\u0007done")).toBe("done");
  });

  it("strips OSC sequences terminated by ST", () => {
    expect(cleanTerminalOutput("\u001b]0;window-title\u001b\\done")).toBe("done");
  });

  it("strips control characters but keeps whitespace", () => {
    expect(cleanTerminalOutput("a\u0001b\tc\nd")).toBe("ab\tc\nd");
  });

  it("removes OSC residues left after control stripping", () => {
    expect(cleanTerminalOutput("\u001b]2;shell\u0007]2;shell")).toBe("");
  });

  it("removes ]0; and ]0: terminal-title residue variants", () => {
    expect(cleanTerminalOutput("\u001b]0;window-title\u001b\\]0;leftover")).toBe("");
    expect(cleanTerminalOutput("\u001b]0;window-title\u001b\\]0:leftover")).toBe("");
  });
});

describe("parseCast", () => {
  const path = "/tmp/test.cast";

  it("parses a valid header and events", () => {
    const content = [
      JSON.stringify({ version: 3, command: "node cli.js" }),
      JSON.stringify([0, "o", "hi\n"]),
      JSON.stringify([0.5, "x", "0"]),
    ].join("\n");
    const result = parseCast(content, path);
    expect(result.passed).toBe(true);
    if (!result.passed) return;
    expect(result.header?.command).toBe("node cli.js");
    expect(result.events).toHaveLength(2);
  });

  it("rejects malformed header JSON with the original message", () => {
    const result = parseCast("not json\n[0, 'o', 'hi']", path);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("invalid header JSON");
  });

  it("rejects a header that is not an object", () => {
    const result = parseCast("null\n[0, 'o', 'hi']", path);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("header is not an object");
  });

  it("rejects a header without a command", () => {
    const result = parseCast("{}\n[0, 'o', 'hi']", path);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("no command executed");
  });

  it("rejects malformed event JSON", () => {
    const result = parseCast('{"command":"x"}\nnot-json', path);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("invalid JSON at event line 2");
  });

  it("rejects an invalid event shape", () => {
    const result = parseCast('{"command":"x"}\n[0,"o"]', path);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("invalid event format at line 2");
  });
});

describe("castToText", () => {
  it("renders the command, output, and exit code as plain text", () => {
    const text = castToText({
      header: { command: "curl /health" },
      events: [
        [0, "o", "\u001b[32mok\u001b[0m"],
        [1, "x", "0"],
      ],
    });
    expect(text).toContain("$ curl /health");
    expect(text).toContain("ok");
    expect(text).toContain("[exit 0]");
  });

  it("skips empty cleaned output events", () => {
    const text = castToText({
      header: { command: "x" },
      events: [[0, "o", "\u001b]2;shell\u0007"]],
    });
    expect(text).toBe("$ x");
  });
});

describe("readCastToText", () => {
  it("returns an error result for a missing file", async () => {
    const result = await readCastToText("/does/not/exist.cast");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Failed to read cast file");
  });
});
