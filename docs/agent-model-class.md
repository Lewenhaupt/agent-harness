# Explicit agent model classes

`AgentDefinition.modelClass` gives an agent an explicit capability tier for
quota fallback routing. The valid tiers are `frontier`, `standard`, and `fast`.
The requested model is still tried first; the class controls the candidates
used after a quota or transient failure.

## How to Verify

Run these commands from the repository root. Run each command to completion:

1. ```bash
   pnpm test
   ```
   Expected: Vitest exits with status 0. This includes the model-class,
   agent-registry, spawn-fallback, and extension phase-threading tests.

2. ```bash
   pnpm test:integration
   ```
   Expected: all integration tests pass and Vitest exits with status 0.

3. ```bash
   pnpm typecheck
   ```
   Expected: `tsc --noEmit` exits with status 0 and reports no TypeScript
   errors.

4. ```bash
   pnpm lint
   ```
   Expected: Biome exits with status 0 and reports no diagnostics.

5. ```bash
   pnpm build
   ```
   Expected: TypeScript exits with status 0 and emits the updated library
   files under `dist/`.

For a runtime check, start pi with the Belayd extension loaded and run a
feature workflow:

```text
/belayd bd-X feature
```

Use a real Beads task ID in place of `bd-X`. Add `--no-worktree` when the
workflow should run in the current directory:

```text
/belayd bd-X feature --no-worktree
```

Expected behavior:

- Pi reports that the Belayd feature workflow started, then the orchestrator
  invokes the phase tools in order (`belayd_scout`, `belayd_plan`,
  `belayd_implement`, and so on).
- The nine default agents retain their configured first-choice models and use
  these classes for fallback routing:

  | Agent | First-choice model class |
  | --- | --- |
  | `belayd-scout` | `fast` |
  | `belayd-planner` | `frontier` |
  | `belayd-implementer` | `frontier` |
  | `belayd-reviewer` | `standard` |
  | `belayd-tester` | `standard` |
  | `belayd-userguide` | `frontier` |
  | `belayd-proof-generator` | `fast` |
  | `belayd-documenter` | `frontier` |
  | `belayd-committer` | `fast` |

- On a quota or transient failure, the next attempt stays within that class:
  the alternate provider for the same model is preferred before another model
  in the class. A successful result may include a trailing
  `[belayd model fallback] ...` note showing the attempted models. With no
  failure, no fallback note is added.
- Inspect persistent sub-agent sessions, if needed, with:

  ```bash
  pi --resume | grep belayd-bd-X
  ```

To verify a workflow model override, use a fresh task with a workflow that has
one. For example:

```text
/belayd bd-X documentation --no-worktree
```

The documentation workflow overrides its implement model to
`opencode-go/deepseek-v4-flash`. Because that override does not declare a
`modelClass`, its class is derived from the override model (`fast`), not copied
from the implementer agent's default (`frontier`). The same behavior applies
to the implement override in the `hotfix` workflow. The default feature
workflow, which has neither override, uses each agent's declared class.

## How to Use

### Declare a class on a custom agent

Set `modelClass` when registering a custom `AgentDefinition`. Use a class that
matches the capability and cost you want to preserve during fallback:

```typescript
import type { AgentDefinition } from "belayd-agent-harness";

const customAgent: AgentDefinition = {
  name: "belayd-custom-scout",
  description: "Fast repository investigation",
  model: "vendor/my-recon-model",
  modelClass: "fast",
  tools: ["read", "grep", "find", "ls", "bash", "ast_grep"],
  systemPrompt: "Investigate the repository and return concise, cited findings.",
};
```

`modelClass` is optional for compatibility. If it is omitted, a known model is
classified through `MODEL_TO_CLASS`; an unknown model remains a single
candidate unless a class is supplied explicitly.

### Resolve fallback candidates explicitly

Use `candidatesForModel(model, modelClass?)` when constructing or inspecting a
fallback list:

```typescript
import { candidatesForModel } from "belayd-agent-harness";

const candidates = candidatesForModel("opencode-go/glm-5.3", "fast");
// [
//   "opencode-go/glm-5.3",        // requested model always comes first
//   "opencode-go/mimo-v2.5",
//   "llmgateway/mimo-v2.5",
//   "opencode-go/deepseek-v4-flash",
//   "llmgateway/deepseek-v4-flash",
//   "opencode-go/glm-5.2",
//   "llmgateway/glm-5.2",
// ]
```

The explicit `fast` class wins even though `glm-5.3` is implicitly a
`frontier` model. An explicit class also expands an otherwise unknown
model:

```typescript
candidatesForModel("vendor/my-model", "standard");
// starts with "vendor/my-model", followed by the standard-class candidates
```

Without an explicit class, a provider-qualified or bare known model derives
its class from its bare model ID. A bare known ID remains first as supplied;
an unknown model returns `[model]`.

### Pass the class through the fallback spawner

`spawnAgentWithFallback` accepts the same explicit class. It uses the class to
build candidates, but removes `modelClass` before calling the low-level
`spawnAgentProcess` API:

```typescript
import { spawnAgentWithFallback } from "belayd-agent-harness";

const { result, attempts } = await spawnAgentWithFallback({
  model: "vendor/my-model",
  modelClass: "frontier",
  tools: ["read", "grep"],
  systemPrompt: "You are a specialist.",
  task: "Complete the assigned task.",
});
```

An explicit `candidates` array still takes precedence over `modelClass`.

### Configure a workflow override

Workflow overrides can set either field independently or both:

```typescript
import type { WorkflowSubTypeConfig } from "belayd-agent-harness";

const workflowOverrides: WorkflowSubTypeConfig["agentOverrides"] = {
  implement: {
    model: "vendor/my-model",
    modelClass: "standard",
  },
};
```

When the extension starts a phase and when it retries that phase after a
quality-gate failure, it passes the same effective model/class pair to
`spawnAgentWithFallback`.

### Four-branch override matrix

Assume the agent defaults to model
`opencode-go/deepseek-v4-pro` with class `frontier`:

| Override `model` | Override `modelClass` | Effective class | Result |
| --- | --- | --- | --- |
| absent | absent | Agent's `frontier` | The agent's declared tier is used. |
| set | absent | Derived from override model | The override model replaces the agent model; its own known class is derived. Unknown models stay class-of-one. |
| absent | set | Explicit override class | The explicit class replaces the agent class, even if it differs from the agent model's implicit class. |
| set | set | Explicit override class | The explicit class wins over both the agent class and the override model's implicit class. |

For example, an implement override of `{ model: "opencode-go/glm-5.2" }`
passes no explicit class, so it derives `standard`; an override of
`{ model: "opencode-go/glm-5.2", modelClass: "fast" }` uses `fast` instead.
