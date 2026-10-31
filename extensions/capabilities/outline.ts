/**
 * Outline capability: the read-only `belayd_outline` symbol map (bd-179).
 *
 * Kept out of the composer so outline extraction (ctags + ast-grep) can change
 * without touching workflow or fleet state; the tool only reads files.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatOutline,
  isOutlineKind,
  OUTLINE_FILE_EXTENSIONS,
  OUTLINE_KINDS,
  type OutlineFilesOptions,
  type OutlineKind,
  outlineFiles,
} from "../../src/outline.js";
import { textToolResult } from "./context.js";

interface OutlineRawParams {
  path?: string;
  kind?: string[];
  name?: string;
  maxSymbols?: number;
}

/** Validated `belayd_outline` params. */
export interface OutlineValidatedParams {
  path: string;
  kind: OutlineKind[] | undefined;
  name: string | undefined;
  maxSymbols: number | undefined;
}

type OutlineParamValidation =
  | { ok: true; value: OutlineValidatedParams }
  | { ok: false; error: string };

/**
 * Validate the raw `belayd_outline` params.
 *
 * Kept separate from `execute` so rejection messages stay flat and the tool
 * body stays under the cognitive-complexity budget.
 */
export function validateOutlineParams(params: OutlineRawParams): OutlineParamValidation {
  const path = params.path;
  if (path === undefined || path.trim() === "") {
    return {
      ok: false,
      error: "path is required (a file, directory, or glob such as src/**/*.ts).",
    };
  }

  const rawKinds = params.kind;
  let kind: OutlineKind[] | undefined;
  if (rawKinds !== undefined) {
    for (const value of rawKinds) {
      if (!isOutlineKind(value)) {
        return {
          ok: false,
          error: `Unknown kind: ${value}. Supported kinds: ${OUTLINE_KINDS.join(", ")}.`,
        };
      }
    }
    kind = rawKinds.filter(isOutlineKind);
  }

  const maxSymbols = params.maxSymbols;
  if (maxSymbols !== undefined && (!Number.isInteger(maxSymbols) || maxSymbols < 1)) {
    return { ok: false, error: "maxSymbols must be a positive integer." };
  }

  return { ok: true, value: { path, kind, name: params.name, maxSymbols } };
}

/**
 * Resolve, extract, and format an outline. Errors are values, never throws.
 *
 * Extraction shells out to universal-ctags and ast-grep through an async
 * `execFile` seam, so a slow or hung parser never blocks pi's event loop; a
 * missing binary, a bad exit, or a partial-output recovery all come back as
 * values the tool renders as plain text.
 */
export async function buildOutlineText(
  cwd: string,
  params: OutlineValidatedParams,
  deps: OutlineDeps,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const resolved = deps.resolveOutlineTargets(cwd, params.path);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const extracted = await deps.extractOutlineSymbols(resolved.files);
  if (!extracted.ok) return { ok: false, error: extracted.error };

  const options: OutlineFilesOptions = {};
  if (params.kind !== undefined) options.kind = params.kind;
  if (params.name !== undefined) options.nameMatches = params.name;
  if (params.maxSymbols !== undefined) options.maxSymbols = params.maxSymbols;

  // A walk-capped resolution knows no true match total (the walk stopped
  // early), so the file-cap "matched N files" wording would be a false claim.
  // Distinguish the two causes so the note never overstates coverage. Notes
  // are rendered through the formatter's footer so they stay inside the 16 KB
  // output budget instead of being appended past it.
  const extraNotes: string[] = [];
  if (resolved.truncated) {
    extraNotes.push(
      resolved.truncatedBy === "walk-cap"
        ? "note: walk stopped at the entry cap; results may be incomplete."
        : `note: matched ${resolved.totalMatches ?? resolved.files.length} files; showing the first ${resolved.files.length}.`,
    );
  }
  extraNotes.push(...(extracted.notes ?? []));
  return {
    ok: true,
    text: formatOutline(outlineFiles(extracted.files, options), extraNotes),
  };
}

/**
 * Extraction seams injected by the composer.
 *
 * They are dependencies rather than direct imports because the extension test
 * suite swaps them through its `src/index.js` mock; a capability module that
 * imported the barrel itself would be forbidden (bd-179).
 */
export interface OutlineDeps {
  /** Directory/glob resolution for the tool's target list. */
  resolveOutlineTargets: typeof import("../../src/outline.js").resolveOutlineTargets;
  /** ctags + ast-grep extraction. */
  extractOutlineSymbols: typeof import("../../src/outline-extract.js").extractOutlineSymbols;
}

/**
 * Register `belayd_outline`; the composer supplies the pi API and extraction
 * seams.
 *
 * A read-only, multi-language symbol map with line ranges: sub-agents otherwise
 * re-read a file in offset windows to locate the next edit anchor. Declarations
 * come from universal-ctags; ast-grep supplies TypeScript-family ranges plus the
 * pi.registerTool / pi.on registrations that live inside the composer's body.
 * Consult-callable and non-phase, so it is listed in GATED_TOOLS only to survive
 * the process gate — never a required workflow step. The tool only reads files;
 * it exposes no edit/write/bash path.
 */
export function registerOutline(pi: ExtensionAPI, deps: OutlineDeps): void {
  pi.registerTool({
    name: "belayd_outline",
    label: "Belayd outline",
    description:
      "Read-only, multi-language symbol map with line ranges for a source file, directory, " +
      `or glob (supports *, ?, **; directories are walked for ${OUTLINE_FILE_EXTENSIONS.join("/")}). ` +
      "Extracts top-level functions, methods, classes, interfaces, types, enums, consts, and " +
      "structs/fields across the languages universal-ctags recognizes (map overrides add the " +
      "TypeScript-family extensions ctags does not map by default), and refines TypeScript-family " +
      "ranges plus pi.registerTool / pi.on registrations via ast-grep. Neither extractor is a " +
      "catch-all; the accepted extension set is explicit and rejects the rest. Returns rows in " +
      "line order. Re-export " +
      "barrels are not emitted (the bd-115 `export` kind was removed). Use this instead of " +
      "re-reading a large file in offset windows to locate the next edit anchor; pair with " +
      "`grep -n` for text. Output is bounded (~16 KB) and can be narrowed with `kind` or a " +
      "`name` substring. Requires the `ctags` and `ast-grep` binaries on PATH (the devShell " +
      "provides them; BELAYD_CTAGS_BIN / BELAYD_AST_GREP_BIN override).",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File, directory, or glob relative to the working directory (e.g. src/**/*.ts)",
      }),
      kind: Type.Optional(
        Type.Array(
          Type.Union(
            OUTLINE_KINDS.map((outlineKind) => Type.Literal(outlineKind)),
            { description: `Restrict to kinds: ${OUTLINE_KINDS.join(", ")}` },
          ),
        ),
      ),
      name: Type.Optional(
        Type.String({ description: "Case-insensitive substring filter on the symbol name" }),
      ),
      maxSymbols: Type.Optional(
        Type.Number({ description: "Cap the total number of symbols returned" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateOutlineParams(params);
      if (!validation.ok) return textToolResult(validation.error, 1);

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const built = await buildOutlineText(cwd, validation.value, deps);
      return built.ok ? textToolResult(built.text, 0) : textToolResult(built.error, 1);
    },
  });
}
