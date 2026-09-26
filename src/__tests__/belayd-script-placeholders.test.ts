import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRenderedScripts, renderScript } from "./helpers/belayd-script-harness.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PLACEHOLDER_RE = /@[a-zA-Z][a-zA-Z0-9_]*@/g;
// The generic "@placeholder@" mentioned in prose is not a substitution token.
const GENERIC_TOKEN = "@placeholder@";

const SCRIPT_NAMES = ["belayd-shell", "belayd-shell-path-setup", "belayd-direnv-setup"];

/** Collect the distinct `@token@` names in a file, ignoring prose mentions. */
function placeholderTokens(text: string): Set<string> {
  const found = text.match(PLACEHOLDER_RE) ?? [];
  return new Set(found.filter((token) => token !== GENERIC_TOKEN));
}

describe("belayd script placeholders (S2)", () => {
  afterEach(() => {
    cleanupRenderedScripts();
  });

  it("renders every script with no residual placeholder tokens", () => {
    for (const name of SCRIPT_NAMES) {
      const rendered = renderScript(name, { realShell: "/bin/bash", jqPath: "/bin/jq" });
      const contents = readFileSync(rendered.path, "utf-8");
      expect(contents, `${name} still contains a placeholder token`).not.toMatch(PLACEHOLDER_RE);
    }
  });

  it("keeps the helper's placeholder set in sync with flake.nix", () => {
    const helperSource = readFileSync(
      join(REPO_ROOT, "src", "__tests__", "helpers", "belayd-script-harness.ts"),
      "utf-8",
    );
    const flakeSource = readFileSync(join(REPO_ROOT, "flake.nix"), "utf-8");

    expect(placeholderTokens(helperSource)).toEqual(placeholderTokens(flakeSource));
  });
});
