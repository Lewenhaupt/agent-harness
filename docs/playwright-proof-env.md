# Playwright proof tooling in the Nix runtime env (bd-64)

The proof workflows need two Playwright entry points available on `PATH` inside
every pi-web session and devShell:

- **`playwright`** — the test runner (`playwright test`) and trace viewer
  (`playwright show-trace`). Provided by `pkgs.playwright-test`, added to the
  flake's `devShellTools`.
- **`playwright-cli`** — interactive browser driving and screenshots. Now built
  against nixpkgs' `pkgs.playwright-driver` instead of a pinned
  `playwright-core@1.61.0-alpha` tarball, so its expected browser revisions
  match `PLAYWRIGHT_BROWSERS_PATH` (which points at
  `pkgs.playwright-driver.browsers`).

Both `devShellTools` and the systemd `pi-web-runtime-env` derive from the same
list (`flake.nix`), so fixing the devShell fixes pi-web too. The proof panel's
**Open in Trace Viewer** button invokes the `playwright` on `PATH`.

## How to Verify

Steps 2–5 are runnable in the project devShell. On a host where the runtime env
is on `PATH`, the `direnv` form works; otherwise use `nix develop -c`.

1. **Enter the devShell.** Either `direnv allow` once and then `direnv exec . bash`,
   or directly `nix develop -c bash`. Every command below can also be wrapped as
   `direnv exec . bash -c '<cmd>'`.

2. **Confirm both binaries resolve.**

   ```bash
   command -v playwright
   command -v playwright-cli
   ```

   Observed on the bd-64 verification host (store paths are machine-specific and
   change on rebuild; the important part is that both resolve from
   `playwright-test` / `playwright-cli` derivations, not from a local
   `node_modules/.bin`):

   ```text
   /nix/store/0ikc8wsc0aan9kpzslkhsn9l7iwnz7y5-playwright-test-1.61.1/bin/playwright
   /nix/store/79a803pra5ka3fnhlzpmy3sc58qfs2rg-playwright-cli-0.1.14/bin/playwright-cli
   ```

3. **Confirm versions and the browser path.**

   ```bash
   playwright --version
   playwright-cli --version
   echo "$PLAYWRIGHT_BROWSERS_PATH"
   ls "$PLAYWRIGHT_BROWSERS_PATH"
   ```

   Observed:

   ```text
   Version 1.61.1
   0.1.14
   /nix/store/58nx8ipi0v36amc4rgmd09l17iyrvwpm-playwright-browsers
   chromium-1228
   chromium_headless_shell-1228
   ffmpeg-1011
   firefox-1532
   webkit-2311
   ```

   The CLI-built `playwright-core` and the browser set come from the same
   nixpkgs revision, so the `chromium-1228` directory above is exactly what both
   tools expect. If you ever see the CLI complain that an expected revision is
   absent, the flake's `pkgs.playwright-driver` binding and the nixpkgs browser
   set have drifted.

4. **Prove the trace-viewer path works.**

   ```bash
   playwright show-trace --help
   ```

   Expected: `Usage: npx playwright show-trace [options] [trace]` with the
   `-b, --browser` / `-p, --port` / `--stdin` options. Exit 0.

5. **Prove `playwright-cli` resolves the Nix browser with no revision-guard
   error.**

   ```bash
   playwright-cli -s=verify open --browser=chromium "data:text/html,<h1>ok</h1>"
   playwright-cli -s=verify screenshot --filename=/tmp/verify.png
   playwright-cli -s=verify close
   ```

   Expected: `open` prints `### Browser \`verify\` opened with pid …` and exits 0;
   `screenshot` prints `[Screenshot of viewport]` and writes a real PNG
   (`file /tmp/verify.png` → `PNG image data, 1280 x 720`). No
   `Browser "chrome-for-testing" is not installed`.

   Without `--browser=chromium`, the CLI probes for a system Chrome/Edge channel
   first and fails on NixOS with
   `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`.
   Passing `--browser=chromium` skips that probe and uses the Nix browser.
   (Observed; this is why the flag is mandatory in the docs.)

6. **In pi-web (not verified here — browser UI check):** open a task's **Proof
   of Work** panel, select a `.trace.zip`, and click **Open in Trace Viewer**.
   It should start the local viewer instead of printing
   `ERROR: playwright CLI not found on PATH. The Nix runtime env ships playwright; …`.
   The panel finds `playwright` via `command -v playwright` before falling back to
   a workspace `node_modules/.bin` search (`showTraceCommand` in
   `pi-web-plugins/proof-of-work/panel.js`).

7. **Automated regression guard (unit test):**

   ```bash
   pnpm vitest run src/__tests__/flake-playwright-env.test.ts
   ```

   Observed: `4 passed`. It asserts `flake.nix` contains `pkgs.playwright-test`,
   builds `playwright-cli` against `pkgs.playwright-driver`, and does not
   reintroduce the pinned `playwrightCoreSrc` alpha tarball.

## How to Use

Producing proof from an agent session:

- **E2E browser trace** — run the target repo's Playwright suite with its proof
  mode on; the suite emits the `*.trace.zip` artifacts the panel can open. The
  exact script name is project-specific (this harness has no
  `test:playwright` script of its own — not verified here), e.g.:

  ```bash
  BELAYD_PROOF=1 playwright test
  # or the target repo's wrapper script, e.g.:
  # BELAYD_PROOF=1 pnpm test:playwright
  ```

  `playwright test --help` works from the devShell because `pkgs.playwright-test`
  provides the runner.

- **Interactive screenshots** — drive a real browser with `playwright-cli`.
  Always pass `--browser=chromium`:

  ```bash
  playwright-cli open --browser=chromium http://localhost:PORT
  # inside the session:
  # > screenshot --filename=proof-of-work/<task-id>/<changed-page>.png
  ```

  Use the `-s=<session>` flag to keep an isolated session per verification run
  (`playwright-cli -s=verify open …`); remember `playwright-cli -s=verify close`
  when done.

- **Trace viewer outside pi-web** — open a trace directly:

  ```bash
  playwright show-trace proof-of-work/<task-id>/<name>.trace.zip
  # or serve it and print the URL:
  playwright show-trace --port 9323 proof-of-work/<task-id>/<name>.trace.zip
  ```

### Why `--browser=chromium`

`playwright-cli open` without the flag probes for a system Google Chrome / Edge
(`msedge`) channel and *only* falls back to the Nix chromium if the probe is
skipped. On NixOS the probe fails
(`Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`).
`--browser=chromium` selects the Nix-provided Chromium from
`PLAYWRIGHT_BROWSERS_PATH` directly.

### Never `playwright install`

Browsers are already provided by Nix and patched for this host. `playwright
install` fetches CDN binaries linked against FHS libraries, which fail on NixOS
with `libglib-2.0.so.0: cannot open shared object file`. Both binaries resolve
their browsers from `PLAYWRIGHT_BROWSERS_PATH`; no project-local
`node_modules` install is needed for the trace viewer.

### If a revision mismatch appears anyway

Run the command through the project devShell so the project's own
`PLAYWRIGHT_BROWSERS_PATH` is exported:

```bash
direnv exec <repo> playwright-cli open --browser=chromium http://localhost:PORT
```

Never symlink a mismatched revision into the expected directory just to satisfy
a version guard.

## Related documentation

- [Proof of Work Viewer](../../pi-web-plugins/proof-of-work/README.md) — panel
  install, artifact formats, and troubleshooting.
- [pi-web systemd system services](pi-web-service.md) — the service PATH and
  `pi-web-runtime-env` that carries these tools into sessions.
