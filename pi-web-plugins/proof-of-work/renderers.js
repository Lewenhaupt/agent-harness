import { marked } from "./vendor/marked.esm.js";
import { getFileExtension } from "./discovery.js";

const MAX_MARKDOWN_CACHE_ENTRIES = 300;
const markdownHtmlCache = new Map();

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = ({ text }) => escapeHtml(text);

/** Render markdown content to sanitized HTML safe for innerHTML. */
export function renderMarkdown(content) {
  const cached = markdownHtmlCache.get(content);
  if (cached !== undefined) return cached;
  const html = marked.parse(content, { async: false, breaks: true, gfm: true, renderer: markdownRenderer });
  const safeHtml = sanitizeHtml(html);
  markdownHtmlCache.set(content, safeHtml);
  if (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (oldest !== undefined) markdownHtmlCache.delete(oldest);
  }
  return safeHtml;
}

/** Render plain text inside a pre block with HTML escaping. */
export function renderPlainText(content) {
  return `<pre class="document">${escapeHtml(content)}</pre>`;
}

/** Render a placeholder div for asciinema-player post-render initialization. */
export function renderCastPlaceholder(filePath) {
  return `<div class="cast-player" data-cast-path="${escapeAttr(filePath)}"><p class="muted">Loading asciinema player…</p></div>`;
}

/** Render a placeholder for an image or video file. */
export function renderMediaPlaceholder(filePath, mimeType) {
  const type = mimeType.startsWith("video/") ? "video" : "img";
  const attrs = `class="proof-media" data-media-path="${escapeAttr(filePath)}" data-mime-type="${escapeAttr(mimeType)}"`;
  if (type === "video") {
    return `<video ${attrs} controls><p class="muted">Loading ${escapeHtml(mimeType)}…</p></video>`;
  }
  return `<${type} ${attrs}><p class="muted">Loading ${escapeHtml(mimeType)}…</p></${type}>`;
}

/** Render a Playwright trace (.trace.zip) as an "open in viewer" action. */
export function renderTracePlaceholder(filePath) {
  return `
    <div class="trace-artifact">
      <div class="trace-artifact-copy">
        <strong>Playwright trace</strong>
        <p class="muted">Step through DOM snapshots before/after every action, scrub the screencast film strip, and inspect network, console, and source. Starts paused, so short tests are easy to follow.</p>
      </div>
      <button class="open-trace" data-open-trace="${escapeAttr(filePath)}">Open in Trace Viewer</button>
    </div>
  `;
}

/** Dispatch rendering based on file extension and properties. Never throws. */
export function renderFileContent(filePath, fileContent, binary, truncated) {
  const ext = getFileExtension(filePath);
  const truncation = truncated
    ? `<div class="status info">File truncated — only the beginning is shown.</div>`
    : "";

  if (isCastFile(ext)) {
    return `${truncation}${renderCastPlaceholder(filePath)}`;
  }

  if (isVideoFile(ext)) {
    return `${truncation}${renderMediaPlaceholder(filePath, mediaMimeType(ext))}`;
  }

  if (isImageFile(ext)) {
    return `${truncation}${renderMediaPlaceholder(filePath, mediaMimeType(ext))}`;
  }

  if (isTraceFile(ext)) {
    return `${truncation}${renderTracePlaceholder(filePath)}`;
  }

  if (binary) {
    return `<div class="empty-state"><strong>Binary file: ${escapeHtml(fileName(filePath))}</strong><p>This file has no text preview.</p></div>`;
  }

  if (isMarkdownPath(ext)) {
    return `${truncation}<div class="document markdown">${renderMarkdown(fileContent)}</div>`;
  }

  // Default to plain text for .patch, .txt, .log, and unknown extensions
  return `${truncation}${renderPlainText(fileContent)}`;
}

/** Check if the extension indicates a markdown file. */
export function isMarkdownPath(ext) {
  return ext === ".md";
}

/** Check if the extension indicates an asciinema cast file. */
export function isCastFile(ext) {
  return ext === ".cast";
}

/** Check if the extension indicates a video file. */
export function isVideoFile(ext) {
  return ext === ".webm";
}

/** Check if the extension indicates a Playwright trace archive. */
export function isTraceFile(ext) {
  return ext === ".zip";
}

/** Check if the extension indicates an image file. */
export function isImageFile(ext) {
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif";
}

/** Return the MIME type for a known media extension. */
export function mediaMimeType(ext) {
  switch (ext) {
    case ".webm": return "video/webm";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
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

const TABLE_SCROLL_CLASS = "table-scroll";

function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => {
    node.remove();
  });
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  });
  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
}

function wrapTablesInScrollRegions(root) {
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains(TABLE_SCROLL_CLASS) === true) return;
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Table");
    wrapper.setAttribute("tabindex", "0");
    table.before(wrapper);
    wrapper.append(table);
  });
}

function isSafeUrl(url) {
  if (url.startsWith("#") || url.startsWith("/")) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}