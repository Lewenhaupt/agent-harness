// SYNC WARNING: the panel's control bar pre-checks the authorization matrix with
// `controlAvailability` from `./contract.js`, which mirrors
// `src/durable-member/authority.ts`. The panel is never the gate: it claims
// `panel-human`, the server module forwards only that tier, and the member's
// owner verifies the claim against the tier its transport is bound to
// (`authorizeDurableCommand`). Rendering rules for entries/tasks mirror
// `src/durable-member/contract.ts`; keep the two sides aligned.
//
// Frame direction: the server module publishes the **wire frame**
// (`ConversationWatchFrame`, `entriesWindow`), so this panel is the only
// reducer — `handleChannelData` calls `reduceConversationFrames` exactly once.
// A server that pre-reduced its payload would double-reduce here (and drop the
// entries, which is exactly the seam bug `wire-seam.test.js` pins).

import {
  controlAvailability,
  formatTaskLine,
  mergeEarlierTranscriptPage,
  reduceConversationFrames,
  validateCommand,
} from "./contract.js";

export const durablePanelTagName = "pi-web-durable-member-panel";

export const EMPTY_MEMBERS_MESSAGE =
  "No durable members. A member appears here once its storage exists at " +
  "`members/<memberId>/store.sqlite` under this plugin's data directory.";

export const EMPTY_CONVERSATION_MESSAGE =
  "This member has no committed entries yet. Watch frames appear as it runs.";

export const NO_BACKEND_MESSAGE =
  "This PI WEB host does not expose a scoped backend. Update PI WEB and restart " +
  "the session daemon to stream durable members.";

const MAX_PROOF_TEXT = 2000;

/**
 * A configure command needs at least one field, or the validator refuses the
 * empty config. Check the draft first so the panel names the missing field
 * instead of showing a generic "Refused before send" message.
 *
 * @param {{ model?: string, tools?: string[], systemPrompt?: string }} draft
 * @returns {string | undefined}
 */
export function configureDraftError(draft) {
  const model = typeof draft.model === "string" ? draft.model.trim() : "";
  const tools = Array.isArray(draft.tools)
    ? draft.tools.filter((tool) => typeof tool === "string" && tool.trim() !== "")
    : [];
  const systemPrompt = typeof draft.systemPrompt === "string" ? draft.systemPrompt.trim() : "";
  if (model !== "" || tools.length > 0 || systemPrompt !== "") return undefined;
  return "Configure needs a model (or tools / system prompt) before it can be sent.";
}

export function defineDurableMemberPanelElement() {
  if (!customElements.get(durablePanelTagName)) {
    customElements.define(durablePanelTagName, PiWebDurableMemberPanel);
  }
}

/** Bounded one-line JSON, so a tool input cannot flood the transcript. */
function boundedJson(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (typeof text !== "string") text = String(text);
  return text.length > MAX_PROOF_TEXT ? `${text.slice(0, MAX_PROOF_TEXT)}…` : text;
}

/**
 * Summarize one transcript entry for rendering and for tests.
 *
 * @param {object} entry
 * @returns {{ kind: string, headline: string, body: string }}
 */
export function summarizeEntry(entry) {
  switch (entry.kind) {
    case "tool-call": {
      const call = entry.toolCall;
      const name = call === undefined ? "tool" : call.name;
      return {
        kind: "tool-call",
        headline: `tool call · ${name}`,
        body: call === undefined ? entry.text : boundedJson(call.input),
      };
    }
    case "tool-output": {
      const output = entry.toolOutput;
      const name = output === undefined ? "tool" : output.name;
      return {
        kind: "tool-output",
        headline: `tool output · ${name}`,
        body: output === undefined ? entry.text : output.output,
      };
    }
    case "retry": {
      const retry = entry.retry;
      const attempt = retry === undefined ? "?" : String(retry.attempt);
      const reason = retry?.reason === undefined ? "" : ` — ${retry.reason}`;
      return { kind: "retry", headline: `retry ${attempt}${reason}`, body: entry.text };
    }
    case "compaction": {
      const compaction = entry.compaction;
      const before = compaction?.tokensBefore;
      const after = compaction?.tokensAfter;
      const tokens =
        before === undefined || after === undefined ? "" : ` ${String(before)} → ${String(after)} tokens`;
      return { kind: "compaction", headline: `compaction${tokens}`, body: entry.text };
    }
    case "failure": {
      const failure = entry.failure;
      return {
        kind: "failure",
        headline: "run failed",
        body: failure === undefined ? entry.text : failure.message,
      };
    }
    default:
      return { kind: entry.kind, headline: entry.role, body: entry.text };
  }
}

/**
 * One-line live-generation banner: status, retry/compaction detail and
 * `runFailure`. Empty string means "nothing live", which is what an idle or
 * crashed-with-no-live-row member shows.
 *
 * A stale generation (the owner is gone or stopped heartbeating) is worded as
 * the last known generation rather than by its recorded `status`: the row still
 * says `streaming` because a crash never rewrites it, and repeating that would
 * be exactly the stale banner this exists to avoid.
 *
 * @param {object | null} live
 */
export function formatLiveBanner(live) {
  if (live === null || live === undefined) return "";
  if (live.stale === true) {
    const owner = live.staleReason === "owner-gone" ? "owner gone" : "owner gone (no heartbeat)";
    const parts = [owner, "last known generation", `attempt ${String(live.attempt)}`];
    if (live.retry !== undefined) {
      parts.push(`retry ${String(live.retry.attempt)}/${String(live.retry.maxAttempts ?? "?")}`);
    }
    if (live.compaction !== undefined) parts.push("compacting");
    if (live.runFailure !== undefined) parts.push(`failed: ${live.runFailure.message}`);
    return parts.join(" · ");
  }
  const parts = [`${live.status}`, `attempt ${String(live.attempt)}`];
  if (live.retry !== undefined) {
    parts.push(`retry ${String(live.retry.attempt)}/${String(live.retry.maxAttempts ?? "?")}`);
  }
  if (live.compaction !== undefined) parts.push("compacting");
  if (live.runFailure !== undefined) parts.push(`failed: ${live.runFailure.message}`);
  return parts.join(" · ");
}

/**
 * Build a command from panel state.
 *
 * `requestId` is injected so a test can be deterministic; the panel uses
 * `crypto.randomUUID()` (a retry reuses the same command object, which is what
 * makes the owner's dedupe meaningful).
 *
 * @param {{
 *   memberId: string,
 *   kind: string,
 *   authority?: string,
 *   text?: string,
 *   confirmation?: string,
 *   model?: string,
 *   submissionId?: string,
 *   requestId?: string,
 *   issuedAt?: number,
 * }} input
 */
export function buildCommand(input) {
  const command = {
    kind: input.kind,
    requestId: input.requestId ?? defaultRequestId(),
    memberId: input.memberId,
    authority: input.authority ?? "panel-human",
    issuedAt: input.issuedAt ?? Date.now(),
  };
  if (input.confirmation !== undefined && input.confirmation !== "") {
    command.confirmation = input.confirmation;
  }
  if (input.kind === "steer" || input.kind === "followup") {
    command.text = input.text ?? "";
  }
  if (input.kind === "write") {
    command.entry = { role: "system", text: input.text ?? "", kind: "note" };
  }
  if (input.kind === "abort-submission") {
    command.submissionId = input.submissionId ?? "";
  }
  if (input.kind === "configure") {
    command.config = input.model === undefined ? {} : { model: input.model };
  }
  const validated = validateCommand(command);
  return validated.ok ? validated.value : { error: validated.error, code: validated.code };
}

function defaultRequestId() {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === "function") {
    return source.randomUUID();
  }
  return `req-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Durable-member panel: member list, streamed transcript (partials, tool output
 * and details, retries, compaction, runFailure), task graph with owner edge and
 * "waiting on", load-earlier merging, and the control bar.
 *
 * All async work flows through one abort controller per selected member, so a
 * stale channel can never overwrite a newer selection.
 */
class PiWebDurableMemberPanel extends HTMLElement {
  contextValue;
  members = [];
  selectedMemberId;
  view;
  tasks = [];
  status = "idle";
  errorMessage;
  controlMessage;
  channel;
  abortController;
  detailEntryId;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>${panelStyles()}</style>
      <section class="toolbar">
        <label>Member <select data-member><option value="">(none)</option></select></label>
        <button data-refresh type="button">Refresh</button>
        <span class="status" data-status></span>
      </section>
      <section class="layout">
        <section class="transcript">
          <button data-load-earlier type="button" hidden>Load earlier</button>
          <ol class="entries" data-entries></ol>
          <p class="empty" data-empty></p>
          <pre class="live" data-live hidden></pre>
          <pre class="details" data-details hidden></pre>
        </section>
        <aside class="tasks">
          <h3>Task graph</h3>
          <ul data-tasks></ul>
          <p class="empty" data-tasks-empty hidden>No durable tasks reported.</p>
        </aside>
      </section>
      <section class="controls">
        <input data-steer type="text" placeholder="Steer text (joins after the current tool round)" />
        <button data-kind="steer" type="button">Steer</button>
        <button data-kind="followup" type="button">Follow up</button>
        <button data-kind="abort" type="button">Abort</button>
        <button data-kind="compact" type="button">Compact</button>
        <input data-model type="text" placeholder="model (configure)" />
        <input data-confirmation type="text" placeholder="Type the member id to confirm configure/reset" />
        <button data-kind="configure" type="button">Configure</button>
        <button data-kind="reset" type="button">Reset</button>
        <p class="control-result" data-control-result></p>
      </section>
    `;

    this.memberSelect = requiredRegion(this.root, "select[data-member]");
    this.statusEl = requiredRegion(this.root, "[data-status]");
    this.entriesEl = requiredRegion(this.root, "[data-entries]");
    this.emptyEl = requiredRegion(this.root, "[data-empty]");
    this.liveEl = requiredRegion(this.root, "[data-live]");
    this.detailsEl = requiredRegion(this.root, "[data-details]");
    this.tasksEl = requiredRegion(this.root, "[data-tasks]");
    this.tasksEmptyEl = requiredRegion(this.root, "[data-tasks-empty]");
    this.loadEarlierButton = requiredRegion(this.root, "[data-load-earlier]");
    this.controlResultEl = requiredRegion(this.root, "[data-control-result]");
    this.steerInput = requiredRegion(this.root, "input[data-steer]");
    this.modelInput = requiredRegion(this.root, "input[data-model]");
    this.confirmationInput = requiredRegion(this.root, "input[data-confirmation]");

    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const refresh = target.closest("[data-refresh]");
      if (refresh !== null) {
        void this.refreshMembers();
        return;
      }
      if (target.closest("[data-load-earlier]") !== null) {
        void this.loadEarlier();
        return;
      }
      const control = target.closest("[data-kind]");
      if (control !== null) {
        const kind = control.getAttribute("data-kind");
        if (kind !== null) void this.sendControl(kind);
      }
    });

    this.memberSelect.addEventListener("change", () => {
      this.selectMember(this.memberSelect.value === "" ? undefined : this.memberSelect.value);
    });

    // Gated buttons depend on what is typed, so the availability and the draft
    // guard are recomputed on every edit. Without this the Configure button
    // stayed disabled until something else happened to call `render()`.
    for (const input of [this.modelInput, this.confirmationInput]) {
      input.addEventListener("input", () => this.render());
      input.addEventListener("change", () => this.render());
    }

    this.entriesEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest("[data-entry-id]");
      if (row === null) return;
      const entryId = row.getAttribute("data-entry-id");
      if (entryId !== null) void this.showEntryDetails(entryId);
    });
  }

  set context(value) {
    this.contextValue = value;
    this.memberSelect.value = this.selectedMemberId ?? "";
    void this.refreshMembers();
  }

  get context() {
    return this.contextValue;
  }

  disconnectedCallback() {
    this.closeChannel();
  }

  /** The scoped machine peer; undefined on hosts without browser API v5 backends. */
  peer() {
    const backend = this.contextValue?.backend;
    if (backend === undefined || backend === null) return undefined;
    return backend.forScope({ kind: "machine" });
  }

  async call(operation, input) {
    const peer = this.peer();
    if (peer === undefined || typeof peer.request !== "function") {
      throw new Error(NO_BACKEND_MESSAGE);
    }
    return peer.request(operation, input ?? null);
  }

  closeChannel() {
    if (this.abortController !== undefined) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    if (this.channel !== undefined) {
      try {
        this.channel.close("member deselected");
      } catch {
        // A channel that already closed is not an error worth surfacing.
      }
      this.channel = undefined;
    }
  }

  async refreshMembers() {
    this.status = "loading";
    this.render();
    try {
      const response = await this.call("members");
      this.members = Array.isArray(response?.members) ? response.members : [];
      const stillPresent = this.members.some((member) => member.memberId === this.selectedMemberId);
      if (!stillPresent) {
        this.selectedMemberId = this.members[0]?.memberId;
        this.closeChannel();
        this.view = undefined;
        this.tasks = [];
        this.clearMemberScopedText();
      }
      this.status = this.members.length === 0 ? "idle" : "ready";
      this.errorMessage = undefined;
      this.render();
      if (this.selectedMemberId !== undefined) await this.openChannel();
    } catch (error) {
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  /**
   * Drop everything that describes the previously selected member.
   *
   * `render()` owns the transcript, tasks and control result, but entry details
   * are written straight into the shadow DOM by `showEntryDetails`, so a
   * selection change has to clear them explicitly or the previous member's
   * details stay on screen next to the new member's transcript.
   */
  clearMemberScopedText() {
    this.detailEntryId = undefined;
    this.detailsEl.textContent = "";
    this.detailsEl.hidden = true;
    this.controlMessage = undefined;
    this.controlResultEl.textContent = "";
  }

  selectMember(memberId) {
    if (memberId === this.selectedMemberId) return;
    this.selectedMemberId = memberId;
    this.closeChannel();
    this.view = undefined;
    this.tasks = [];
    this.clearMemberScopedText();
    void this.openChannel();
  }

  async openChannel() {
    const memberId = this.selectedMemberId;
    if (memberId === undefined) return;
    this.closeChannel();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      const peer = this.peer();
      if (peer === undefined || typeof peer.openChannel !== "function") {
        throw new Error(NO_BACKEND_MESSAGE);
      }
      this.channel = await peer.openChannel(
        "watch",
        { memberId },
        {
          signal,
          onData: (data) => this.handleChannelData(data),
        },
      );
      this.status = "live";
      this.errorMessage = undefined;
    } catch (error) {
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  handleChannelData(data) {
    if (data === null || typeof data !== "object") return;
    if (data.type === "error") {
      this.status = "error";
      this.errorMessage = String(data.error ?? "durable member stream failed");
      this.render();
      return;
    }
    if (data.type !== "frame") return;
    // The single reduction: the server sends `ConversationWatchFrame` windows,
    // never a view, so this merge is the only one in the pipeline.
    this.view = reduceConversationFrames(this.view, data.frame);
    this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    this.status = "live";
    this.render();
  }

  async loadEarlier() {
    const memberId = this.selectedMemberId;
    const cursor = this.view?.cursor;
    if (memberId === undefined || cursor === null || cursor === undefined) return;
    try {
      const page = await this.call("load-earlier", { memberId, cursor });
      if (page === null || typeof page !== "object") return;
      this.view =
        this.view === undefined
          ? reduceConversationFrames(undefined, {
              conversationId: memberId,
              entriesWindow: page.entries ?? [],
              cursor: page.cursor ?? null,
              hasEarlier: page.hasEarlier === true,
              live: null,
              emittedAt: Date.now(),
            })
          : mergeEarlierTranscriptPage(this.view, {
              entries: page.entries ?? [],
              cursor: page.cursor ?? null,
              hasEarlier: page.hasEarlier === true,
            });
      this.render();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  async showEntryDetails(entryId) {
    const memberId = this.selectedMemberId;
    if (memberId === undefined) return;
    try {
      const details = await this.call("entry-details", { memberId, entryId });
      this.detailEntryId = entryId;
      this.detailsEl.textContent = JSON.stringify(details, null, 2);
      this.detailsEl.hidden = false;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  async sendControl(kind) {
    const memberId = this.selectedMemberId;
    if (memberId === undefined) {
      this.controlMessage = "Select a durable member first.";
      this.render();
      return;
    }
    const confirmation = this.confirmationInput.value;
    const availability = controlAvailability({ kind, memberId, confirmation });
    if (!availability.available) {
      this.controlMessage =
        availability.requiresConfirmation === "mismatch"
          ? "Confirmation must equal the member id; the owner refuses gated commands otherwise."
          : availability.requiresConfirmation === "missing"
            ? `Type the member id (${memberId}) to confirm ${kind}.`
            : `${kind} is not available at the panel tier.`;
      this.render();
      return;
    }

    const draftError = kind === "configure" ? configureDraftError({ model: this.modelInput.value }) : undefined;
    if (draftError !== undefined) {
      this.controlMessage = draftError;
      this.render();
      return;
    }

    const command = buildCommand({
      memberId,
      kind,
      text: kind === "configure" ? undefined : this.steerInput.value,
      confirmation: confirmation === "" ? undefined : confirmation,
      model: this.modelInput.value === "" ? undefined : this.modelInput.value,
    });
    if (command.error !== undefined) {
      this.controlMessage = `Refused before send: ${command.error}`;
      this.render();
      return;
    }

    try {
      const result = await this.call("control", { command });
      this.controlMessage =
        result?.ok === true
          ? `${kind} ${result.duplicate === true ? "already applied (duplicate requestId)" : "delivered"}`
          : `${kind} refused: ${String(result?.error ?? "unknown error")}`;
    } catch (error) {
      this.controlMessage = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  render() {
    this.memberSelect.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(none)";
    this.memberSelect.append(none);
    for (const member of this.members) {
      const option = document.createElement("option");
      option.value = member.memberId;
      option.textContent =
        member.live === true ? `${member.memberId} (live)` : `${member.memberId} (idle)`;
      this.memberSelect.append(option);
    }
    this.memberSelect.value = this.selectedMemberId ?? "";

    this.statusEl.textContent =
      this.status === "error"
        ? `error: ${this.errorMessage ?? "unknown"}`
        : this.members.length === 0
          ? "no durable members"
          : `${String(this.members.length)} member(s) · ${this.status}`;

    const entries = this.view?.entries ?? [];
    this.entriesEl.replaceChildren();
    for (const entry of entries) {
      const summary = summarizeEntry(entry);
      const item = document.createElement("li");
      item.className = `entry kind-${summary.kind}`;
      item.setAttribute("data-entry-id", entry.id);
      const headline = document.createElement("span");
      headline.className = "headline";
      headline.textContent = `${summary.headline} · ${new Date(entry.timestamp).toISOString()}`;
      const body = document.createElement("pre");
      body.textContent = summary.body;
      item.append(headline, body);
      this.entriesEl.append(item);
    }

    const live = this.view?.live ?? null;
    const banner = formatLiveBanner(live);
    this.liveEl.hidden = live === null;
    this.liveEl.textContent =
      live === null
        ? ""
        : `${banner}\n${live.partialText}${
            live.toolCalls.length === 0
              ? ""
              : `\n${live.toolCalls
                  .map(
                    (call) =>
                      `[${call.status}] ${call.name}${call.output === undefined ? "" : `: ${call.output}`}`,
                  )
                  .join("\n")}`
          }`;

    this.emptyEl.textContent =
      this.members.length === 0
        ? EMPTY_MEMBERS_MESSAGE
        : entries.length === 0
          ? EMPTY_CONVERSATION_MESSAGE
          : "";
    this.emptyEl.hidden = this.emptyEl.textContent === "";

    this.loadEarlierButton.hidden = this.view?.hasEarlier !== true;

    this.tasksEl.replaceChildren();
    for (const task of this.tasks) {
      const item = document.createElement("li");
      item.textContent = formatTaskLine(task);
      this.tasksEl.append(item);
    }
    this.tasksEmptyEl.hidden = this.tasks.length !== 0;

    for (const button of this.root.querySelectorAll("button[data-kind]")) {
      const kind = button.getAttribute("data-kind");
      if (kind === null) continue;
      const availability =
        this.selectedMemberId === undefined
          ? { available: false }
          : controlAvailability({
              kind,
              memberId: this.selectedMemberId,
              confirmation: this.confirmationInput.value,
            });
      const draftBlocked =
        kind === "configure" &&
        configureDraftError({ model: this.modelInput.value }) !== undefined;
      button.disabled = !availability.available || draftBlocked;
    }

    this.controlResultEl.textContent = this.controlMessage ?? "";
  }
}

function requiredRegion(root, selector) {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`durable-member panel is missing ${selector}`);
  return element;
}

function panelStyles() {
  return `
    :host { display: block; height: 100%; font: 13px/1.45 system-ui, sans-serif; color: inherit; }
    .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px; border-bottom: 1px solid #8884; }
    .status { margin-left: auto; opacity: .8; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 26%); gap: 8px; padding: 8px; }
    .entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .entry { border-left: 3px solid #8884; padding: 4px 8px; cursor: pointer; }
    .entry.kind-failure { border-left-color: #d33; }
    .entry.kind-retry, .entry.kind-compaction { border-left-color: #d90; }
    .entry.kind-tool-call, .entry.kind-tool-output { border-left-color: #39c; }
    .headline { font-weight: 600; opacity: .85; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 0; }
    .live { border: 1px dashed #39c; padding: 6px; }
    .details { border: 1px solid #8884; padding: 6px; max-height: 240px; overflow: auto; }
    .empty { opacity: .7; font-style: italic; }
    .tasks ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; border-top: 1px solid #8884; }
    .controls input { min-width: 180px; }
    .control-result { flex-basis: 100%; margin: 0; opacity: .85; }
    button[disabled] { opacity: .5; }
  `;
}
