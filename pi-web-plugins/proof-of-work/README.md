# Proof of Work Viewer — pi-web Plugin

A workspace panel for pi-web that renders verifiable-proof artifacts from `proof-of-work/<task-id>/` directories. Supports Playwright traces (`.trace.zip`), terminal recordings (`.cast`), screenshots (`.png`/`.jpg`/`.gif`), rendered markdown (`.md`), plain text (`.patch`, `.txt`, `.log`), and legacy browser videos (`.webm`).

---

## How to Verify

Follow these steps to confirm the plugin is correctly installed and functioning.

### 1. Set up the symlink

```bash
ln -sf "$PWD/pi-web-plugins/proof-of-work" ~/.pi-web/plugins/proof-of-work
```

Verify the symlink target:

```bash
readlink -f ~/.pi-web/plugins/proof-of-work
# Expected: <path-to-repo>/pi-web-plugins/proof-of-work
```

### 2. Create test proof-of-work artifacts

Create a full set of demo artifacts under a workspace that pi-web has open:

```bash
WORKSPACE_DIR="/path/to/a-workspace-connected-to-pi-web"
mkdir -p "$WORKSPACE_DIR/proof-of-work/TASK-1"
cd "$WORKSPACE_DIR/proof-of-work/TASK-1"

# --- Terminal recording (.cast) — minimal valid asciinema file ---
cat > demo.cast << 'EOF'
{"version": 3, "command": "echo hello", "width": 80, "height": 24}
[0.1, "o", "hello world\r\n"]
[0.2, "x", "0"]
EOF

# --- Markdown notes (.md) ---
cat > notes.md << 'EOF'
# TASK-1 Proof Artifacts

This **markdown** document demonstrates rendering:

- Bullet lists
- `inline code`
- [Example link](https://example.com)

## Section Heading

| Key | Value |
|-----|-------|
| Task | TASK-1 |
| Status | Verified |
EOF

# --- Plain text files (.txt, .log, .patch) ---
cat > output.log << 'EOF'
[2026-03-21T10:00:00Z] Starting verification
[2026-03-21T10:00:01Z] All checks passed
[2026-03-21T10:00:02Z] Exiting
EOF

cat > changes.patch << 'EOF'
diff --git a/src/main.ts b/src/main.ts
index abc..def 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 console.log("hello");
+console.log("world");
EOF

echo "Build complete — 0 errors, 0 warnings." > build-summary.txt

# --- Screenshot (.png) — valid 1x1 pixel PNG ---
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > screenshot.png

# --- Browser video (.webm) — leave empty for now (see note below) ---
# Real .webm files come from Playwright E2E runs. A zero-byte file will
# show the "Binary file" fallback state, which is expected for this test.
touch demo.webm

echo "Test artifacts created in $WORKSPACE_DIR/proof-of-work/TASK-1/"
```

### 3. Open the panel and verify each file type

1. Open pi-web in a browser (default: `http://127.0.0.1:8504`).
2. Select the workspace that contains the `proof-of-work/` directory from step 2.
3. In the workspace panel area (the left-hand column with Files, Git, Terminal tabs), look for the **Proof of Work** tab (shield badge icon). Click it.
   - If the tab is not visible, press `Ctrl+K` / `Cmd+K` to open the action palette and type **"Open Proof of Work"**, then press Enter.
4. The panel shows a two-pane layout:
   - **Left sidebar:** lists task directories under `proof-of-work/`.
   - **Right viewer:** renders the selected file.

**Expected behavior for each file:**

| Click this file… | … and the viewer should show |
|---|---|
| `demo.cast` | Asciinema-player terminal widget with play/pause controls, fitted to panel width |
| `notes.md` | Rendered HTML: heading, bold text, bullet list, inline code, link, table |
| `output.log` | Preformatted text in a monospace `<pre>` block with word-wrap |
| `changes.patch` | Same as above — preformatted monospace text with word-wrap |
| `build-summary.txt` | Same — plain text in a `<pre>` block |
| `screenshot.png` | Inline image scaled to fit panel width |
| `demo.webm` | HTML5 `<video>` element with native controls (play, pause, volume, fullscreen); or a "Binary file: demo.webm — This file has no text preview." message if the file is empty/corrupt |

### 4. Verify empty state

| Scenario | Expected message |
|---|---|
| No `proof-of-work/` directory exists in the workspace | *"No proof-of-work artifacts in this workspace. Proof artifacts live in `proof-of-work/<task-id>/`."* |
| `proof-of-work/` exists but is empty | *"No artifacts found."* (sidebar) / *"No proof-of-work artifacts in this workspace."* (viewer) |
| `proof-of-work/TASK-1/` exists but has no files | Expand TASK-1 → *"No files."* (sidebar); viewer shows *"This task has no files."* |
| No workspace is selected | *"Select a workspace to view proof artifacts."* |

To test the empty-task scenario:

```bash
mkdir -p "$WORKSPACE_DIR/proof-of-work/EMPTY-TASK"
# Then click the Refresh button (↻) in the panel toolbar
```

### 5. Verify the Refresh button

1. With the panel open and TASK-1 visible, add a new file:
   ```bash
   echo "new artifact" > "$WORKSPACE_DIR/proof-of-work/TASK-1/new-file.txt"
   ```
2. Click the ↻ **Refresh** button in the panel toolbar.
3. `new-file.txt` appears in the file list under TASK-1.

### 6. Verify asciinema-player asset loading

1. Open browser Developer Tools (F12) → Network tab.
2. Filter for `asciinema-player`.
3. Select a workspace with a `.cast` file and click it.
4. Confirm two requests appear:
   - `asciinema-player.css`
   - `asciinema-player.min.js`
5. Both should load from the plugin's `vendor/` directory with HTTP 200.

If the script fails to load, the viewer shows: *"Asciinema player failed to load. Cast recordings cannot be played."*

### 7. Verify workspace-switch cleanup

1. Open a workspace that has artifacts and play a `.cast` recording.
2. Switch to a different workspace (without artifacts).
3. Switch back to the first workspace.
4. The panel re-scans and restores its state. Old player instances and blob URLs are disposed (check via DevTools → Performance → Memory for no leaks).

---

## How to Use

### Installation

**Option A — Symlink (recommended for development):**

```bash
mkdir -p ~/.pi-web/plugins
ln -sf /absolute/path/to/pi-web-plugins/proof-of-work ~/.pi-web/plugins/proof-of-work
```

No server restart needed. The plugin is discovered automatically on the next browser page load.

**Option B — pi package (via `pi install`):**

If the plugin has been published as a pi package by running `pi package create` inside the plugin directory, it can be installed with:

```bash
pi install proof-of-work
```

**Verification:**

```bash
curl http://127.0.0.1:8504/pi-web-plugins/manifest.json | jq '.plugins[] | select(.id == "proof-of-work")'
```

Expected output includes:

```json
{
  "id": "proof-of-work",
  "module": "/pi-web-plugins/proof-of-work/pi-web-plugin.js?v=...",
  "source": "local",
  ...
}
```

**Uninstallation:**

```bash
rm -rf ~/.pi-web/plugins/proof-of-work
```

Then hard-reload the browser tab (`Cmd+Shift+R` or `Ctrl+Shift+R`).

### Access

The panel can be opened in two ways:

| Method | Steps |
|---|---|
| Workspace tab | Select a workspace → click the **Proof of Work** tab (shield icon) in the left panel area |
| Action palette | Press `Ctrl+K` / `Cmd+K` → type **"Open Proof of Work"** → press Enter |

The action is only available when a workspace is selected.

### Supported formats

| Extension | Renderer | Notes |
|---|---|---|
| `.cast` | [asciinema-player](https://github.com/asciinema/asciinema-player) — terminal playback with play/pause, speed control, resize | Loaded from `vendor/asciinema-player.min.js`. Configured with `fit: "width"`, `terminalFontSize: "small"` |
| `.trace.zip`, `.zip` | **Open in Trace Viewer** button | Starts `playwright show-trace` in a workspace terminal and opens the local Trace Viewer (DOM snapshots, scrubbable screencast, network, console) |
| `.webm` (legacy) | Native HTML5 `<video>` with controls | Play, pause, volume, fullscreen. Codec support depends on browser (VP8/VP9) |
| `.png`, `.jpg`, `.jpeg` | Inline `<img>` | Scaled to panel width; respects aspect ratio |
| `.gif` | Inline `<img>` | Animated GIFs play in-browser |
| `.md` | [marked](https://marked.js.org/) → sanitized HTML | GFM tables, autolinks, task lists. Script tags and `on*` attributes are stripped |
| `.txt`, `.log`, `.patch` | `<pre class="document">` — monospace, word-wrap | Lines wrap with `overflow-wrap: anywhere` |
| Any other binary | "Binary file: \<name\> — This file has no text preview." | Fallback for unsupported extensions |

### How artifacts are created

Proof artifacts are generated by agents using the **verifiable-proof** skill:

| Modality | Tool | Command example |
|---|---|---|
| Terminal recording (`.cast`) | `asciinema rec` | `asciinema rec proof-of-work/TASK-42/demo.cast` |
| Browser trace (`.trace.zip`) | Playwright E2E tests with `BELAYD_PROOF=1` | `BELAYD_PROOF=1 pnpm test:playwright` |
| Screenshot (`.png`/`.jpg`) | playwright-cli | `playwright-cli open URL → screenshot path.png` |

Full details: `.agents/skills/verifiable-proof/SKILL.md`

### Directory structure

Proof artifacts live under the workspace root in this layout:

```
<workspace-root>/
├── proof-of-work/
│   ├── TASK-42/
│   │   ├── e2e-video.webm
│   │   ├── cli-demo.cast
│   │   └── dashboard-state.png
│   ├── TASK-43/
│   │   ├── test-run.cast
│   │   └── notes.md
│   └── TASK-1/
│       └── ...
└── ...
```

- Each subdirectory is named after a task ID.
- Files inside are arbitrary — the plugin detects them by extension.
- The `proof-of-work/` directory is gitignored; artifacts are ephemeral.

### Troubleshooting

#### "Asciinema player not loaded"

The viewer shows *"Asciinema player failed to load"* or *"Asciinema player not loaded."*

| Possible cause | Fix |
|---|---|
| `vendor/asciinema-player.min.js` or `.css` files are missing | Restore them: `git checkout -- pi-web-plugins/proof-of-work/vendor/` |
| Script failed to download | Hard-reload the page (`Cmd+Shift+R`). Check the Network tab for the two `asciinema-player` requests |
| Ad blocker / CSP restriction | Open in an incognito window or disable extensions temporarily |
| Browser cache serves stale manifest | Hard-reload: `Cmd+Shift+R` or `Ctrl+Shift+R` |

#### "No artifacts found"

The viewer shows the empty-state message.

- Ensure a `proof-of-work/` directory exists at the **workspace root** (not inside a subdirectory).
- Ensure at least one task subdirectory exists: `proof-of-work/<task-id>/`.
- Click the ↻ Refresh button to re-scan.
- Verify the workspace has a `proof-of-work/` directory you can see in the Files tab.

#### "Binary file — no preview"

The selected file has an extension that is not in the supported list (`.cast`, `.webm`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.md`, `.txt`, `.log`, `.patch`), OR it is a binary file with a supported extension that could not be loaded as text.

- For unsupported binary files: rename to a supported extension or add a companion markdown note.
- For text files with binary content: check that the file is not corrupt.

#### Asciinema player shows "Loading…" indefinitely

The `.cast` data may not have loaded correctly.

- Is the file valid JSON? Test: `head -1 demo.cast | jq .`
- Does the JSON header contain `"version": 3`?
- Check the browser console for blob URL errors.

#### Refresh does not show new files

The panel does not auto-poll. Always click the ↻ button to trigger a re-scan. Alternatively, switch to a different workspace and back.

#### Markdown renders incorrectly

The plugin uses **marked** with `gfm: true` and `breaks: true`. If your markdown looks different from GitHub:

- Raw HTML inside markdown is **stripped** (except safe `href` and `src` values, and anchor `#` fragments).
- Script tags, `onclick`, `onerror`, `<iframe>`, `<embed>`, `<object>`, `<style>` are removed by the sanitizer.
- Links open in a new tab with `rel="noreferrer noopener"`.

#### Panel content does not update after selecting a different workspace

The panel uses a context key (`machine.id` + `workspace.projectId` + `workspace.id`) to detect workspace changes. If pi-web reuses the same workspace object (e.g., reconnecting to the same machine), the panel skips a re-scan. Click refresh to force a scan.

#### The Proof of Work tab does not appear

- Check that the plugin is enabled in **Settings → PI WEB plugins**.
- Hard-reload the browser (`Cmd+Shift+R`).
- Verify the manifest: `curl http://127.0.0.1:8504/pi-web-plugins/manifest.json | jq '.plugins[] | select(.id == "proof-of-work")'`.

### Internals overview

The plugin is a plain JavaScript ES module with no build step. It consists of four modules:

| File | Responsibility |
|---|---|
| `pi-web-plugin.js` | Plugin metadata and `activate()` — registers the workspace panel and the "Open Proof of Work" action |
| `discovery.js` | File I/O helpers — `listTaskDirs()`, `listTaskFiles()`, `readProofFile()`, `getFileExtension()` |
| `panel.js` | Custom element `<pi-web-proof-work-panel>` — all UI, state management, player lifecycle |
| `renderers.js` | Content rendering — `renderFileContent()`, markdown via **marked**, media placeholders |
| `vendor/` | Third-party dependencies — asciinema-player (CSS + JS), `marked.esm.js` |

Async operations are guarded by a monotonic `scanToken` counter that prevents stale responses from overwriting newer state. Binary media content is passed through blob URLs that are tracked and revoked on cleanup.

### Related documentation

- [Verifiable Proof Artifacts — Agent Guide](../../.agents/skills/verifiable-proof/SKILL.md) — how agents generate proof artifacts
- [Verifiable Proof Artifacts — Viewer Guide](../../docs/VERIFIABLE_PROOF.md) — how to replay/view artifacts outside pi-web
- [pi-web Plugins API](../../node_modules/@jmfederico/pi-web/docs/plugins.md) — pi-web plugin API reference
