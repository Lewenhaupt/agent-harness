import { listTaskDirs, listTaskFiles, readProofFile, getFileExtension, PROOF_OF_WORK_ROOT, resolveProofRoot } from "./discovery.js";
import { renderFileContent, renderTracePlaceholder, isTraceFile } from "./renderers.js";

export const proofPanelTagName = "pi-web-proof-of-work-panel";

export function defineProofPanelElement() {
  if (!customElements.get(proofPanelTagName)) {
    customElements.define(proofPanelTagName, PiWebProofOfWorkPanel);
  }
}

/**
 * Proof-of-work artifact viewer: two-pane layout with a sidebar listing
 * task directories and their files, and a viewer for rendering individual
 * artifacts. Supports .cast (asciinema-player), .webm, images, .md, and
 * plain text files.
 *
 * All async loads flow through scanToken so stale responses for a previous
 * workspace or selection never overwrite newer state.
 */
class PiWebProofOfWorkPanel extends HTMLElement {
  contextValue;
  listing;
  proofRoot;
  selectedTaskPath;
  taskFiles;
  selectedFilePath;
  fileContent;
  scanToken = 0;
  /** Blob URLs created for media/cast playback; revoked on disconnect. */
  blobUrls = new Set();
  /** Asciinema player instances { element, instance } for cleanup. */
  playerInstances = [];

  root;
  toolbar;
  sidebar;
  taskListEl;
  viewer;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      ${proofStyles()}
      <section class="toolbar" hidden></section>
      <section class="panel-layout">
        <nav class="sidebar" aria-label="Proof of Work artifacts">
          <div class="task-list"></div>
        </nav>
        <section class="viewer"><div class="empty">Select a workspace.</div></section>
      </section>
    `;
    this.toolbar = requiredRegion(this.root, ".toolbar");
    this.sidebar = requiredRegion(this.root, ".sidebar");
    this.taskListEl = requiredRegion(this.root, ".task-list");
    this.viewer = requiredRegion(this.root, ".viewer");

    // Toolbar: refresh button
    this.toolbar.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-refresh]") : null;
      if (button !== null) this.refresh();
    });

    // Viewer: open a selected Playwright trace in the external Trace Viewer
    this.viewer.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const openTraceButton = target.closest("[data-open-trace]");
      if (openTraceButton !== null) {
        const filePath = openTraceButton.getAttribute("data-open-trace");
        if (filePath !== null) this.openTrace(filePath);
      }
    });

    // Sidebar: click delegation for task toggle and file selection
    this.sidebar.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const taskToggle = target.closest("[data-toggle-task]");
      if (taskToggle !== null) {
        const taskPath = taskToggle.getAttribute("data-toggle-task");
        const context = this.contextValue;
        if (context !== undefined && taskPath !== null) {
          // Selecting a task loads its file list and shows the first file. The
          // previous toggle-only path never loaded files, so every task except
          // the initially selected one stayed stuck on "Loading files…".
          void this.selectTask(context, taskPath);
        }
        return;
      }

      const fileLink = target.closest("[data-select-file]");
      if (fileLink !== null) {
        const filePath = fileLink.getAttribute("data-select-file");
        const context = this.contextValue;
        if (context !== undefined && filePath !== null) {
          void this.selectFile(context, filePath);
        }
      }
    });
  }

  set context(value) {
    const previousKey = this.contextValue === undefined ? undefined : contextKey(this.contextValue);
    const nextKey = value === undefined ? undefined : contextKey(value);
    this.contextValue = value;
    if (previousKey === nextKey) return;
    if (value === undefined) {
      this.resetScanState();
      this.renderAll();
      return;
    }
    void this.scan(value);
  }

  /** Scan proof-of-work directory, then restore selection if still valid. */
  async scan(context) {
    const token = ++this.scanToken;
    this.resetScanState();
    this.renderAll();
    this.loadAsciinemaPlayerAssets();

    const root = await resolveProofRoot(context.files);
    if (!this.isCurrentScan(context, token)) return;
    if (root.kind === "unavailable") {
      this.listing = { kind: "unavailable", detail: root.detail };
      this.renderAll();
      return;
    }
    this.proofRoot = root;

    const listing = await listTaskDirs(context.files, root.path);
    if (!this.isCurrentScan(context, token)) return;
    this.listing = listing;

    // Restore previously selected task if still present
    const previousTask = this.selectedTaskPath;
    const task = listing.kind === "loaded"
      ? listing.tasks.find((candidate) => candidate.path === previousTask) ?? listing.tasks[0]
      : undefined;
    this.selectedTaskPath = task?.path;

    this.renderToolbar();
    this.renderTaskList();

    if (task === undefined) {
      this.renderViewer();
      return;
    }
    await this.loadTaskFiles(context, token, task.path);
  }

  /** List files for a task directory and select the first file. */
  async selectTask(context, taskPath) {
    const token = ++this.scanToken;
    this.selectedTaskPath = taskPath;
    this.selectedFilePath = undefined;
    this.taskFiles = undefined;
    this.fileContent = undefined;
    this.renderTaskList();
    this.renderViewer();
    await this.loadTaskFiles(context, token, taskPath);
  }

  /** Read and render a specific file. */
  async selectFile(context, filePath) {
    const token = ++this.scanToken;
    this.selectedFilePath = filePath;
    this.fileContent = undefined;
    this.updateSelectedFile();
    this.renderViewer();

    // Traces open in the external Playwright Trace Viewer, not inline; skip
    // reading the (potentially large) archive into memory.
    if (isTraceFile(getFileExtension(filePath))) {
      this.fileContent = { kind: "trace" };
      this.renderViewer();
      return;
    }

    const content = await readProofFile(context.files, filePath);
    if (!this.isCurrentScan(context, token)) return;
    this.fileContent = content;
    this.renderViewer();
    this.initializeMediaPlayers();
  }

  /** Load files for a task. Auto-selects the first file. */
  async loadTaskFiles(context, token, taskPath) {
    this.taskFiles = undefined;
    this.renderViewer();

    const files = await listTaskFiles(context.files, taskPath);
    if (!this.isCurrentScan(context, token)) return;
    this.taskFiles = files;

    // Re-render task list to show files
    this.renderTaskList();

    const firstFile = files.kind === "loaded" && files.files.length > 0 ? files.files[0] : undefined;
    if (firstFile !== undefined) {
      await this.selectFile(context, firstFile.path);
    } else {
      this.renderViewer();
    }
  }

  /** Re-scan and try to preserve current selections. */
  refresh() {
    const context = this.contextValue;
    if (context === undefined) return;
    void this.scan(context);
  }

  /**
   * Open a Playwright trace in the local Trace Viewer. Runs `playwright
   * show-trace` in a workspace terminal (which serves both the viewer and the
   * trace over HTTP) and points a new tab at it once it is listening.
   *
   * Assumes the workspace runs on the same machine as the browser (the local
   * case this panel is used for), hence the loopback URL.
   */
  openTrace(filePath) {
    const context = this.contextValue;
    if (context === undefined) return;

    if (typeof context.terminal?.runCommand !== "function") {
      this.viewer.innerHTML = renderErrorState(
        "Could not start the Trace Viewer.",
        "This pi-web build does not expose the terminal helper needed to launch it. Run `npx playwright show-trace <file>` in a terminal instead.",
      );
      return;
    }

    const viewerUrl = `http://localhost:${TRACE_VIEWER_PORT}`;
    const absolutePath = joinWorkspacePath(context.workspace.path, filePath);

    // Open a blank tab synchronously (still inside the user gesture) so popup
    // blockers allow it, then navigate it once the server is listening.
    const windowRef = window.open("", "_blank");

    try {
      void context.terminal.runCommand({
        title: `Trace viewer: ${fileName(filePath)}`,
        command: showTraceCommand({ port: TRACE_VIEWER_PORT, tracePath: absolutePath }),
        open: true,
      });
    } catch (error) {
      if (windowRef !== null) windowRef.close();
      this.viewer.innerHTML = renderErrorState(
        "Could not start the Trace Viewer.",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    void this.waitForServer(viewerUrl, 10_000, 250).then((ready) => {
      if (windowRef === null || windowRef.closed) return;
      if (ready) {
        windowRef.location.href = viewerUrl;
      } else {
        windowRef.document.write("<p style='font-family: sans-serif; padding: 1rem'>Trace viewer did not start in time. Check the workspace terminal.</p>");
      }
    });
  }

  /** Poll a URL until it responds or the timeout elapses. */
  async waitForServer(url, timeoutInMs, intervalInMs) {
    const deadline = Date.now() + timeoutInMs;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), intervalInMs);
        await fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal });
        clearTimeout(timer);
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, intervalInMs));
      }
    }
    return false;
  }

  resetScanState() {
    this.destroyPlayers();
    this.listing = undefined;
    this.proofRoot = undefined;
    this.selectedTaskPath = undefined;
    this.taskFiles = undefined;
    this.selectedFilePath = undefined;
    this.fileContent = undefined;
    this.asciinemaLoadError = false;
  }

  isCurrentScan(context, token) {
    return token === this.scanToken && this.contextValue !== undefined && contextKey(this.contextValue) === contextKey(context);
  }

  renderAll() {
    this.renderToolbar();
    this.renderTaskList();
    this.renderViewer();
  }

  renderToolbar() {
    if (this.contextValue === undefined) {
      this.toolbar.hidden = true;
      this.toolbar.replaceChildren();
      return;
    }
    this.toolbar.hidden = false;
    this.toolbar.innerHTML = `
      <strong>Proof of Work</strong>
      <span class="toolbar-actions">
        <button class="icon-button" data-refresh aria-label="Refresh" title="Refresh">${refreshIconSvg()}</button>
      </span>
    `;
  }

  renderTaskList() {
    if (this.contextValue === undefined) {
      this.taskListEl.innerHTML = "";
      return;
    }

    const listing = this.listing;
    if (listing === undefined) {
      this.taskListEl.innerHTML = `<p class="muted">Scanning ${escapeHtml(PROOF_OF_WORK_ROOT)}…</p>`;
      return;
    }

    if (listing.kind === "denied") {
      this.taskListEl.innerHTML = this.renderDenied();
      return;
    }

    if (listing.kind === "unavailable") {
      this.taskListEl.innerHTML = `<div class="status error"><strong>${escapeHtml("Could not scan proof-of-work directory.")}</strong><pre>${escapeHtml(listing.detail)}</pre></div>`;
      return;
    }

    if (listing.kind === "missing" || listing.tasks.length === 0) {
      this.taskListEl.innerHTML = `<div class="empty-state"><strong>No artifacts found.</strong><p>Proof-of-work artifacts live outside the workspace in the external proof base, presented as <code>${escapeHtml(PROOF_OF_WORK_ROOT)}/&lt;task-id&gt;/</code>.</p></div>`;
      return;
    }

    this.taskListEl.innerHTML = listing.tasks.map((task) => {
      const selected = task.path === this.selectedTaskPath;
      const taskFilesForTask = this.selectedTaskPath === task.path ? this.taskFiles : undefined;
      return `
        <div class="task-item${selected ? " selected" : ""}">
          <button class="task-toggle" data-toggle-task="${escapeAttr(task.path)}" aria-expanded="${selected ? "true" : "false"}">
            <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18l6-6-6-6"/></svg>
            <span class="task-name">${escapeHtml(task.name)}</span>
          </button>
          <div class="file-list${selected ? " expanded" : ""}" data-task-files="${escapeAttr(task.path)}">
            ${this.renderFileListItems(taskFilesForTask)}
          </div>
        </div>
      `;
    }).join("");
  }

  renderFileListItems(taskFiles) {
    if (taskFiles === undefined) {
      return `<p class="muted small">Loading files…</p>`;
    }
    if (taskFiles.kind === "denied") {
      return `<p class="status error small">${escapeHtml("Could not access the proof-of-work directory.")}</p>`;
    }
    if (taskFiles.kind === "unavailable") {
      return `<p class="status error small">${escapeHtml(taskFiles.detail)}</p>`;
    }
    if (taskFiles.kind === "missing") {
      return `<p class="muted small">Task directory no longer exists.</p>`;
    }
    if (taskFiles.files.length === 0) {
      return `<p class="muted small">No files.</p>`;
    }
    return taskFiles.files.map((file) => {
      const ext = getFileExtension(file.name);
      const icon = fileIcon(ext);
      const selected = file.path === this.selectedFilePath;
      return `
        <button class="file-item${selected ? " selected" : ""}" data-select-file="${escapeAttr(file.path)}">
          <span class="file-icon">${icon}</span>
          <span class="file-name">${escapeHtml(file.name)}</span>
        </button>
      `;
    }).join("");
  }

  /** Toggle the selected-file marker on file items without rebuilding the tree. */
  updateSelectedFile() {
    for (const btn of this.taskListEl.querySelectorAll("button[data-select-file]")) {
      const active = btn.getAttribute("data-select-file") === this.selectedFilePath;
      btn.classList.toggle("selected", active);
    }
  }

  renderViewer() {
    if (this.contextValue === undefined) {
      this.viewer.innerHTML = `<div class="empty">Select a workspace to view proof artifacts.</div>`;
      return;
    }
    this.viewer.innerHTML = this.renderViewerContent();
  }

  renderViewerContent() {
    if (this.asciinemaLoadError) {
      return `<div class="status error"><strong>Asciinema player failed to load.</strong><p>Cast recordings cannot be played. Try refreshing the workspace.</p></div>`;
    }
    const listing = this.listing;
    if (listing === undefined) {
      return `<p class="muted">Scanning ${escapeHtml(PROOF_OF_WORK_ROOT)}…</p>`;
    }
    if (listing.kind === "unavailable") {
      return renderErrorState("Could not scan proof-of-work directory.", listing.detail);
    }
    if (listing.kind === "denied") {
      return this.renderDenied();
    }
    if (listing.kind === "missing" || listing.tasks.length === 0) {
      return `<div class="empty-state"><strong>No proof-of-work artifacts in this workspace.</strong><p>Proof artifacts live outside the workspace in the external proof base, presented as <code>${escapeHtml(PROOF_OF_WORK_ROOT)}/&lt;task-id&gt;/</code>.</p></div>`;
    }

    const taskFiles = this.taskFiles;
    if (taskFiles === undefined) {
      return `<p class="muted">Loading files…</p>`;
    }
    if (taskFiles.kind === "denied") {
      return this.renderDenied();
    }
    if (taskFiles.kind === "unavailable") {
      return renderErrorState("Could not list task files.", taskFiles.detail);
    }
    if (taskFiles.kind === "missing") {
      return `<div class="empty-state"><strong>Task directory no longer exists.</strong><p>Click Refresh to rescan.</p></div>`;
    }
    if (taskFiles.files.length === 0) {
      return `<div class="empty-state"><strong>This task has no files.</strong></div>`;
    }

    const filePath = this.selectedFilePath;
    const content = this.fileContent;
    if (filePath === undefined) {
      return `<p class="muted">Select a file.</p>`;
    }
    if (content?.kind === "trace") {
      return renderTracePlaceholder(filePath);
    }
    if (content === undefined) {
      return `<p class="muted">Loading ${escapeHtml(fileName(filePath))}…</p>`;
    }
    if (content.kind === "unavailable") {
      return renderErrorState("Could not read this file.", content.detail);
    }
    if (content.kind === "denied") {
      return this.renderDenied();
    }
    if (content.kind === "missing") {
      return `<div class="empty-state"><strong>File no longer exists.</strong><p>Click Refresh to rescan.</p></div>`;
    }

    return renderFileContent(filePath, content.content, content.binary, content.truncated);
  }

  /**
   * Render the guidance shown when pi-web blocks access to the proof base path.
   *
   * The proof base comes from a marker file and is attacker-controllable, so
   * this message must never interpolate it. Guidance is keyed off the resolved
   * root kind and uses only static, trusted HTML.
   */
  renderDenied() {
    let guidance;
    if (this.proofRoot?.kind === "workspace") {
      guidance =
        "The workspace <code>proof-of-work</code> link points outside the workspace. Re-run a Belayd phase tool so the harness writes the <code>.belayd/proof-dir</code> marker, then refresh.";
    } else {
      guidance =
        "Add the proof base directory to pi-web's <strong>External filesystem roots</strong> (<code>pathAccess.allowedPaths</code> in the global pi-web config or <code>&lt;workspace&gt;/.pi-web/config.json</code>), then refresh.";
    }
    return `<div class="status error"><strong>Could not access the proof-of-work directory.</strong><p>${guidance}</p></div>`;
  }

  /**
   * After the viewer is rendered, find cast and media placeholders and
   * initialize their players with blob URLs.
   */
  initializeMediaPlayers() {
    // Clean up any previous blob URLs and player instances
    this.destroyPlayers();

    // Initialize asciinema cast players
    for (const placeholder of this.viewer.querySelectorAll(".cast-player[data-cast-path]")) {
      const castPath = placeholder.getAttribute("data-cast-path");
      if (castPath === null) continue;

      const content = this.fileContent;
      if (content?.kind !== "loaded") continue;

      try {
        const blob = new Blob([content.content], { type: "application/json" });
        const blobUrl = URL.createObjectURL(blob);
        this.blobUrls.add(blobUrl);

        if (typeof AsciinemaPlayer !== "undefined" && AsciinemaPlayer !== null) {
          const player = AsciinemaPlayer.create(blobUrl, placeholder, {
            fit: "width",
            terminalFontSize: "small",
          });
          this.playerInstances.push({ element: placeholder, instance: player });
        } else {
          placeholder.innerHTML = `<div class="status error"><strong>Asciinema player not loaded.</strong></div>`;
        }
      } catch (error) {
        placeholder.innerHTML = `<div class="status error"><strong>Failed to load cast file.</strong><pre>${escapeHtml(String(error))}</pre></div>`;
      }
    }

    // Initialize image/video media
    for (const mediaEl of this.viewer.querySelectorAll(".proof-media[data-media-path]")) {
      const mediaPath = mediaEl.getAttribute("data-media-path");
      const mimeType = mediaEl.getAttribute("data-mime-type") || "application/octet-stream";
      if (mediaPath === null) continue;

      const content = this.fileContent;
      if (content?.kind !== "loaded" || !content.binary) continue;

      try {
        const bytes = base64ToBytes(content.content);
        const blob = new Blob([bytes], { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);
        this.blobUrls.add(blobUrl);

        if (mediaEl instanceof HTMLVideoElement) {
          mediaEl.src = blobUrl;
        } else if (mediaEl instanceof HTMLImageElement) {
          mediaEl.src = blobUrl;
        }
      } catch (error) {
        mediaEl.outerHTML = `<div class="status error"><strong>Failed to load media.</strong><pre>${escapeHtml(String(error))}</pre></div>`;
      }
    }
  }

  /** Load asciinema-player CSS and JS. CSS goes into the shadow root so it can reach the player elements. */
  loadAsciinemaPlayerAssets() {
    const root = this.root;
    if (root.querySelector('link[data-pow-asciinema-css]') === null) {
      const link = document.createElement("link");
      link.setAttribute("data-pow-asciinema-css", "");
      link.rel = "stylesheet";
      link.href = import.meta.resolve
        ? import.meta.resolve("./vendor/asciinema-player.css")
        : "./vendor/asciinema-player.css";
      root.prepend(link);
    }
    if (document.querySelector('script[data-pow-asciinema-js]') === null && typeof AsciinemaPlayer === "undefined") {
      const script = document.createElement("script");
      script.setAttribute("data-pow-asciinema-js", "");
      script.src = import.meta.resolve
        ? import.meta.resolve("./vendor/asciinema-player.min.js")
        : "./vendor/asciinema-player.min.js";
      script.async = true;
      script.onerror = () => {
        script.remove();
        this.asciinemaLoadError = true;
        this.renderAll();
      };
      document.head.append(script);
    }
  }

  destroyPlayers() {
    for (const { element, instance } of this.playerInstances) {
      try {
        if (instance && typeof instance.dispose === "function") instance.dispose();
      } catch {
        // Ignore dispose errors
      }
    }
    this.playerInstances = [];

    for (const blobUrl of this.blobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.blobUrls.clear();
  }

  disconnectedCallback() {
    this.destroyPlayers();
  }
}

function requiredRegion(root, selector) {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`proof-of-work panel shell is missing ${selector}`);
  return element;
}

function contextKey(context) {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function fileName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function renderErrorState(message, detail) {
  return `<div class="status error"><strong>${escapeHtml(message)}</strong><pre>${escapeHtml(detail)}</pre></div>`;
}

function refreshIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 6v5h-5"></path>
      <path d="M4 18v-5h5"></path>
      <path d="M18.2 9A7 7 0 0 0 6.1 6.8L4 9"></path>
      <path d="M5.8 15a7 7 0 0 0 12.1 2.2L20 15"></path>
    </svg>
  `;
}

const TRACE_VIEWER_PORT = 9323;

/** Join a workspace root and a workspace-relative path into an absolute path. */
function joinWorkspacePath(workspacePath, filePath) {
  if (filePath.startsWith("/")) return filePath;
  return `${workspacePath.replace(/\/+$/, "")}/${filePath}`;
}

/** Quote a value for safe embedding inside a double-quoted POSIX shell string. */
function shellQuote(value) {
  return `"${String(value).replace(/[$`\\"]/g, "\\$&")}"`;
}

/**
 * Build a `playwright show-trace` command that locates the CLI (global PATH
 * first, then a pruned workspace search) and serves the viewer plus trace over
 * HTTP on the given port.
 */
function showTraceCommand({ port, tracePath }) {
  return [
    `PORT=${port}`,
    `TRACE=${shellQuote(tracePath)}`,
    "if command -v playwright >/dev/null 2>&1; then",
    `  PW="playwright"`,
    "else",
    `  PW="$(find . \( -name .pnpm -o -name .git -o -name proof-of-work \) -prune -o \( -type f -o -type l \) -path '*/node_modules/.bin/playwright' -print -quit 2>/dev/null)"`,
    "fi",
    `if [ -z "$PW" ]; then echo "ERROR: playwright CLI not found in this workspace (is @belayd/dashboard-spa installed?)"; exit 1; fi`,
    `"$PW" show-trace --port "$PORT" "$TRACE"`,
  ].join("\n");
}

/** Decode a base64 string into a Uint8Array. */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function fileIcon(ext) {
  switch (ext) {
    case ".cast": return "▶";
    case ".webm": return "🎬";
    case ".zip": return "🔎";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif": return "🖼";
    case ".md": return "📝";
    case ".patch": return "🔧";
    case ".txt":
    case ".log": return "📄";
    default: return "📄";
  }
}

function proofStyles() {
  return `
    <style>
      :host { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
      .toolbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
      .toolbar[hidden] { display: none; }
      .toolbar-actions { display: inline-flex; align-items: center; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; min-width: 0; }
      .panel-layout { flex: 1 1 auto; display: flex; flex-direction: row; min-height: 0; }
      .sidebar { flex: 0 0 260px; display: flex; flex-direction: column; overflow-y: auto; border-right: 1px solid var(--pi-border-muted); padding: 8px; }
      .viewer { flex: 1 1 auto; box-sizing: border-box; display: grid; align-content: start; gap: 12px; min-height: 0; overflow: auto; padding: 12px; }
      .viewer > * { box-sizing: border-box; min-width: 0; max-width: 100%; }
      button { border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); font: inherit; cursor: pointer; }
      button.icon-button { flex: 0 0 auto; display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; }
      button.icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
      .task-list { display: flex; flex-direction: column; gap: 2px; }
      .task-item { display: flex; flex-direction: column; }
      .task-toggle { display: flex; align-items: center; gap: 4px; width: 100%; padding: 6px 8px; text-align: left; border: 1px solid transparent; background: transparent; font-weight: 500; }
      .task-toggle:hover { background: var(--pi-surface-hover); border-color: var(--pi-border); }
      .task-item.selected > .task-toggle { background: var(--pi-accent); color: var(--pi-bg); border-color: var(--pi-accent-border); }
      .chevron { width: 14px; height: 14px; flex-shrink: 0; transition: transform 0.15s; }
      .task-toggle[aria-expanded="true"] .chevron { transform: rotate(90deg); }
      .task-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .file-list { display: none; flex-direction: column; gap: 1px; padding-left: 12px; }
      .file-list.expanded { display: flex; }
      .file-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; text-align: left; border: 1px solid transparent; background: transparent; font-size: 12px; }
      .file-item:hover { background: var(--pi-surface-hover); border-color: var(--pi-border); }
      .file-item.selected { background: var(--pi-accent); color: var(--pi-bg); border-color: var(--pi-accent-border); }
      .file-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 12px; }
      .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      code, pre { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      code { padding: 2px 5px; }
      pre { margin: 0; overflow: auto; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
      pre.document { white-space: pre-wrap; overflow-wrap: anywhere; }
      .document.markdown { line-height: 1.5; overflow-wrap: anywhere; }
      .document.markdown p, .document.markdown ul, .document.markdown ol, .document.markdown pre, .document.markdown blockquote, .document.markdown .table-scroll { margin: 0 0 10px; }
      .document.markdown > :last-child { margin-bottom: 0; }
      .document.markdown h1, .document.markdown h2, .document.markdown h3, .document.markdown h4 { line-height: 1.25; margin: 14px 0 8px; }
      .document.markdown h1:first-child, .document.markdown h2:first-child, .document.markdown h3:first-child, .document.markdown h4:first-child { margin-top: 0; }
      .document.markdown h1 { font-size: 18px; }
      .document.markdown h2 { font-size: 16px; }
      .document.markdown h3 { font-size: 14px; }
      .document.markdown h4 { font-size: 13px; }
      .document.markdown ul, .document.markdown ol { padding-left: 22px; }
      .document.markdown li + li { margin-top: 3px; }
      .document.markdown pre { white-space: pre; overflow-wrap: normal; }
      .document.markdown pre code { border: 0; background: transparent; padding: 0; }
      .document.markdown img { box-sizing: border-box; max-width: 100%; }
      .document.markdown blockquote { border-left: 3px solid var(--pi-border-muted); color: var(--pi-muted); padding-left: 10px; }
      .document.markdown a { color: var(--pi-accent); }
      .document.markdown .table-scroll { max-width: 100%; overflow-x: auto; }
      .document.markdown table { border-collapse: collapse; overflow-wrap: normal; }
      .document.markdown th, .document.markdown td { border: 1px solid var(--pi-border-muted); padding: 4px 8px; }
      .status pre { margin-top: 8px; }
      .muted { color: var(--pi-muted); }
      .small { font-size: 11px; }
      .empty-state { border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
      .empty-state p { margin: 6px 0 0; }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.info { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      .empty { padding: 16px; color: var(--pi-muted); }
      .cast-player { min-height: 200px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-bg); }
      .cast-player .status { margin: 8px; }
      .proof-media { max-width: 100%; border-radius: 8px; }
      video.proof-media { max-height: 80vh; }
      .trace-artifact { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--pi-border-muted); border-radius: 8px; padding: 12px; }
      .trace-artifact-copy strong { display: block; margin-bottom: 4px; }
      .trace-artifact-copy .muted { margin: 0; }
      .open-trace { align-self: flex-start; padding: 6px 12px; }
      .muted.small { font-size: 11px; padding: 4px 0; }

      /* Mobile: single column */
      @media (max-width: 600px) {
        .panel-layout { flex-direction: column; }
        .sidebar { flex: 0 0 auto; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--pi-border-muted); }
      }
    </style>
  `;
}