/**
 * Whether the human still has an open PI WEB `ask_user` question set (bd-177).
 *
 * PI WEB renders a question set as an interactive form only while it is the tail
 * of the transcript: the next appended entry turns the card into a dead
 * `closed-question-card` with no controls, records no outcome, and delivers
 * nothing to the model. A phase or planning completion delivered at that moment
 * therefore both destroys the human's chance to answer and wakes the model to
 * proceed without the answer, so the harness holds those follow-ups first.
 *
 * Pure: the caller reads the session branch and performs (or holds) the send.
 */

/** Custom message type PI WEB uses to deliver submitted and skipped answers. */
export const ASK_USER_ANSWERS_CUSTOM_TYPE = "pi-web.ask.answers";

/** Tool name of the PI WEB question tool whose unanswered result holds follow-ups. */
export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * Longest a follow-up stays held.
 *
 * The normal release is the next turn start (the answer, a skip, or the human's
 * own message), so this cap only stops a question set that is never touched from
 * stalling a workflow forever. It matches the human-answer wait the harness
 * already accepts elsewhere rather than introducing a second scale.
 */
export const ASK_HOLD_MAX_MS = 10 * 60 * 1000;

/** What the newest question-set-relevant entry in the session says. */
export type AskTail =
  /** The newest relevant entry is a question set with no answer after it. */
  | { readonly kind: "open"; readonly askId: string }
  /** A question set was answered, skipped, or superseded by the human's own message. */
  | { readonly kind: "closed" }
  /** No question set is involved in this session's tail. */
  | { readonly kind: "none" };

/**
 * Classify the session's question-set state from its newest relevant entry.
 *
 * Only three entry kinds matter: a successful `ask_user` result opens a set, and
 * a `pi-web.ask.answers` custom message or a user message closes it. Scanning
 * newest-first for the newest question set and remembering whether a closer came
 * after it keeps the classification honest in both directions: a session that
 * never asked is `none`, not `closed`, and an already-answered older set is not
 * resurrected by a newer question. Unrelated entries (assistant text, tool
 * output, our own held delivery) must not change the answer.
 */
export function askTail(entries: readonly unknown[]): AskTail {
  let closedAfter = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    if (isAskAnswersEntry(entry)) {
      closedAfter = true;
      continue;
    }
    const message = messageRecord(entry);
    if (message === undefined) continue;
    if (message.role === "user") {
      closedAfter = true;
      continue;
    }
    const askId = askIdOf(message);
    if (askId !== undefined) return closedAfter ? { kind: "closed" } : { kind: "open", askId };
  }
  return { kind: "none" };
}

/** True when a follow-up must be held instead of appended to the transcript. */
export function shouldHoldFollowUp(entries: readonly unknown[]): boolean {
  return askTail(entries).kind === "open";
}

function isAskAnswersEntry(entry: Record<string, unknown>): boolean {
  if (entry.type === "custom_message") {
    return entry.customType === ASK_USER_ANSWERS_CUSTOM_TYPE;
  }
  // Defensive: a session manager wrapper may project the same fact as a message.
  const message = messageRecord(entry);
  return message?.role === "custom" && message.customType === ASK_USER_ANSWERS_CUSTOM_TYPE;
}

function messageRecord(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  return isRecord(message) ? message : undefined;
}

/** The ask ID of a successful `ask_user` result, or undefined for any other message. */
function askIdOf(message: Record<string, unknown>): string | undefined {
  if (message.role !== "toolResult") return undefined;
  if (message.toolName !== ASK_USER_TOOL_NAME) return undefined;
  if (message.isError === true) return undefined;
  const details = message.details;
  if (!isRecord(details)) return undefined;
  const ask = details.ask;
  if (!isRecord(ask)) return undefined;
  const askId = ask.askId;
  return typeof askId === "string" && askId !== "" ? askId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
