/**
 * Session transcript helpers.
 *
 * `/belayd-complete` needs to recover a dead or interrupted sub-agent's final
 * answer from its persisted session branch. The branch entries are pi's
 * `SessionEntry[]`, but this module deliberately accepts a minimal structural
 * shape (and narrows defensively) so it stays pure and unit-testable without
 * depending on pi's session types.
 */

/** Minimal structural view of one session branch entry. */
export interface TranscriptEntry {
  type?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the text of an assistant message's content.
 *
 * Assistant content is normally an array of blocks; only `text` blocks count.
 * Thinking and toolCall blocks are ignored because they are not the answer the
 * orchestrator needs. A plain string content is accepted for completeness.
 */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * The text of the last assistant message on the active branch.
 *
 * Walks from the end and returns the first `message` entry whose role is
 * `assistant`. The very last assistant message is the recovery target: it is
 * what the sub-agent would have returned to the orchestrator. Returns undefined
 * when the branch has no assistant message or the last one carries no text.
 */
export function lastAssistantText(entries: readonly TranscriptEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    return textFromContent(message.content);
  }
  return undefined;
}
