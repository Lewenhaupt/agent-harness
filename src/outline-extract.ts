/**
 * Outline extraction orchestration: run the two external extractors, merge
 * their per-file symbols, and attach line counts.
 *
 * Errors are values throughout (`{ ok: false; error }`), so a missing binary
 * or a failed spawn surfaces as clean tool text rather than a stack trace.
 */

import { readFileSync } from "node:fs";
import type { OutlineFileSymbols, OutlineSymbol, OutlineSymbolGroup } from "./outline.js";
import { mergeOutlineSymbols } from "./outline.js";
import { runAstGrep } from "./outline-ast-grep.js";
import { runCtags } from "./outline-ctags.js";

export type OutlineExtractionResult =
  | { ok: true; files: OutlineFileSymbols[]; notes?: string[] }
  | { ok: false; error: string };

/** Per-call knobs; `env`/`*TimeoutInMs` exist so tests can drive failure paths. */
export interface OutlineExtractionOptions {
  env?: NodeJS.ProcessEnv;
  ctagsTimeoutInMs?: number;
  astGrepTimeoutInMs?: number;
}

function groupToMap(groups: readonly OutlineSymbolGroup[]): Map<string, OutlineSymbol[]> {
  const byPath = new Map<string, OutlineSymbol[]>();
  for (const group of groups) byPath.set(group.path, group.symbols);
  return byPath;
}

function countFileLines(path: string): number {
  try {
    const source = readFileSync(path, "utf8");
    return source.length === 0 ? 0 : source.split("\n").length;
  } catch {
    // The resolver already stat'd the file; a disappearance between resolve and
    // read is a race, not a tool error. Report zero lines and empty symbols.
    return 0;
  }
}

/**
 * Extract symbols for every path, preserving the resolver's file order.
 *
 * ctags is the base set for all languages; ast-grep refines the TypeScript
 * family and adds its registrations. A file with no symbols still appears in
 * the result so the formatter can print `(no matching symbols)`.
 */
export async function extractOutlineSymbols(
  files: readonly string[],
  options: OutlineExtractionOptions = {},
): Promise<OutlineExtractionResult> {
  if (files.length === 0) return { ok: true, files: [] };

  const env = options.env ?? process.env;
  const ctags = await runCtags(files, { env, timeoutInMs: options.ctagsTimeoutInMs });
  if (!ctags.ok) return { ok: false, error: ctags.error };
  const astGrep = await runAstGrep(files, { env, timeoutInMs: options.astGrepTimeoutInMs });
  if (!astGrep.ok) return { ok: false, error: astGrep.error };

  const ctagsByPath = groupToMap(ctags.groups);
  const astGrepByPath = groupToMap(astGrep.groups);
  const extracted: OutlineFileSymbols[] = [];
  for (const path of files) {
    const symbols = mergeOutlineSymbols(ctagsByPath.get(path) ?? [], astGrepByPath.get(path) ?? []);
    extracted.push({ path, lineCount: countFileLines(path), symbols });
  }
  const notes = [ctags.note, astGrep.note].filter((note): note is string => note !== undefined);
  return notes.length > 0 ? { ok: true, files: extracted, notes } : { ok: true, files: extracted };
}
