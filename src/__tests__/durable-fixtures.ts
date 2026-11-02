/**
 * Shared fixtures for the durable-member tests (bd-186).
 *
 * Not a test file itself: it builds valid commands through the real validator so
 * a test can never pass against a command shape the contract would refuse.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableCommand, DurableCommandKind } from "../durable-member/commands.js";
import { validateDurableCommand } from "../durable-member/commands.js";

export const TEST_MEMBER_ID = "member-a";
export const TEST_STATE_DIR_PREFIX = "belayd-durable-member-";

/** Create a throwaway state dir; callers remove it in `afterEach`. */
export function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), TEST_STATE_DIR_PREFIX));
}

export function removeStateDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build one valid command of `kind`, with `overrides` applied on top.
 *
 * Gated kinds get a matching `confirmation` by default so a test that means to
 * exercise the gate has to remove it explicitly.
 */
export function makeCommand(
  kind: DurableCommandKind,
  overrides: Record<string, unknown> = {},
): DurableCommand {
  const payload: Record<string, unknown> = {};
  switch (kind) {
    case "steer":
    case "followup":
      payload.text = "steer the member";
      break;
    case "write":
      payload.entry = { role: "system", text: "operator note", kind: "note" };
      break;
    case "abort-submission":
      payload.submissionId = "sub-1";
      break;
    case "configure":
      payload.config = { model: "anthropic/claude-sonnet" };
      payload.confirmation = TEST_MEMBER_ID;
      break;
    case "reset":
      payload.confirmation = TEST_MEMBER_ID;
      break;
    case "abort":
    case "compact":
      break;
  }
  const validated = validateDurableCommand({
    kind,
    requestId: `req-${kind}-1`,
    memberId: TEST_MEMBER_ID,
    authority: "panel-human",
    issuedAt: 1_000,
    ...payload,
    ...overrides,
  });
  if (!validated.ok) {
    throw new Error(`test fixture for ${kind} is not valid: ${validated.error}`);
  }
  return validated.value;
}
