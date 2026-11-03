---
name: unslop
description: Turns vibecoded, AI-looking UI into a designed interface with its own character. Finds a direction from the product itself, then fixes spacing, color, icons, copy, type, layout, details, visuals and motion in that order, and can generate a real hero visual with an image tool when one is available. Use when the user asks to unslop, polish, clean up or redesign a screen so it stops looking AI-generated, or when a UI shows the usual tells like purple gradients, glows, gradient text, emoji labels, "New ✨" badges, glossy blobs, uppercase tracked labels, pulsing elements or uneven spacing. Works on React, Tailwind, HTML and CSS, for dashboards, apps and landing pages.
license: CC-BY-4.0
---

# unslop

Created by **Damir Sokolovsky** ([@heydamir](https://x.com/heydamir),
https://heydamir.design/unslop), licensed **CC BY 4.0**. Keep this credit in
copies and adaptations, including any story video you render.

This skill is a thin router to the pinned upstream material. It intentionally
does not reproduce the upstream instructions — read them in place so they always
match the installed version.

## Authoritative source

Read `${UNSLOP_HOME}/SKILL.md` and follow it. That file is the upstream agent
skill shipped with the pinned package: the run loop, the direction lines, the
nine fix passes, the story-video recipe, the do-nots and the final checklist.
Do not copy it here.

Then read only what the pass you are on needs:

| Path | What it holds |
| --- | --- |
| `${UNSLOP_HOME}/references/signs.md` | The audit: every sign of slop, grouped, each paired with its fix |
| `${UNSLOP_HOME}/references/tokens.md` | Exact values (spacing scale, type, color, radii, shadows) for each pass |
| `${UNSLOP_HOME}/references/visuals.md` | Choosing a product-owned visual, and the image-tool path |
| `${UNSLOP_HOME}/references/refs.md` | Finished screens to learn qualities from — never their subject, palette or layout |
| `${UNSLOP_HOME}/references/effects.md` | Motion and detail effects that survive the passes |
| `${UNSLOP_HOME}/references/refs/*.webp` | The reference screens themselves; open them with `describe_image` |
| `${UNSLOP_HOME}/examples/dashboard.html`, `${UNSLOP_HOME}/examples/hero.html` | The two vibecoded screens to practise on |

`${UNSLOP_HOME}` is exported by the devShell and by the pi-web runtime env, so
spawned agents inherit it. If `${UNSLOP_HOME}` is empty, you are outside a
harness shell — run the command inside `nix develop`.

## Harness substitutions

Upstream writes absolute `/scripts/...` paths that do not exist here. Use the
wrapped equivalents instead; both are on `PATH` in the devShell, in pi-web
sessions and in spawned agents.

| Upstream | Here |
| --- | --- |
| `node /scripts/snapshot.mjs <url> <out.html> [pass label] [--dark\|--light] [--width=1440] [--height=810]` | `unslop-snapshot <url> <out.html> [pass label] [--dark\|--light] [--width=1440] [--height=810]` |
| `node /scripts/story.mjs <story.html> <out.mp4> [--wide]` | `unslop-story <story.html> <out.mp4> [--wide]` |
| `node /scripts/story.mjs <story.html> --play` | `unslop-story <story.html> --play` (loops in a browser window until closed; no output path) |

`unslop-snapshot` also writes `<out>.live.png` next to the HTML — that is the
screenshot to judge with `describe_image`. The wrappers exist because upstream
resolves Playwright through the current project's `package.json` and only finds it
via `NODE_PATH`, which they set to the pinned `playwright-core`.
`PLAYWRIGHT_BROWSERS_PATH` already points at the Nix browser set, so no
`playwright install` is needed, and `ffmpeg` is present for `unslop-story`.

## Images

No image-generation service is wired into this harness. When the skill reaches
its "no image tool connected" branch, take that path: write the image prompt into
the report instead of generating anything, and say what would have to be
connected. Do not substitute stock imagery, gradients or blobs for the missing
visual.
