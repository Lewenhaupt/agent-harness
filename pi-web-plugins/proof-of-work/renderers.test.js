import { describe, expect, it } from "vitest";
import {
  isImageFile,
  mediaMimeType,
  renderMediaLoadError,
  renderMediaPlaceholder,
} from "./renderers.js";

/**
 * Plain-JS vitest coverage for the proof-of-work renderer helpers.
 *
 * renderers.js is safe to import directly: it has no top-level DOM access
 * (`marked` only runs inside `renderMarkdown`, and `sanitizeHtml` only runs
 * when markdown is rendered). These tests exercise the pure helper functions.
 */

describe("isImageFile", () => {
  it.each([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"])(
    "accepts %s",
    (ext) => {
      expect(isImageFile(ext)).toBe(true);
    },
  );

  it.each([".webm", ".cast", ".md", ".pdf", ".svg", ".txt", ""])(
    "rejects %s",
    (ext) => {
      expect(isImageFile(ext)).toBe(false);
    },
  );
});

describe("mediaMimeType", () => {
  it.each([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".bmp", "image/bmp"],
    [".ico", "image/x-icon"],
    [".avif", "image/avif"],
    [".webm", "video/webm"],
  ])("maps %s to %s", (ext, mimeType) => {
    expect(mediaMimeType(ext)).toBe(mimeType);
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mediaMimeType(".xyz")).toBe("application/octet-stream");
  });
});

describe("renderMediaPlaceholder", () => {
  it("renders a bare img element with alt and data attributes", () => {
    const html = renderMediaPlaceholder("proof-of-work/TASK-1/screenshot.png", "image/png");

    expect(html).toContain("<img");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("</img>");
    expect(html).not.toContain("Loading");
    expect(html).toContain('alt="screenshot.png"');
    expect(html).toContain('data-media-path="proof-of-work/TASK-1/screenshot.png"');
    expect(html).toContain('data-mime-type="image/png"');
  });

  it("renders a bare video element with controls and no stray child", () => {
    const html = renderMediaPlaceholder("proof-of-work/TASK-1/demo.webm", "video/webm");

    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain("></video>");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("Loading");
  });

  it("escapes double quotes in attributes", () => {
    const html = renderMediaPlaceholder('proof-of-work/TASK-1/a"b.png', "image/png");

    expect(html).toContain('data-media-path="proof-of-work/TASK-1/a&quot;b.png"');
    expect(html).toContain('alt="a&quot;b.png"');
  });
});

describe("renderMediaLoadError", () => {
  it("emits an error status with the filename and MIME type", () => {
    const html = renderMediaLoadError("proof-of-work/TASK-1/screenshot.png", "image/png");

    expect(html).toContain('class="status error"');
    expect(html).toContain("Could not load media preview.");
    expect(html).toContain("screenshot.png (image/png)");
  });
});
