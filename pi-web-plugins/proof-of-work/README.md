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

### 2. Run a phase tool and verify the proof bridge

In the workspace selected by pi-web, start or resume a task and run a phase
tool (for example, `belayd_plan`) so the harness calls `ensureProofBridge()`.
Use a phase tool with a current task ID; merely opening the panel does not create
the bridge. After the tool has run, inspect both bridge artifacts from a
terminal:

```bash
WORKSPACE_DIR="/path/to/the-workspace"
PROOF_BASE="${BELAYD_PROOF_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/belayd/proof}"
EXPECTED_BASE="$(realpath "$PROOF_BASE")"

# The marker is one absolute path followed by a newline.
test -f "$WORKSPACE_DIR/.belayd/proof-dir"
test "$(wc -l < "$WORKSPACE_DIR/.belayd/proof-dir")" -eq 1
grep -Fx "$EXPECTED_BASE" "$WORKSPACE_DIR/.belayd/proof-dir"
test "$(tail -c 1 "$WORKSPACE_DIR/.belayd/proof-dir" | od -An -t x1 | tr -d '[:space:]')" = "0a"

# The symlink remains available to terminal and agent commands.
test -L "$WORKSPACE_DIR/proof-of-work"
test "$(readlink -f "$WORKSPACE_DIR/proof-of-work")" = "$EXPECTED_BASE"
```

The marker path is `<workspace>/.belayd/proof-dir`; its content must be the
expanded absolute base, such as `/home/alice/.local/state/belayd/proof`, not a
workspace-relative path. The `proof-of-work` symlink and marker are gitignored.

### 3. Allow pi-web to read the external proof base

The panel reads artifacts from the external proof base by absolute path, so that
path must be listed in pi-web's allowed filesystem roots. Add it to the global
pi-web config (or the project `<workspace>/.pi-web/config.json`):

```json
{ "pathAccess": { "allowedPaths": ["~/.local/state/belayd/proof"] } }
```

If you set `BELAYD_PROOF_DIR`, list that path instead. Without this entry the
panel shows: *"Could not access the proof-of-work directory."*

### 4. Create test proof-of-work artifacts

Create a full set of demo artifacts in the external proof base. This step
must write under `$PROOF_BASE/<task-id>/...`, not under
`$WORKSPACE_DIR/proof-of-work/TASK-1/...`; the latter is only the
terminal/agent symlink view of the external directory.

```bash
PROOF_BASE="${BELAYD_PROOF_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/belayd/proof}"
mkdir -p "$PROOF_BASE/TASK-1"
cd "$PROOF_BASE/TASK-1"

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

echo "Test artifacts created in $PROOF_BASE/TASK-1/"
```

### 5. Open the panel and verify each file type

1. Open pi-web in a browser (default: `http://127.0.0.1:8504`).
2. Select the workspace whose proof base was configured in step 3.
3. In the workspace panel area (the left-hand column with Files, Git, Terminal tabs), look for the **Proof of Work** tab (shield badge icon). Click it.
   - If the tab is not visible, press `Ctrl+K` / `Cmd+K` to open the action palette and type **"Open Proof of Work"**, then press Enter.
4. The panel shows a two-pane layout:
   - **Left sidebar:** lists task directories under the logical `proof-of-work/` root.
   - **Right viewer:** renders the selected file.

Confirm that `TASK-1` and its files appear. The files must have been created at
`$PROOF_BASE/TASK-1/...` in step 4, not at
`$WORKSPACE_DIR/proof-of-work/TASK-1/...`; the panel reports the external files
through the logical `proof-of-work/<task-id>/...` layout.

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

### 6. Verify denied external access

Temporarily remove the proof base from every `pathAccess.allowedPaths` list that
could apply (global and project config), or point the marker at a base that is
not listed. Save the config and click ↻ **Refresh**; `pathAccess` is applied on
the next file request, and a browser refresh can be used if the existing view
is stale.

Expected result: the panel shows the exact error title **"Could not access the
proof-of-work directory."** and this exact guidance:
> Add the proof base directory to pi-web's **External filesystem roots**
> (`pathAccess.allowedPaths` in the global pi-web config or
> `<workspace>/.pi-web/config.json`), then refresh.

It must not silently show an empty artifact list. Restore the allowed path before continuing.

### 7. Verify legacy workspace-relative fallback

Use a separate workspace that has no `.belayd/proof-dir` marker and has a real
(non-symlink) `proof-of-work/` directory. Do not run a phase tool in this
workspace while testing the fallback.

```bash
LEGACY_WORKSPACE="/path/to/legacy-workspace"
rm -f "$LEGACY_WORKSPACE/.belayd/proof-dir"
mkdir -p "$LEGACY_WORKSPACE/proof-of-work/LEGACY-1"
printf 'legacy artifact\n' > "$LEGACY_WORKSPACE/proof-of-work/LEGACY-1/artifact.txt"
test -d "$LEGACY_WORKSPACE/proof-of-work"
test ! -L "$LEGACY_WORKSPACE/proof-of-work"
```

Select that workspace in pi-web and open the Proof of Work panel. It must list
`LEGACY-1/artifact.txt` from the workspace-relative `proof-of-work/` directory,
without a marker or an external `allowedPaths` entry.

### 8. Verify empty state

| Scenario | Expected message |
|---|---|
| No proof artifacts exist for the workspace | *"No proof-of-work artifacts in this workspace. Proof artifacts live outside the workspace in the external proof base, presented as `proof-of-work/<task-id>/`."* |
| The proof base exists but is empty | *"No artifacts found."* (sidebar) / *"No proof-of-work artifacts in this workspace."* (viewer) |
| `TASK-1/` exists but has no files | Expand TASK-1 → *"No files."* (sidebar); viewer shows *"This task has no files."* |
| No workspace is selected | *"Select a workspace to view proof artifacts."* |

To test the empty-task scenario:

```bash
mkdir -p "$PROOF_BASE/EMPTY-TASK"
# Then click the Refresh button (↻) in the panel toolbar
```

### 9. Verify the Refresh button

1. With the panel open and TASK-1 visible, add a new file:
   ```bash
   echo "new artifact" > "$PROOF_BASE/TASK-1/new-file.txt"
   ```
2. Click the ↻ **Refresh** button in the panel toolbar.
3. `new-file.txt` appears in the file list under TASK-1.

### 10. Verify asciinema-player asset loading

1. Open browser Developer Tools (F12) → Network tab.
2. Filter for `asciinema-player`.
3. Select a workspace with a `.cast` file and click it.
4. Confirm two requests appear:
   - `asciinema-player.css`
   - `asciinema-player.min.js`
5. Both should load from the plugin's `vendor/` directory with HTTP 200.

If the script fails to load, the viewer shows: *"Asciinema player failed to load. Cast recordings cannot be played."*

### 11. Verify workspace-switch cleanup

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

### Proof location and access

The harness resolves the external proof base in this order:

1. A non-empty `BELAYD_PROOF_DIR` value.
2. `${XDG_STATE_HOME}/belayd/proof` when `XDG_STATE_HOME` is set.
3. `~/.local/state/belayd/proof` otherwise.

After a phase tool runs, `ensureProofBridge()` writes the resolved absolute base
(one line plus a trailing newline) to `<workspace>/.belayd/proof-dir`. It also
keeps `<workspace>/proof-of-work` as a symlink to that base for terminal and
agent use. The plugin reads the marker because browser code cannot read the
harness process environment.

For the external viewer to work, both conditions are required:

- the workspace must have the marker written by the harness; and
- the resolved external base must be listed in pi-web's
  `pathAccess.allowedPaths` under **External filesystem roots** (in the global
  config or `<workspace>/.pi-web/config.json`).

An allowed path change applies on the next file request; click ↻ **Refresh** or
reload the browser tab. If the marker is absent, the plugin instead uses the
legacy workspace-relative `proof-of-work/` directory. Artifacts are therefore
reported logically as `proof-of-work/<task-id>/...`, while external-mode files
are physically stored at `<proof-base>/<task-id>/...` outside the workspace.

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

The `proof-of-work/...` command is intentionally a terminal/agent example: the
symlink resolves it to the external base. When creating manual viewer fixtures,
write to the external `$PROOF_BASE/<task-id>/...` path as shown in How to Verify.

### Directory structure

Proof artifacts live outside the workspace under the external proof base
(`${BELAYD_PROOF_DIR:-${XDG_STATE_HOME:-~/.local/state}/belayd/proof}`):

```
<external-proof-base>/
├── TASK-42/
│   ├── e2e-video.webm
│   ├── cli-demo.cast
│   └── dashboard-state.png
├── TASK-43/
│   ├── test-run.cast
│   └── notes.md
└── TASK-1/
    └── ...
```

The workspace only holds two bridge artifacts:

```
<workspace-root>/
├── proof-of-work -> <external-proof-base>   # symlink — terminal/agent use ONLY (NOT readable by the panel)
└── .belayd/
    └── proof-dir                            # marker file carrying the absolute proof base
```

- Each subdirectory is named after a task ID.
- Files inside are arbitrary — the plugin detects them by extension.
- The `proof-of-work/` symlink is for terminals and agents. pi-web's browser
  file API rejects it (realpath + workspace-boundary checks), so the panel never
  reads through it — it reads the external base by absolute path instead.
- The `.belayd/proof-dir` marker is written by the harness and carries the
  absolute proof base. The browser plugin reads it because it cannot read
  server-side environment variables.
- The `proof-of-work/` symlink and `.belayd/` are gitignored; artifacts are ephemeral.

#### Resolution order

1. The harness chooses the base using `BELAYD_PROOF_DIR`, then
   `XDG_STATE_HOME`, then `~/.local/state/belayd/proof`.
2. It writes that resolved absolute path as one line plus a trailing newline in
   `.belayd/proof-dir`.
3. The plugin reads the marker and lists the external path directly. That path
   must be in `pathAccess.allowedPaths`.
4. If the marker is missing, the plugin falls back to the legacy
   workspace-relative `proof-of-work` location.

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

- In external mode, ensure the proof base contains at least one task
  subdirectory: `<proof-base>/<task-id>/`.
- In external mode, confirm `.belayd/proof-dir` exists in the workspace and
  contains the absolute proof base. If testing legacy fallback, confirm the
  marker is absent and a real workspace-relative `proof-of-work/` directory
  contains the task subdirectory.
- Click the ↻ Refresh button to re-scan.

#### "Could not access the proof-of-work directory"

pi-web rejected the absolute proof-base path because it is not in the allowed
filesystem roots. The panel deliberately does not echo the marker's absolute
path.

- Add the proof base directory to pi-web's **External filesystem roots**
  (`pathAccess.allowedPaths` in the global pi-web config or
  `<workspace>/.pi-web/config.json`), then refresh.
- Use this config shape (or merge the entry into an existing config):
  `{ "pathAccess": { "allowedPaths": ["~/.local/state/belayd/proof"] } }`
  (`BELAYD_PROOF_DIR` users list that path instead).
- The setting applies on the next file request; click ↻ **Refresh** or reload
  the browser tab if the existing view is stale.

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
| `discovery.js` | File I/O helpers — `resolveProofRoot()` reads `.belayd/proof-dir` and selects the external absolute root or legacy `proof-of-work`; `listTaskDirs()`, `listTaskFiles()`, `readProofFile()`, `getFileExtension()` |
| `panel.js` | Custom element `<pi-web-proof-work-panel>` — all UI, state management, player lifecycle |
| `renderers.js` | Content rendering — `renderFileContent()`, markdown via **marked**, media placeholders |
| `vendor/` | Third-party dependencies — asciinema-player (CSS + JS), `marked.esm.js` |

Unit coverage for the discovery helpers lives in `discovery.test.js` (plain-JS vitest, no build step).

Async operations are guarded by a monotonic `scanToken` counter that prevents stale responses from overwriting newer state. Binary media content is passed through blob URLs that are tracked and revoked on cleanup.

### Related documentation

- [Verifiable Proof Artifacts — Agent Guide](../../.agents/skills/verifiable-proof/SKILL.md) — how agents generate proof artifacts
- [Verifiable Proof Artifacts — Viewer Guide](../../docs/VERIFIABLE_PROOF.md) — how to replay/view artifacts outside pi-web
- [pi-web Plugins API](../../node_modules/@jmfederico/pi-web/docs/plugins.md) — pi-web plugin API reference
