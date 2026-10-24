# AWS / SSO credential isolation (bd-125)

Agents run as the operator's uid, so before this change any agent could read
`~/.aws` (including `~/.aws/sso/cache`), run `aws sso login`, and use the
operator's full IAM Identity Center permission sets. This document describes
the two mechanisms that replaced that:

1. **bubblewrap masking** at every agent choke point, so no agent process can
   see the operator's AWS credential material at all;
2. a **per-repo credential broker** that hands a sandboxed agent exactly one
   scoped profile, resolved through `sso:GetRoleCredentials` (via the AWS CLI).

## Threat model

| Actor | Before | After |
|-------|--------|-------|
| Agent session spawned by `pi-web-sessiond` | full `~/.aws`, full IAM Identity Center permission sets, `aws sso login` | masked `~/.aws`; only the repo's synthetic `agent` profile, served by the broker. Its own bash tool / sub-agents get the stricter per-repo sandbox; the session process itself still sees the broker control socket (single-uid limit, see the actor table) |
| Sub-agent spawned by `src/spawn.ts` | inherits the parent's env, including `AWS_*` credentials | `AWS_*` scrubbed, wrapped in a per-repo scoped sandbox |
| `belayd-shell` terminal / plugin `runCommand` in a repo with `.belayd/aws.yaml` | operator credentials | re-exec'd through the same per-repo sandbox |
| pi-web server, interactive pi CLI, human shell, broker daemon | operator credentials | unchanged (see "residual risk") |

The boundary is **"agents are sandboxed"**, not "the uid is partitioned".
Same-uid sibling processes outside a sandbox can still read `~/.aws`.

## The sandbox argv, and why each flag is there

Per-repo (agent) sandbox, built by `src/aws-broker/scope.ts`
(`buildSandboxArgv`) and unit-tested flag by flag:

```
bwrap
  --unshare-user --die-with-parent --new-session
  --bind / / --dev-bind /dev /dev --proc /proc
  --tmpfs $HOME/.aws
  --tmpfs $HOME/.config/aws
  --tmpfs <allowlist dir mask>                # only when the allowlist says so
  --ro-bind /dev/null <allowlist file mask>   # only when the allowlist says so
  --tmpfs <runtimeBase>
  --ro-bind <scopeDir> <scopeDir>
  --ro-bind <scopeDir>/aws/config $HOME/.aws/config
  --setenv AWS_PROFILE agent --setenv AWS_REGION <region>
  --setenv BELAYD_SANDBOX_ACTIVE 1
  --unsetenv AWS_ACCESS_KEY_ID --unsetenv AWS_SECRET_ACCESS_KEY …
  -- <cmd> ...
```

| Flag | Why |
|------|-----|
| `--unshare-user` | The only namespace we unshare. It makes a same-uid `/proc/<pid>/environ` read from a sibling process outside the sandbox fail, which is what protects credentials from another agent process. |
| `--die-with-parent` | A killed session must not leave an orphan holding the scope socket. |
| `--new-session` | New session (no controlling tty) so a sandboxed process cannot inject input into the parent's terminal. |
| `--bind / /` | Writable base view. **Must come first**: bubblewrap applies mounts in argv order, so a later base bind would silently unmask everything above it. Writable on purpose: a coding agent must write its worktree and `/tmp`, so a read-only base would make every `git`/`bd`/`nix` command fail with `EROFS` (and crash the session daemon before it can create its socket). The mask, not a read-only root, is the AWS security boundary. Unit-tested. |
| `--dev-bind /dev /dev`, `--proc /proc` | `/dev/null`, `/dev/tty`, and `/proc/self` keep working; `ps`/`git`/`nix` need them. |
| `--tmpfs $HOME/.aws` | The SSO cache is a *directory*, so `--tmpfs` is correct. (`--ro-bind /dev/null <dir>` is not, and `--ro-bind /dev/null <file>` reads `EACCES`, not EOF.) |
| `--tmpfs $HOME/.config/aws` | Any second AWS config location is masked too. |
| `--tmpfs <dir>` / `--ro-bind /dev/null <file>` per allowlist `mask:` entry | Operator-chosen extra masks, chiefly the x509 certificate and private key of an IAM RolesAnywhere `credential_process` profile: the broker must read them, so they cannot live under `~/.aws`, and an agent that can read them can call `aws_signing_helper` itself and bypass the allowlist. Directories become a tmpfs; a regular file becomes a `/dev/null` bind, which reads `EACCES` on open (never EOF and never an empty file that looks like an empty key). Paths are `realpath()`-resolved, and any unusable entry refuses the whole scope. Shapes, resolution, and the full refusal list: [Mask entries](#mask-entries). |
| `--tmpfs <runtimeBase>` | `<runtimeBase>` is where the broker keeps the control socket and every scope dir (`BELAYD_AWS_RUNTIME_BASE_DIR`, else `<XDG_RUNTIME_DIR>/belayd/aws`). Masking it removes the control socket ("ensure any scope") and every *other* repo's scope socket, then the next line re-exposes only this one. This mask — not socket mode 0600, which is meaningless between same-uid processes — is what makes per-repo scoping real. |
| `--ro-bind <scopeDir> <scopeDir>` | Re-exposes this worktree's scope dir (shim, synthetic config, socket). The destination lives inside the tmpfs, so bubblewrap can create it without relying on a writable host destination. |
| `--ro-bind <scopeDir>/aws/config $HOME/.aws/config` | The only profile the agent can see: `[profile agent]` with a `credential_process`. |
| `--setenv BELAYD_SANDBOX_ACTIVE 1` | Makes nested wraps no-ops (`spawn.ts` and `belayd-shell.sh` both check it). |
| `--unsetenv AWS_ACCESS_KEY_ID …` | Drops every inherited credential source (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_DEFAULT_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, the two `AWS_CONTAINER_CREDENTIALS_*` keys) *inside* the sandbox, so a launcher that forgot to scrub (or a hand-run argv) still cannot pass env-var credentials through. `AWS_PROFILE` is deliberately not unset — the sandbox sets it to the synthetic profile. |

Deliberately **not** used:

- `--tmpfs /tmp`, `--unshare-pid`, `--unshare-ipc`, `--unshare-net`: bd's dolt
  liveness check shells out to `ps -axo`, and terminals plus `nix build` rely on
  the host `/tmp` and host network. Unsharing only the user namespace is enough
  for the credential property that matters.
- `--not-a-security-boundary` (self-defeating) and `--disable-userns` (would
  break nesting).
- `/run/belayd-aws` as the mount point: an unprivileged service user cannot
  create a directory directly under the root-owned `/run`, and
  `ExecStartPre` cannot either. The scope dir is therefore re-exposed at its
  own host path, which also means the same absolute socket path is valid inside
  and outside.

`--tmpfs` destinations are **pre-created** on the host by the plan resolver
(`<runtimeBase>`, `~/.aws`, and `~/.config/aws`, mode 0700). A writable base
would let bubblewrap create a missing destination itself, but pre-creating
keeps the mask shape independent of who wins the race and turns any failure
into an `unavailable` result rather than throwing; the systemd broker unit's
`RuntimeDirectory` creates the runtime base, and the session daemon's
`ExecStartPre` creates the two `$HOME` masks for its static argv.

## Configuration

### Operator allowlist: `~/.config/belayd/aws.yaml`

```yaml
region: eu-north-1                 # optional default region
mask:                              # optional: hidden in EVERY scope
  - /srv/belayd/agent-keyring
scopes:
  - worktree: /home/hugo/git/acme-*   # glob on the git toplevel
    profiles: [agent-readonly, agent-deploy]
    default: agent-readonly
    region: us-east-1              # optional per-scope override
    mask:                          # optional: hidden in THIS scope only
      - /srv/belayd/acme-agent-cert
      - /srv/belayd/acme-agent-key
```

- `worktree` is a glob (`*` does not cross `/`, `**` does, `?` is one char).
  The first matching scope wins.
- A worktree matched by **no** scope gets no AWS.
- `mask` entries are absolute host paths hidden inside that scope's sandbox
  (top-level list first, then the per-scope list, de-duplicated — by entry text,
  then again by `realpath()`-resolved path, so a symlink and its target are
  mounted once). They are resolved with `realpath()` at plan time, and a
  directory is masked with a tmpfs while a regular file is masked with a
  `--ro-bind /dev/null` (opening it reads `EACCES`). Any entry that cannot be
  applied **refuses the scope** rather than being ignored. Accepted shapes,
  indentation, resolution, and the full refusal list:
  [Mask entries](#mask-entries).
- The repo file deliberately has no `mask:` key: a repo cannot widen or shrink
  its own sandbox.
- Only this small schema is parsed; unknown keys, tabs, or anything outside it
  are refused with a line number (`src/aws-broker/config.ts` is a hand-rolled
  subset parser, deliberately not a new dependency).

### Repo file: `<worktree>/.belayd/aws.yaml`

```yaml
profile: agent-deploy
```

- A **literal** profile name — never a glob, never `default`.
- The repo file is mandatory. **No repo file ⇒ no AWS inside the sandbox.**
- A profile the allowlist does not grant that worktree is refused, loudly:
  `profile "agent-deploy" is not permitted for worktree /… (allowed: agent-readonly)`.
  Fixing the allowlist takes effect on the next `ensure-scope` — no daemon
  restart, no rebuild.

### Broker protocol

- Control socket: `<runtimeBase>/control.sock` (0600 in a 0700 dir),
  newline-delimited JSON. `<runtimeBase>` is
  `BELAYD_AWS_RUNTIME_BASE_DIR` when set (the systemd unit's
  `RuntimeDirectory`, `/run/belayd/aws`) and `<XDG_RUNTIME_DIR>/belayd/aws`
  otherwise.
  - `{"action":"ensure-scope","worktree":"/abs/path"}` →
    `{"ok":true,"socketPath":"…","scopeId":"…","profile":"…","sandboxProfile":"agent","region":"…"}`
    or `{"ok":false,"kind":"not-configured|refused|unavailable|already-sandboxed","error":"…"}`.
  - `{"action":"whoami"}` → the live scopes.
  - Every `ensure-scope` that resolves a plan (allowed or refused) is audited
    with the requested worktree, so a cross-scope attempt is visible even
    though it cannot be attributed to a caller. A repeat call that reuses a
    live socket for an unchanged profile is not audited (nothing changed).
- Scope socket: `<runtimeBase>/<scopeId>/sock` (0600). Served actions:
  - `{"action":"credential_process"}` (optional `"profile":"agent"`) →
    `{"ok":true,"credentials":{Version,AccessKeyId,SecretAccessKey,SessionToken,Expiration}}`;
  - `{"action":"whoami"}` → `{scope, worktree, profile, sandboxProfile}`.
  - Anything else, or any other profile, is refused with no credential lookup.
- One socket serves exactly one source profile; the SDKs never cache a
  `credential_process`, so the broker caches (single-flight, 5-minute refresh
  skew, small LRU).
- Only **temporary / role** credentials are served. `aws configure export-credentials
  --format process` omits `SessionToken`/`Expiration` for long-lived IAM-user
  keys, and the broker refuses that document with an actionable message
  (`long-lived credentials (no SessionToken); … a credential_process profile
  (including IAM RolesAnywhere) or an SSO/assumed-role profile is fine,
  long-lived IAM-user keys are not …`) instead of failing forever on a missing
  field. An SSO profile and an IAM RolesAnywhere `credential_process` profile
  both qualify; static IAM-user keys do not.
- The shim (`src/aws-broker/client.ts`) prints exactly one document on stdout
  and **nothing** on stderr on success; on failure it prints the broker's
  message on stderr and exits non-zero, never partial JSON.

### Audit log

`$XDG_STATE_HOME/belayd/aws-audit.jsonl` (0600), one line per request:
`{ts, scope, worktree, profile, action, outcome}`. Credential material is never
written — the entry type has no field that could carry it. Every request type is
covered:

- `ensure-scope` — control socket, including every refusal (`outcome` is
  `error:not-configured`, `error:refused`, `error:unavailable` or
  `error:already-sandboxed`), plus `error:listen` when a scope socket cannot be
  bound.
- `whoami` — both the control-socket and scope-socket variant; the control one
  carries empty `scope`/`worktree`/`profile` because it spans every live scope.
- `credential_process` — allowed (`ok`), refused for an unknown profile
  (`error:unknown-profile`), or failed against AWS (`error:unavailable`).
- `invalid` — a malformed or unsupported request on either socket
  (`error:invalid-request`), audited by both `daemon.ts` (control) and
  `server.ts` (scope) because an unparseable line is still a broker access
  attempt.

The log is **unattributable**: one socket per scope means there is no caller
identity, only scope + worktree + time + action + outcome. Do not read it as
"which agent did this".

## Cannot escape / can still do

The answer depends on **which process** you are. Read each row as its actor.

| Actor | Cannot | Can |
|-------|--------|-----|
| **Sandboxed agent** (per-repo bwrap: `src/spawn.ts`, `belayd-shell.sh`) | Read `~/.aws` or `~/.config/aws`; read any path the operator listed under `mask:` (e.g. an IAM RolesAnywhere certificate/private key); run `aws sso login`; read or connect to the broker control socket; read or connect to any sibling repo's scope socket; see inherited `AWS_*` credentials | Use its repo's one scoped profile (SSO or RolesAnywhere `credential_process`, temporary credentials only) until `Expiration`; call any API that profile's IAM permission set / role allows; use the host `/tmp`, host network, `/dev`, `nix develop`, `git`, `bd` |
| **Orchestrator / agent session in the `pi-web-sessiond` namespace** (not itself under a per-repo wrap: the session pi process, an agent tool that bypasses `belayd-shell`, a repo with no `.belayd/aws.yaml`) | Read `~/.aws` or `~/.config/aws` (the sessiond mask); run `aws sso login` | Reach the control socket and therefore ask the broker for **any scope the allowlist configures**; reach every scope socket |
| **Same-uid process outside every sandbox** (interactive pi CLI, human shell, pi-web server, the broker) | Nothing enforced | Read `~/.aws`, run `aws sso login`, use the full IAM Identity Center permission set |

The middle row is the honest limit of a single-uid design: the orchestrator
runs the harness code that legitimately needs `ensure-scope`, and a sandboxed
child is the same uid, so the two cannot be told apart at the socket. A
dedicated broker uid would close it and is deliberately out of scope (see
residual risks).

## Human-in-the-loop boundary

The IAM Identity Center portal session defaults to 8 h (max 90 days) and the
PKCE client registration expires after 90 days. When either lapses, **only an
interactive `aws sso login` on the host** (outside every sandbox, as the
operator) restores access. The broker never retries silently: it surfaces AWS's
own error text verbatim plus `aws sso login --profile <profile>`.

A repo scoped to an IAM RolesAnywhere `credential_process` profile is different:
there is no portal session and no PKCE registration. Role credentials are
refreshed by the broker, and the human boundary is the **x509 certificate's
expiry** — re-issue the certificate/key on the host when it lapses. For those
failures the broker does **not** prescribe `aws sso login`; it names the
credential_process helper, the x509 material, and the trust anchor / profile /
role ARNs instead.

## Residual risks (honest list)

- **Same-uid siblings outside the sandbox** (interactive pi CLI, human shell,
  pi-web server, the broker itself) can still read `~/.aws`. A dedicated broker
  uid would close this and is deliberately out of scope.
- **The orchestrator is not separated from a sandboxed child.** Anything in the
  `pi-web-sessiond` mount namespace that is not under a per-repo wrap (the
  session pi process, a tool that bypasses `belayd-shell`, an agent working in a
  repo with no `.belayd/aws.yaml`) can reach the control socket and request any
  allowlisted scope. That is by construction: the harness in that namespace
  needs `ensure-scope` for the agents it spawns, and with one uid the broker
  cannot distinguish it from a child. The per-repo sandbox closes this for
  opted-in repos; a dedicated broker uid is the upgrade path.
- **bubblewrap is not a hostile-code boundary.** Inherited file descriptors are
  not closed (the launcher must set `CLOEXEC`/close before `exec`; audited:
  `spawn.ts` and the wrapper hold no pre-opened `~/.aws` fd). Hardlinks created
  before the mask still resolve. Abstract unix sockets are reachable while the
  network namespace is shared, so the broker relies on socket file mode 0600,
  never on netns. Masked paths are only unmasked by an ordering bug — which is
  why the argv order is unit-tested.
- **No network egress control**: an agent holding scoped credentials can
  exfiltrate within its role's permissions. Least privilege lives in the IAM
  permission set chosen per repo, plus the allowlist.
- **Audit is per scope, not per agent.**
- **`mask:` covers what the operator lists.** The fixed masks are `~/.aws`,
  `~/.config/aws`, and the broker runtime base; anything else (an IAM
  RolesAnywhere certificate and key, a second keyring) is readable inside the
  sandbox until the operator adds it to the scope's `mask:` list. A mask typo
  refuses the scope rather than being ignored, a mask entry inside the
  worktree / scope dir / runtime base is refused (the repo cannot widen or
  break its own sandbox), and so is an entry that *contains* the home dir,
  worktree, scope dir or runtime base — an ancestor mask would hide the spawn
  cwd or the broker/sessiond sockets instead of hiding one secret.
- **The SSO cache format is a botocore internal.** We never parse it: credential
  resolution is delegated to `aws configure export-credentials --format
  process`. A direct `CreateToken` + `GetRoleCredentials` path is a later
  optimisation only if CLI spawn latency (~0.2–0.4 s per cache miss) hurts.
- **`pi-web-server` is intentionally not sandboxed** (browser UI + plugin
  `runCommand` are the operator's own session).

## NixOS module wiring

- `pi-web-sessiond` runs under
  `bwrap --unshare-user --die-with-parent --bind / / --dev-bind /dev /dev
  --proc /proc --tmpfs <home>/.aws --tmpfs <home>/.config/aws --
  <pi-web>/bin/pi-web-sessiond`. The base is writable so the daemon can write
  `sessiond-owner.json` and `sessiond.sock` into its data dir; the AWS mask is
  what isolates credentials.
  It deliberately does **not** set `BELAYD_SANDBOX_ACTIVE`, so an agent spawned
  inside it still resolves its own (stricter) per-repo scope as a nested
  sandbox. It also has no `--unsetenv`: a systemd system unit does not inherit
  a shell environment, so there are no `AWS_*` variables to drop. The per-repo
  argv does carry `--unsetenv` (see above), because that one is built by
  whatever process happens to be running.
- `pi-web-sessiond-setup` (ExecStartPre) creates `<home>/.aws` and
  `<home>/.config/aws` so the static mask destinations exist.
- `pi-web-aws-broker` runs `${belayd-harness}/bin/belayd-aws-broker`
  (`daemon`) as `cfg.user`, **not** wrapped, with `Restart=on-failure`. It must
  read `~/.aws`, so it must never start inside a sandbox. Its service config
  declares `RuntimeDirectory=belayd/aws` (0700, owned by `cfg.user`,
  `RuntimeDirectoryPreserve=restart`), which creates `/run/belayd/aws` before
  `ExecStart` — a system-service user has no logind session, so a hard
  dependency on `/run/user/<uid>` would crash-loop the daemon under
  `Restart=on-failure`. A non-fatal `ExecStartPre` also creates
  `~/.local/state/belayd` for the audit log (the writer would create it anyway).
- `BELAYD_AWS_RUNTIME_BASE_DIR=/run/belayd/aws` is exported by both units, so
  the broker and every plan resolver agree on the socket path without logind.
- `XDG_RUNTIME_DIR=/run/user/<uid>` is exported by both units **when the uid is
  known**: systemd only sets it for *user* units, and tools inside sessions
  (dbus, ssh-agent) expect it. `userUid` is derived with `or null` so a
  `user` that is not declared under `users.users` degrades to a `warnings`
  entry instead of throwing at evaluation time; the AWS broker is unaffected
  because it uses `RuntimeDirectory` + `BELAYD_AWS_RUNTIME_BASE_DIR`.
- `BELAYD_AWS_CREDENTIAL_PROCESS_BIN=${belayd-harness}/bin/belayd-aws-credential-process`
  is what the generated shim execs; `BELAYD_AWS_BIN=${belayd-harness}/bin/belayd-aws` is the
  CLI a plan resolver calls to start a scope socket on demand (see below).
- The sessiond argv does **not** mask `/run/belayd/aws` on purpose: the
  orchestrator inside it needs the control socket (see the actor table above).
  The per-repo argv does mask it.
- `pkgs.bubblewrap`, `pkgs.awscli2`, and `pkgs.aws-signing-helper` are in
  `devShellTools`, so they reach both `devShells.default` and
  `pi-web-runtime-env` (and therefore every spawned agent's `PATH`). bubblewrap
  comes from nixpkgs-unstable (0.11.x/0.12.x line) and has no setuid mode, so
  `--unshare-user` is the only privilege path. `aws_signing_helper` matters only
  on the **broker's** `PATH`: it is the helper an IAM RolesAnywhere
  `credential_process` profile shells out to, and the sandbox never runs it.

### Scope sockets start on demand

The daemon owns every scope socket, and its control socket is masked inside the
sandbox on purpose (a sandboxed process must not be able to ask for another
repo's credentials). So whoever builds a plan asks the daemon from *outside*:
`belayd-aws plan` does it for the shell wrapper, and `src/spawn.ts` does it for
a sub-agent (`ensureScopeSync`). This is best effort — a broker that is down is
logged but **never** turns the sandbox off, because the mask is the security
property and AWS access is not. If the broker is restarted, the next plan (or
spawn) re-creates the scope socket.

### Degrade gracefully

When AWS is not configured for a worktree (no `~/.config/belayd/aws.yaml`, no
`.belayd/aws.yaml`, or the scope does not match), the plan is not applied and
the command runs unwrapped, with **no AWS at all**. That is the normal case and
is not an error. A *refusal* (repo file present but malformed, or a profile the
allowlist does not grant) is logged once per spawn by `src/spawn.ts` and once
per shell invocation by `scripts/belayd-shell.sh`; so is `unavailable` (bwrap
missing, runtime base not writable), which matters because a repo that opted in
then runs *unmasked* — with `AWS_*` scrubbed, but able to read `~/.aws` if it is
not inside the sessiond namespace.

### Shell-wrapper routing order

`scripts/belayd-shell.sh` computes the plan first, but every routing branch
(direnv export + allow-check, `nix develop`, `shell.nix`, pass-through) execs
through a `belayd_exec` helper that wraps the *final* command in the sandbox.
That ordering is deliberate: the devShell env is resolved in the wrapper process
and then inherited by the sandboxed command, so a repo carrying both
`.belayd/aws.yaml` and `.envrc`/`flake.nix` still gets its devShell inside the
mask. (An earlier revision exec'd the real shell straight from the AWS block,
silently skipping the devShell; `test/aws-sandbox.integration.test.ts` and the
`belayd-shell` unit tests pin the current behaviour.)

## How to Use

Two files decide AWS access and **both must agree**: the operator allowlist
(which profiles a worktree *may* use) and the committed repo file (which
profile this repo *wants*). Neither grants anything alone, and a scope's
`default:` is never substituted for an explicit repo choice.

### 1. Operator: write the allowlist

Path: `$XDG_CONFIG_HOME/belayd/aws.yaml`, i.e. `~/.config/belayd/aws.yaml`
unless you export `XDG_CONFIG_HOME`.

```bash
install -d -m 0700 ~/.config/belayd
$EDITOR ~/.config/belayd/aws.yaml
chmod 600 ~/.config/belayd/aws.yaml      # holds no secrets, but keep it private
```

```yaml
# Default region for every scope that does not set its own.
region: eu-north-1

# Optional: hidden inside EVERY scope's sandbox (absolute host paths).
mask:
  - /srv/belayd/agent-keyring

scopes:
  # `worktree` is a glob on the worktree's absolute git toplevel.
  - worktree: /home/hugo/git/acme-*
    # Profiles that exist in YOUR ~/.aws/config (the broker resolves them as
    # you, via `aws configure export-credentials --profile <name>`).
    profiles: [agent-readonly, agent-deploy]
    default: agent-readonly        # optional, diagnostics only
    region: us-east-1              # optional per-scope override
  - worktree: /home/hugo/git/infra/**
    profiles: [agent-deploy]
    # Optional: hidden inside THIS scope's sandbox. The broker still reads
    # them; the sandboxed agent cannot.
    mask:
      - /run/secrets/aws-pi-agent-cert
      - /run/secrets/aws-pi-agent-key
```

Schema — this is the entire language (subset parser, see
[Configuration](#configuration) for why it is hand-rolled):

| Key | Level | Required | Meaning |
|-----|-------|----------|---------|
| `region` | top | no | fallback region for scopes without one |
| `mask` | top | no | absolute paths hidden in every scope; flow `[p, p]` or a block list |
| `scopes` | top | **yes** | block sequence of scope entries |
| `worktree` | scope | **yes** | glob matched against the absolute git toplevel |
| `profiles` | scope | **yes** | literal profile names; flow `[a, b]` or a block list |
| `default` | scope | no | must be one of `profiles`; documentation only |
| `region` | scope | no | overrides the top-level region |
| `mask` | scope | no | absolute paths hidden in this scope; merged after the top-level list, de-duplicated |

Indentation is pinned by the parser (it is a line-oriented subset, not a full
YAML parser):

- top-level keys (`region`, `mask`, `scopes`) at **indent 0**; any indent-0 line
  also closes an open top-level `mask:` block;
- items of a top-level `mask:` block list at indent **2 or deeper** — indent 2
  is accepted even though indent 2 also starts a `scopes:` entry, because the
  open block disambiguates them, and any deeper indent is accepted so a
  four-space habit is not mistaken for a broken scope entry;
- `scopes:` sequence entries at **exactly indent 2** (`  - worktree: …`); indent
  1 or 3 is refused, not guessed;
- scope keys (`worktree`, `profiles`, `default`, `region`, `mask`) at **exactly
  indent 4**;
- items of a per-scope `mask:` / `profiles:` block list at indent **≥ 3**
  (deeper than the scope entry's indent 2, which is what keeps them from being
  read as another scope entry); deeper is fine, so both `   - /srv/cert` and
  `      - /srv/cert` work.

Indent 1 is always refused, and the message says which rule you broke: a
`- item` under a `profiles:` / `mask:` header gives ``line 4: block-list items
under `profiles` / `mask` must be indented at least 3 spaces``, a stray list
item with no block-list header gives ``line 3: unexpected list item; only
`profiles` and `mask` support a block list``, and then
`line 4: unsupported indentation; scope keys must be at indent 4` or
``line 3: expected a `- ` scope entry at indent 2``.

Glob semantics (`worktreeMatchesGlob`): `*` matches inside one path segment
(`[^/]*`), `**` crosses `/` (`.*`), `?` is one non-`/` character. The pattern
is anchored to the whole path and a trailing `/` is ignored. **The first
matching scope in file order wins**; a worktree matched by no scope gets no
AWS.

Fail-closed behaviour of this file:

| State | Result |
|-------|--------|
| missing | not-configured — silent, no AWS anywhere |
| parses, but `scopes` is empty | refusal: `allowlist defines no scopes; AWS access stays disabled` |
| tabs, unknown keys, bad indentation | refusal naming the line: `invalid allowlist /…/belayd/aws.yaml: line 4: unknown scope key "profile"` |
| an unusable `mask:` entry | refusal naming the entry and this allowlist, and the scope gets **no** sandbox at all — every case is in [Mask entries](#mask-entries) |

#### Mask entries

`mask:` lists **absolute host paths that must not be reachable from inside this
scope's sandbox**. The motivating case is an IAM RolesAnywhere certificate and
private key ([Using an IAM RolesAnywhere
profile](#4a-using-an-iam-rolesanywhere-profile)): the broker must read them, an
agent must not — an agent that can read them can run `aws_signing_helper` itself
with the (non-secret) trust-anchor / profile / role ARNs and get the same
credentials without touching the allowlist. The repo file has no `mask:` key, so
only you can add one.

A top-level `mask:` applies to every scope; a scope-level one applies to that
scope only. Both accept two shapes:

```yaml
mask: [/srv/aws/pki]                 # flow form
```

```yaml
mask:                                # block form
  - /srv/aws/pki/agent.pem
  - '/srv/aws/pki/agent key.pem'
```

- The flow form is split on **plain commas** with no escaping, and the split
  happens before quotes are stripped, so a path containing a comma cannot be
  written there at all (quoting does not help) — use the block form for it.
- A bare scalar (`mask: /srv/aws/pki`) is refused with a line number
  (`… must be a flow list ([path, path])`). At the top level, do not follow a
  flow value with `- item` lines: with no open block they are read as `scopes:`
  entries and refused (``line N: expected `key: value` ``).
- While a top-level `mask:` block is open, every `- item` at indent ≥ 2 belongs
  to it, so put `scopes:` at indent 0 after the block. An `- worktree: …` line
  indented under `mask:` is read as a mask entry and refused as a relative path
  — it does not quietly become a scope.

An entry must resolve to exactly one of two filesystem kinds:

| Resolves to | Argv form the plan emits | What the sandbox sees |
|-------------|--------------------------|-----------------------|
| a directory | `--tmpfs <resolved path>` | the directory exists and is **empty** |
| a regular file | `--ro-bind /dev/null <resolved path>` | the file exists and `open()` reads `EACCES` (`cat: …: Permission denied`) — never `EOF`, and never an empty file that would look like an empty key |
| anything else (socket, fifo, character or block device) | — | refused |

Entries are `realpath()`-resolved at plan time and the **resolved** path is what
the argv carries, because bubblewrap cannot create a `/dev/null` bind mount
point through a symlinked directory (`bwrap: Can't create file at …`) — an
unresolved entry fails the whole sandbox. Duplicates are collapsed twice: first
by the text as written (top level + scope), then by resolved path, with the
first occurrence winning and order otherwise preserved, so `/run/secrets/cert`
and the file it points at are mounted once, not twice.

Every refusal the plan can emit, in the order it checks them (the first
applicable rule wins). The `line N:` ones are parse-time and surface as
`invalid allowlist <file>: line N: …`; every other message gets
` (in <allowlist path>)` appended so the typo is findable.

| Bad entry | Operator-facing message |
|-----------|-------------------------|
| empty (`mask: [, /a]`) | `line N: mask entries must not be empty` |
| relative, `~`, or `$VAR` (nothing is expanded) | `line N: mask entry "~/cert" must be an absolute path` |
| `/` | `line N: mask entry "/" would hide the entire filesystem` |
| missing path, or a dangling symlink (reported as missing, **not** as containment) | `mask entry "/srv/typo" does not exist or cannot be resolved; a mask typo would leave it readable, so the scope is refused — fix or remove the entry` |
| a symlink that resolves to `/` | `mask entry "…" resolves to the filesystem root` |
| `$HOME` itself | `mask entry "…" is the home directory itself` |
| equal to or inside the scope dir | `mask entry "…" is inside this scope's runtime dir <runtimeBase>/<scopeId>, which holds the generated shim, config and socket; masking it would break the sandbox` |
| equal to or inside the broker runtime base | `mask entry "…" is inside the broker runtime base <runtimeBase>; masking it would hide this scope's own socket` |
| equal to or inside the worktree | `mask entry "…" is inside the worktree <worktree>; the operator allowlist, not the repo, decides what is hidden` |
| an **ancestor** of the broker runtime base | `mask entry "…" hides the broker runtime base <runtimeBase>; masking it would disable the control socket and every scope socket, including this one` |
| an **ancestor** of the scope dir | `mask entry "…" hides this scope's runtime dir <…>, which holds the generated shim, config and socket; masking it would break the sandbox` |
| an **ancestor** of the worktree | `mask entry "…" hides the worktree <worktree>; a sandboxed spawn would start in a hidden working directory` |
| an **ancestor** of `$HOME` | `mask entry "…" hides the home directory <home>; mask a specific path inside it instead` |
| a socket / fifo / character device / block device | `mask entry "…" is a socket, which cannot be masked cleanly` (the word is the actual kind) |

The ancestor rules are what stop a "just mask the parent directory" habit: a
tmpfs over the worktree's parent hides the sandboxed spawn's own working
directory (every spawn then fails with a useless bwrap error), and one over
`/run/belayd` or `/run/user/<uid>` takes out the control socket, the sibling
scope sockets, or the sessiond's dbus/ssh-agent sockets. Which ancestor message
you actually see depends on the entry, because the runtime base is checked first
and `$HOME` usually contains the worktree (the scope-dir ancestor rule is
there for completeness: the scope dir lives inside the runtime base, so the
runtime-base rule fires first). All of them are refusals; none of them is a
partial mask.

**One bad entry voids the whole scope**: the plan returns `refused`, so that repo
gets no sandbox and no AWS at all — never a sandbox with the good entries applied
and the bad one skipped, because a still-readable certificate is exactly what
`mask:` exists to prevent. The refusal is loud, in each place an operator looks:

- `belayd-aws plan --worktree "$PWD"` exits 1 with the reason on stderr and
  nothing on stdout;
- every `belayd-shell` invocation in that repo relays it, prefixed:
  `belayd-shell: mask entry "…" …`;
- every sub-agent spawn warns once:
  `[belayd-harness] AWS sandbox refused for <dir>: mask entry "…" …`;
- the broker's audit log records the attempt as
  `"action":"ensure-scope","outcome":"error:refused"` (see
  [Diagnostics](#6-diagnostics)).

The fix is an allowlist edit and needs no restart — the same rule as a profile
refusal, in [step 7 of How to
Verify](#7-refusal-names-the-allowed-profiles-and-the-allowlist-fix-needs-no-restart).

An empty or missing allowlist therefore means **no AWS in any sandbox**, not a
permissive default. If a repo has no `.belayd/aws.yaml` there is no broker
traffic at all and no error — that is the normal case.

### 2. Repo: opt in with one literal profile

```bash
mkdir -p .belayd
printf 'profile: agent-deploy\n' > .belayd/aws.yaml
git add .belayd/aws.yaml && git commit -m "chore: opt into the belayd AWS broker"
```

- A **literal** name: not `default`, not a glob, not a region. Duplicates,
  unknown keys, and tabs are refused with the line number
  (`invalid /…/acme-api/.belayd/aws.yaml: line 1: unknown key "aws_profile"; only "profile" is allowed`).
- **No repo file ⇒ no AWS inside the sandbox.** Fail closed, by design.
- The profile must be in the worktree's allowlist scope. Otherwise the repo is
  refused loudly, once per shell invocation / spawn:

  ```
  belayd-shell: belayd-aws: profile "agent-deploy" is not permitted for worktree /home/hugo/git/acme-api (allowed: agent-readonly)
  ```

  A sub-agent gets the same reason as
  `[belayd-harness] AWS sandbox refused for /home/hugo/git/acme-api: …`. The
  command still runs — unwrapped, with `AWS_*` scrubbed, and with no AWS.
- Region is resolved as scope `region` → top-level `region` → the broker
  unit's `AWS_REGION`/`AWS_DEFAULT_REGION`. No region anywhere is a refusal
  (`scope for /…/acme-api sets no region; add "region" to its allowlist scope …`),
  because the agent's CLI must not invent one.
- **Fixing a refusal is allowlist-only and needs no restart**: the next plan
  resolution (next shell command / next spawn) re-reads both files, and the
  broker re-resolves on the next `ensure-scope`. Revoking works the same way —
  remove the profile from `profiles:` and the next resolution refuses.

### 3. Activate the host side

The wiring lives in the flake's `nixosModules.pi-web`, so it only takes effect
after a rebuild:

```bash
cd ~/git/nix-tmp                 # the host flake that imports belayd.nixosModules.pi-web
sudo nixos-rebuild switch --flake .   # or plain `nixos-rebuild switch` if that config is not a flake
sudo systemctl restart pi-web-sessiond pi-web-aws-broker
sudo systemctl is-active pi-web-sessiond pi-web-aws-broker pi-web
```

> Restarting `pi-web`/`pi-web-sessiond` kills every in-flight session and
> terminal. Never restart while work is in flight; drain first
> (`docs/pi-web-service.md`).

Which units are sandboxed matters:

| Unit | Sandboxed? | Why |
|------|-----------|-----|
| `pi-web-sessiond` | **yes** (bwrap mask) | every agent session inherits the masked `~/.aws` |
| `pi-web` (browser server, plugin `runCommand`) | no | it is the operator's own UI/process |
| `pi-web-aws-broker` | **deliberately not** | it is the one process that must read `~/.aws` to resolve scoped credentials; a sandboxed broker can serve nothing |

```bash
systemctl show pi-web-sessiond -p ExecStart
systemctl show pi-web-aws-broker -p ExecStart
```

Expected: the first starts with `…/bin/bwrap --unshare-user … --tmpfs
<home>/.aws --tmpfs <home>/.config/aws -- …/bin/pi-web-sessiond`; the second is
the bare `…/bin/belayd-aws-broker` with no `bwrap`.

### 4. In an agent session

With the repo opted in and the profile allowlisted, from the agent's bash tool
or a pi-web terminal inside that repo:

```bash
aws sts get-caller-identity
```

→ the repo's scoped identity (the permission set of the allowlisted profile).

```bash
cat ~/.aws/config
```

→ exactly one profile, the synthetic one (comment lines elided):

```ini
[profile agent]
credential_process = '/run/belayd/aws/<scopeId>/credential-process' --socket '/run/belayd/aws/<scopeId>/sock'
region = us-east-1
```

```bash
ls -A ~/.aws      # config        (no sso/, no credentials file)
ls ~/.aws/sso     # ls: cannot access '/home/<user>/.aws/sso': No such file or directory
aws sso login     # non-zero: the synthetic profile has no sso_* keys to log in with
env | grep '^AWS_'
# AWS_PROFILE=agent
# AWS_REGION=us-east-1
# BELAYD_SANDBOX_ACTIVE=1
```

`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CONFIG_FILE`,
`AWS_SHARED_CREDENTIALS_FILE` are unset inside the sandbox even if the launcher
exported them.

The **orchestrator** (the session pi process itself, any tool that bypasses
`belayd-shell`, and any repo with no `.belayd/aws.yaml`) sees the same masked
`~/.aws` — from the unit mask, so no synthetic profile — but it *can* reach the
broker control socket. That is the documented single-uid limit: read the actor
table in [Cannot escape / can still do](#cannot-escape--can-still-do) before
drawing conclusions about "the agent".

### 4a. Using an IAM RolesAnywhere profile

A repo can be scoped to an **IAM RolesAnywhere** identity instead of an IAM
Identity Center profile. The broker does not care which kind it is: `aws
configure export-credentials --profile <name> --format process` resolves a
`credential_process` profile by running that profile's helper and re-emits the
result as a `Version: 1` document with `SessionToken`/`Expiration` (verified on
this host), so the same socket, cache, shim, and audit path all apply.

Host `~/.aws/config` (unchanged, operator-owned):

```ini
[profile dev-agent]
credential_process = aws_signing_helper credential-process --certificate /run/secrets/aws-pi-agent-cert --private-key /run/secrets/aws-pi-agent-key --trust-anchor-arn arn:aws:rolesanywhere:eu-north-1:… --profile-arn arn:aws:rolesanywhere:eu-north-1:… --role-arn arn:aws:iam::…:role/…
```

Operator allowlist:

```yaml
scopes:
  - worktree: /home/hugo/git/proof-of-work-reviewing-platform
    profiles: [dev-agent]
    default: dev-agent
    region: eu-north-1
    mask:
      - /run/secrets/aws-pi-agent-cert
      - /run/secrets/aws-pi-agent-key
```

Repo file (`/home/hugo/git/proof-of-work-reviewing-platform/.belayd/aws.yaml`):

```yaml
profile: dev-agent
```

How it differs from the SSO flow, and what you must get right:

- **The broker runs the helper, not the sandbox.** `aws configure
  export-credentials` shells out to `aws_signing_helper`, so the helper must be
  on the **broker's** `PATH`. `pkgs.aws-signing-helper` is in `devShellTools`,
  which is exactly what `pi-web-runtime-env` links, and the broker unit prepends
  `pi-web-runtime-env/bin` to `PATH` — so the helper arrives with the rebuild,
  not with anything you install by hand. The certificate and private key must be
  readable by the broker's user outside every sandbox. Without the helper the
  profile resolves to `command not found`, the agent's AWS call fails with that
  text, and the audit line is
  `"action":"credential_process","outcome":"error:unavailable"`.
  [How to Verify](#how-to-verify) check 6c checks both links.
- **List the certificate and key under `mask:`.** They live outside `~/.aws`, so
  masking `~/.aws` does not cover them; an agent that can read them can run
  `aws_signing_helper` itself with the (non-secret, committed) trust-anchor /
  profile / role ARNs and get the same credentials **without going through the
  allowlist**. That is the hole `mask:` closes. A mask typo refuses the scope
  rather than leaving them readable.
- **`~/.aws` is masked inside the sandbox**, so the profile name (`dev-agent`)
  only ever matters to the broker; the sandbox always sees `[profile agent]`
  and `AWS_PROFILE=agent`. A sandboxed `aws` call therefore cannot address the
  source profile by name.
- **Region must come from the allowlist** (`region:` on the scope or top level,
  else the broker unit's `AWS_REGION`/`AWS_DEFAULT_REGION`); the repo file
  carries only `profile`, and a scope with no region anywhere is refused rather
  than guessed.
- **Refreshing is automatic.** The role credentials are short-lived
  (minutes-to-hours, set by the RolesAnywhere profile's session duration) and
  the broker refreshes them on demand, so there is no 8-hour portal session and
  no 90-day PKCE registration to renew. The human-in-the-loop boundary becomes
  the **x509 certificate's own expiry**: when it lapses, the broker surfaces the
  helper's error text and someone must re-issue the certificate and key on the
  host.
- **Troubleshooting**: check the trust-anchor ARN, profile ARN, and role ARN in
  the `credential_process` line, that the helper is installed on the broker's
  `PATH` (6c), and that the certificate/key are readable outside the sandbox
  (and *unreadable* inside — that is the point). **Do not run `aws sso login`
  for a RolesAnywhere failure**: there is no portal session to refresh. The
  broker recognises the non-SSO case and appends the hint quoted in [Refresh
  expired credentials](#5-refresh-expired-credentials) — helper on `PATH`, x509
  material present and valid, ARNs re-checked — which never prescribes an SSO
  login. The broker never retries silently and never substitutes a different
  profile.

### 5. Refresh expired credentials

Two independent clocks can lapse:

- the **IAM Identity Center portal session** (default 8 h, maximum 90 days per
  your IdP configuration);
- the **PKCE client registration** (90 days), refreshed by an interactive login.

A repo scoped to an IAM RolesAnywhere `credential_process` profile has neither
clock: role credentials simply expire and the broker re-runs the helper ([Using
an IAM RolesAnywhere profile](#4a-using-an-iam-rolesanywhere-profile)). Its human
boundary is the x509 certificate's expiry, and its failures take the non-SSO
branch below.

The broker never retries silently. An agent AWS call fails with AWS's own
stderr verbatim plus one instruction line (text and exit code vary by failure;
the appended sentence is stable):

```
aws failed for profile "agent-deploy" (exit 255): 
An error occurred (UnauthorizedException) when calling the GetRoleCredentials operation: Session token not found or invalid
The IAM Identity Center session is no longer valid. Refresh it on the host, outside every sandbox: aws sso login --profile agent-deploy
```

For a failure AWS does not label as expiry you get the non-SSO variant, which
does **not** prescribe `aws sso login` (it cannot fix a broken
`credential_process`, an expired x509 certificate, or a wrong RolesAnywhere ARN):

```
No expired SSO session was reported, so an SSO login will not fix this. Check that the profile's credential_process helper is installed and executable on the broker's PATH and that the material it reads exists and is valid (for IAM RolesAnywhere: the x509 certificate and private key, re-issued if expired), and re-check the trust anchor / profile / role ARNs; if this is an IAM Identity Center profile after all, refresh its portal session on the host.
```

The only fix for an expired **IAM Identity Center** session is interactive, on
the host, outside every sandbox, as the operator:

```bash
aws sso login --profile <source-profile-named-in-the-allowlist>
```

No broker restart and no rebuild: failures are never cached, so the next request
re-resolves. To invalidate credentials deliberately (e.g. the expiry check in
[How to Verify](#how-to-verify)):

```bash
aws sso logout                     # on the host, as the operator
```

### 6. Diagnostics

**Audit log** — `$XDG_STATE_HOME/belayd/aws-audit.jsonl`, default
`~/.local/state/belayd/aws-audit.jsonl` (dir 0700, file 0600), one JSON line per
broker request:

```bash
tail -n 5 ~/.local/state/belayd/aws-audit.jsonl | jq .
```

```json
{"ts":"2026-02-11T09:14:03.412Z","scope":"1f3c9a2b7d4e","worktree":"/home/hugo/git/acme-api","profile":"agent-deploy","action":"credential_process","outcome":"ok"}
```

| `action` | Served on | `outcome` values |
|----------|-----------|------------------|
| `ensure-scope` | control socket | `ok`, `error:not-configured`, `error:refused`, `error:unavailable`, `error:already-sandboxed`, `error:listen` |
| `whoami` | control **and** scope socket | `ok` (the control variant logs empty `scope`/`worktree`/`profile` — it spans every live scope) |
| `credential_process` | scope socket | `ok`, `error:unknown-profile`, `error:unavailable` |
| `invalid` | either socket | `error:invalid-request` — a malformed or unsupported line, still audited as an access attempt |

Reading them: `error:refused` means the allowlist/repo pair disagrees (fix
config, no restart); `error:not-configured` is normal (no repo file / no
matching scope); `error:unavailable` means AWS itself failed (expiry, missing
profile, network) or the socket could not be bound; `error:already-sandboxed` is
a harmless nested-wrap attempt; `error:listen` is a scope-socket bind failure.

The log is **per scope, not per agent** — one socket per scope means there is no
caller identity. It never contains credential material: the entry type has no
field that could carry it. Confirm:

```bash
grep -cE 'SecretAccessKey|SessionToken|AccessKeyId' ~/.local/state/belayd/aws-audit.jsonl   # 0
```

**Broker journal:**

```bash
journalctl -u pi-web-aws-broker -f
# aws-broker: listening on /run/belayd/aws/control.sock
```

**CLI** (three subcommands — there is deliberately no `belayd-aws whoami`; use
the sockets below):

```bash
belayd-aws ensure-scope --worktree "$PWD"
# /run/belayd/aws/<scopeId>/sock        (starts the scope socket on demand)

belayd-aws plan --worktree "$PWD" | head -3
# /nix/store/<hash>-bubblewrap-0.11.2/bin/bwrap
# --unshare-user
# --die-with-parent
```

`plan` prints the argv prefix the shell wrapper uses and exits 1 with the
refusal reason on **stderr** (nothing on stdout) when the repo is refused — that
is the quickest "is this repo opted in and allowed?" probe. `plan` and
`ensure-scope` both fail with an actionable message when the broker is down
(`Start it with: systemctl start pi-web-aws-broker`).

**Socket round trip** (libressl `nc` is on the runtime PATH and supports `-U`):

```bash
printf '{"action":"whoami"}\n' | nc -U /run/belayd/aws/<scopeId>/sock
# {"ok":true,"scope":"<scopeId>","worktree":"/home/hugo/git/acme-api","profile":"agent-deploy","sandboxProfile":"agent"}

printf '{"action":"whoami"}\n' | nc -U /run/belayd/aws/control.sock
# {"ok":true,"pid":<pid>,"scopes":[{"scopeId":"…","worktree":"…","profile":"…","sandboxProfile":"agent","socketPath":"…"}]}
```

### 7. Roll back

One line in `nixosModules.pi-web` (`ExecStart` back to
`${pi-web}/bin/pi-web-sessiond`), `nixos-rebuild switch`, then restart both
units — full sequence in [Rollback](#rollback).

### 8. Not available by design

| Not available | Detail |
|---------------|--------|
| Static / long-lived credentials | `aws configure export-credentials` omits `SessionToken`/`Expiration` for long-lived IAM-user keys; the broker refuses with a message naming the real fix: `aws returned long-lived credentials (no SessionToken); … a credential_process profile (including IAM RolesAnywhere) or an SSO/assumed-role profile is fine, long-lived IAM-user keys are not …`. Only temporary/role credentials are served. |
| MFA prompts | MFA happens in your interactive `aws sso login` on the host. The broker never prompts and never blocks waiting for a human. |
| `AssumeRole` / session policies / role chaining from inside the sandbox | The scope socket serves `credential_process` and `whoami` only; anything else is `unsupported action …; this socket only serves "credential_process" and "whoami"` with no credential lookup. The profile's IAM permission set is the entire grant. |
| Per-agent attribution | The audit log is per scope (`worktree` + `profile` + time), never "which session". |
| Network egress control | An agent holding scoped credentials can use them within the role's permissions. Least privilege lives in the IAM permission set chosen per repo, plus the allowlist. |
| `aws sso login` inside a session | Impossible by construction (masked `~/.aws`); the human-in-the-loop boundary is the point. |
| Operator-allowlist secrecy | `~/.config/belayd/aws.yaml` is **not** masked (it holds profile *names* and mask *paths*, not secrets). A sandboxed agent can read it, but it cannot use it: the control socket is masked, its own scope socket serves exactly one profile, and every path listed under `mask:` is hidden from it. What is masked is therefore operator-controlled, never repo-controlled. |
| Masking arbitrary credential locations automatically | Only `~/.aws`, `~/.config/aws`, the broker runtime base, and the allowlist's `mask:` entries are masked. Any other credential store (a second keyring, a tool-specific cache) is readable unless the operator adds it to `mask:`. |

The honest limits (same-uid siblings, orchestrator vs child, `bwrap` not being a
hostile-code boundary) are listed once in [Residual risks](#residual-risks) —
read that before claiming a stronger property than the code provides.

## Rollback

1. In `flake.nix`, `nixosModules.pi-web`: replace the `pi-web-sessiond`
   `ExecStart` block with `ExecStart = "${pi-web}/bin/pi-web-sessiond";` and
   optionally remove the `pi-web-aws-broker` service.
2. `nixos-rebuild switch`.
3. `sudo systemctl restart pi-web-sessiond pi-web-aws-broker`.

That restores the previous behaviour in one rebuild. Nothing in the repo or the
broker's runtime state has to be undone: the broker's sockets and scope dirs
live under its runtime base (`/run/belayd/aws` via the unit's `RuntimeDirectory`
and `BELAYD_AWS_RUNTIME_BASE_DIR`, or `<XDG_RUNTIME_DIR>/belayd/aws` on the
fallback path), and the unit's `RuntimeDirectory` is removed when it stops.

## How to Verify

An acceptance checklist an operator can run end to end in ~5 minutes after
`nixos-rebuild switch` + restarting both units. Checks 1–8 are the fast pass;
9–11 are the pre-delivery gates. Each check states the command, the expected
result, and what a failure means.

### 1. Units are active and the session daemon is wrapped

```bash
sudo systemctl is-active pi-web-sessiond pi-web-aws-broker pi-web
systemctl show pi-web-sessiond -p ExecStart
```

Expected: three `active` lines; `ExecStart` contains
`/nix/store/<hash>-bubblewrap-*/bin/bwrap --unshare-user --die-with-parent
--bind / / --dev-bind /dev /dev --proc /proc --tmpfs <home>/.aws
--tmpfs <home>/.config/aws -- /nix/store/<hash>-pi-web-*/bin/pi-web-sessiond`.

Failure: `ExecStart` without `bwrap` ⇒ the mask is off — either the module is
not enabled (`services.belayd-pi-web.enable`), the rebuild did not switch, or
`ExecStart` was reverted. `pi-web-aws-broker` inactive ⇒ no repo has AWS
(`journalctl -u pi-web-aws-broker -b`).

### 2. The broker is *not* sandboxed

```bash
systemctl show pi-web-aws-broker -p ExecStart
journalctl -u pi-web-aws-broker -b | grep listening
```

Expected: `ExecStart=…/bin/belayd-aws-broker` with no `bwrap`, and
`aws-broker: listening on /run/belayd/aws/control.sock`.

Failure: a wrapped broker cannot read `~/.aws`, so every credential request
returns `error:unavailable` — that is a misconfiguration, not a hardening win.

### 3. An opted-in agent session sees only the synthetic profile

In the agent's bash tool / pi-web terminal, inside a repo with a committed
`.belayd/aws.yaml` whose profile the allowlist grants:

```bash
cat ~/.aws/config
ls -A ~/.aws
ls ~/.aws/sso
aws sso login; echo "exit=$?"
aws sts get-caller-identity
```

Expected: only `[profile agent]` (with `credential_process` + `region`);
`ls -A ~/.aws` prints `config` and nothing else; `ls ~/.aws/sso` says
`No such file or directory`; `aws sso login` exits non-zero; STS returns the
repo's scoped role.

Failure meanings:
- STS returns the operator's *normal* identity ⇒ the command is not sandboxed.
  Check `env | grep BELAYD_SANDBOX_ACTIVE` (must be `1`), look for
  `belayd-shell: belayd-aws:` on stderr, and run `belayd-aws plan --worktree "$PWD"`.
- `aws sso login` succeeds ⇒ the `~/.aws` mask is missing (check 1).
- STS fails with the expiry sentence ⇒ credentials need a host login (check 11).
  A RolesAnywhere scope instead gets the non-SSO hint (check 6a).

### 4. Unit-level masking, from the orchestrator namespace

Run this in a session on a repo with **no** `.belayd/aws.yaml`, so the per-repo
wrap is absent and you measure the `pi-web-sessiond` mask itself:

```bash
ls ~/.aws/sso
cat ~/.aws/config
readlink /proc/self/ns/mnt
```

Expected: both reads are `No such file or directory`, and the mount-namespace
id differs from a host terminal running the same `readlink`.

Failure: if `~/.aws/sso` is readable in such a session, the unit-level mask is
off (check 1) — every orchestrator tool in **every** session can then read the
operator's SSO cache, including repos that never opted in. (Run this check only
where no `.belayd/aws.yaml` is present, otherwise you are measuring the
per-repo mask, not the unit mask.)

### 5. Per-repo sockets: own scope connects, control and sibling do not

On the host (or from the orchestrator), resolve the socket paths:

```bash
belayd-aws ensure-scope --worktree ~/git/acme-api      # → /run/belayd/aws/<idA>/sock
belayd-aws ensure-scope --worktree ~/git/acme-infra    # → /run/belayd/aws/<idB>/sock
```

Then, from the **sandboxed** agent inside `acme-api`:

```bash
ls /run/belayd/aws
printf '{"action":"whoami"}\n' | nc -U /run/belayd/aws/<idA>/sock
printf '{"action":"whoami"}\n' | nc -U /run/belayd/aws/control.sock
printf '{"action":"whoami"}\n' | nc -U /run/belayd/aws/<idB>/sock
```

Expected: `ls` shows only `<idA>`; the own socket answers
`{"ok":true,…,"profile":"<allowlisted profile>","sandboxProfile":"agent"}`; the
control socket and the sibling socket both fail with
`nc: …: No such file or directory` (exit 1).

Failure: if the control socket connects from a sandboxed agent, the runtime-base
mask is missing and that agent can request **any** allowlisted scope. If the
sibling socket connects, the same. This check is the security property, not a
nicety.

### 6. Allowlisted masks hide RolesAnywhere material, the broker still resolves the profile, and the helper is on its PATH

This is the IAM RolesAnywhere set
([Using an IAM RolesAnywhere profile](#4a-using-an-iam-rolesanywhere-profile)). All
of it happens in one repo whose scope grants `dev-agent`, sets
`region: eu-north-1`, and lists the x509 material under `mask:`
([Mask entries](#mask-entries)):

```yaml
# ~/.config/belayd/aws.yaml (excerpt)
scopes:
  - worktree: /home/hugo/git/proof-of-work-reviewing-platform
    profiles: [dev-agent]
    region: eu-north-1
    mask:
      - /run/secrets/aws-pi-agent-cert
      - /run/secrets/aws-pi-agent-key
```

#### 6a. Inside the sandbox the cert and key are `EACCES` and AWS still works

From the **sandboxed** agent in that repo:

```bash
cat /run/secrets/aws-pi-agent-cert; echo "exit=$?"     # Permission denied, exit 1
cat /run/secrets/aws-pi-agent-key;  echo "exit=$?"     # Permission denied, exit 1
ls -l /run/secrets                                     # both entries exist, they just cannot be opened
cat /run/secrets/<some-unlisted-file>                  # unlisted siblings stay readable
aws sts get-caller-identity                            # still succeeds, via the broker
```

Expected: exit 1 with `cat: …: Permission denied` for both listed files,
`ls -l` lists them, an unlisted sibling is readable (the mask is per entry, not
per directory), and STS returns the repo's RolesAnywhere role.

Failure meanings:
- the certificate is readable ⇒ `mask:` does not list it, the entry does not
  resolve (`realpath`), or the plan was not applied at all. Run
  `belayd-aws plan --worktree "$PWD"` and look for
  `--ro-bind /dev/null /run/secrets/aws-pi-agent-cert` (a directory mask would
  be `--tmpfs`), and check `env | grep BELAYD_SANDBOX_ACTIVE` is `1`.
- STS fails ⇒ read the failure text in the agent's tool output (it carries the
  broker's message, the broker journal does not log per-request failures):
  `command not found` means the helper is missing from the broker's `PATH`
  (6c); an x509 or ARN error means fix the `credential_process` line. Either way
  the audit line is
  `"action":"credential_process","outcome":"error:unavailable"`.

#### 6b. The broker still resolves the profile, from outside the sandbox

```bash
aws configure export-credentials --profile dev-agent --format process \
  | jq -r '.Version, (.SessionToken != null)'
belayd-aws ensure-scope --worktree ~/git/proof-of-work-reviewing-platform
```

Expected: `1` then `true` (a `Version`-1 document with a session token, which is
what the broker requires), and `ensure-scope` prints the scope socket path.

Failure: exit 1 on the first command ⇒ the host cannot resolve `dev-agent`
either, and the helper's own stderr names the cause (missing certificate,
expired x509, wrong ARN). `false` for `SessionToken` ⇒ a static-IAM-key profile,
which the broker refuses by design
([Not available by design](#8-not-available-by-design)) — issue a role
credential instead.

#### 6c. `aws_signing_helper` is on the **broker's** `PATH`

```bash
systemctl show pi-web-aws-broker -p Environment | tr ' ' '\n' | grep 'PATH='
env=$(nix build .#pi-web-runtime-env --print-out-paths --no-link)
ls -l "$env/bin/aws_signing_helper"
```

Expected: one `PATH=<…>-pi-web-runtime-env/bin:/run/current-system/sw/bin:…`
line (the property prints as a single `Environment=…` string, split on spaces
here), and `ls` prints `aws_signing_helper` as executable.

Failure meanings:
- `PATH` without `pi-web-runtime-env/bin` ⇒ the unit's `environment` list
  regressed, so `aws configure export-credentials` cannot find the helper and
  *every* RolesAnywhere request fails with `command not found`.
- the helper is missing from that `bin` ⇒ `pkgs.aws-signing-helper` left
  `devShellTools`; `nix build .#pi-web-runtime-env` is the direct check for that,
  and a fixed flake needs `nixos-rebuild switch` plus
  `sudo systemctl restart pi-web-aws-broker`.
- the helper is absent from a **session's** own `PATH` but present here: not a
  failure — the broker runs it, never the sandbox.

#### 6d. A deliberately bad `mask:` entry voids the scope, with the documented message

Add a typo'd entry to that scope's `mask:` block (or, if the scope uses the flow
form, append it inside the brackets), then replan — and restore the real entry
afterwards:

```bash
belayd-aws plan --worktree ~/git/proof-of-work-reviewing-platform; echo "exit=$?"
```

Expected: exit 1, **stdout empty**, and stderr

```
belayd-aws: mask entry "/run/secrets/does-not-exist.pem" does not exist or cannot be resolved; a mask typo would leave it readable, so the scope is refused — fix or remove the entry (in /home/<user>/.config/belayd/aws.yaml)
```

In a shell inside that repo the command still runs — unwrapped, with no AWS:
`belayd-shell` prints `belayd-shell: mask entry …`, the sub-agent warning reads
`[belayd-harness] AWS sandbox refused for <dir>: …`, `env | grep
BELAYD_SANDBOX_ACTIVE` is empty, and the audit line is
`"action":"ensure-scope","outcome":"error:refused"`.

Failure meanings:
- the plan exits 0 ⇒ the entry was accepted: treat it as a security bug, not a
  docs bug.
- the scope still runs sandboxed with the remaining entries ⇒ the refusal was
  downgraded to a partial mask, which is the same bug.
- the message names a *different* rule (relative path, `$HOME`, a parent of the
  worktree, …) ⇒ that is still a correct refusal; the full list with each
  message is in [Mask entries](#mask-entries).

### 7. Refusal names the allowed profiles, and the allowlist fix needs no restart

Do this in an opted-in repo (check 5 uses one); it rewrites that repo’s
committed `.belayd/aws.yaml`, so restore the real profile afterwards.

```bash
printf 'profile: agent-deploy\n' > .belayd/aws.yaml     # not granted for this worktree
belayd-aws plan --worktree "$PWD"; echo "exit=$?"
```

Expected: exit 1, stdout empty, stderr

```
belayd-aws: profile "agent-deploy" is not permitted for worktree /home/hugo/git/acme-api (allowed: agent-readonly)
```

In a session the same reason appears twice-prefixed (`belayd-shell:
belayd-aws: …` per shell invocation, `[belayd-harness] AWS sandbox refused for
<dir>: …` per spawn) and the command still runs, unwrapped and without AWS.

Now add `agent-deploy` to that scope's `profiles:` in
`~/.config/belayd/aws.yaml` and re-run:

```bash
belayd-aws plan --worktree "$PWD" >/dev/null; echo "exit=$?"     # 0
```

Expected: exit 0 immediately — no broker restart, no rebuild, no session
restart. Failure: still refused ⇒ the allowlist edit went to the wrong scope
(first matching glob wins) or the file failed to parse
(`invalid allowlist …: line N: …`).

### 8. Audit log: one line per request, 0600, no credential material

```bash
stat -c '%a %n' ~/.local/state/belayd/aws-audit.jsonl
tail -n 3 ~/.local/state/belayd/aws-audit.jsonl | jq -c .
grep -cE 'SecretAccessKey|SessionToken|AccessKeyId' ~/.local/state/belayd/aws-audit.jsonl
```

Expected: mode `600`; each line has exactly
`{ts, scope, worktree, profile, action, outcome}`; the grep prints `0`. The
refusal from check 7 appears as `"action":"ensure-scope","outcome":"error:refused"`
with `"profile":""`.

Failure: any credential field ⇒ stop and treat it as a leak. Missing lines ⇒
the state dir is not writable (`journalctl -u pi-web-aws-broker` reports
`could not write audit log`), which is non-fatal by design but blind.

### 9. Regression: the host still works

```bash
nix develop -c true
git push --dry-run            # SSH signing
bd ready
```

Plus, from a session: `ps -axo pid | head -3` (shared pid namespace), a `/tmp`
unix socket, the pi-web terminal, plugin `runCommand`, and the dolt liveness
check.

Expected: all unchanged — only the user namespace is unshared, `/tmp`, `/dev`,
`/proc`, pid, ipc, and net stay shared.

Failure: `ps`/dolt liveness failing or `/tmp` empty ⇒ pid/ipc/net were unshared
or `/tmp` was masked; `git push` failing on signing ⇒ `~/.ssh` or
`SSH_AUTH_SOCK` was masked (it must not be).

### 10. Automated gates

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build \
  && nix build .#belayd-harness
```

Expected: all pass. `test/aws-sandbox.integration.test.ts` and
`test/aws-broker.integration.test.ts` self-skip with
`Skipping integration test:` when `bwrap`, `git`, `direnv`, or `jq` are absent —
**a skip is not a pass**; re-run inside `nix develop`.

### 11. Expiry behaviour (needs a live SSO session)

On the host:

```bash
aws sso logout
```

Then in the sandboxed agent:

```bash
aws sts get-caller-identity
tail -n 2 ~/.local/state/belayd/aws-audit.jsonl | jq -c .
```

Expected: AWS's own error text plus
`The IAM Identity Center session is no longer valid. Refresh it on the host,
outside every sandbox: aws sso login --profile <source-profile>`; the audit line
is `"action":"credential_process","outcome":"error:unavailable"`.

Restore with a host `aws sso login --profile <source-profile>`; the next agent
call succeeds **without** a broker restart (failures are never cached).

Failure: no `aws sso login` sentence ⇒ the error mapping regressed; still
failing after the host login ⇒ the broker is not running as the uid that owns
the token (`systemctl show pi-web-aws-broker -p User`).

## Tests

- Unit (`src/__tests__/`): `aws-broker-config` (allowlist/repo parsing, globs,
  `mask:` parsing and every mask refusal), `aws-broker-scope` (scope ids, paths,
  argv order and the runtime-base mask, file masks as `--ro-bind /dev/null`,
  env scrub, `BELAYD_AWS_RUNTIME_BASE_DIR` resolution),
  `aws-broker-plan` (generated-file quoting, `unavailable` on a missing
  bwrap/runtime base, `already-sandboxed`, region refusal message),
  `aws-broker-cache` (single-flight, skew, LRU, failure propagation),
  `aws-broker-client` (document shape, static-credential refusal, the expiry vs
  non-SSO failure hints), `aws-broker-server` (request handling, socket modes,
  concurrent-bind serialization and umask restore, audit warnings),
  `flake-aws-isolation` (bubblewrap/awscli2/aws-signing-helper in
  `devShellTools`, `pi-web-runtime-env/bin` on the broker's `PATH`, the
  sessiond/broker unit wiring), and the `spawn.test.ts`
  AWS-env/argv/broker-unavailable cases.
- Integration (`test/`): `aws-sandbox.integration.test.ts` (SSO-cache masking,
  allowlisted file masks reading `EACCES` and directory masks reading empty
  through a symlinked path, a mask refusal relayed through the real wrapper as
  an unwrapped run with the reason on stderr, control-socket and sibling-scope
  unreachability with a live own-scope connection, inherited-env scrub, host
  `/tmp` + shared pid namespace, and devShell resolution through direnv inside
  the sandbox) and `aws-broker.integration.test.ts` (plan/ensure-scope on
  demand, concurrent ensure-scope serialization, shim round trip through bwrap
  with a *masked* RolesAnywhere cert, refusal paths, and audit lines for allowed
  and refused requests). Both use `it.skipIf` for missing prerequisites — a skip
  is **not** a pass.
