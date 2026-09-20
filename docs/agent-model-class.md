# Explicit agent model classes

`AgentDefinition` includes the `AgentModelSpec` mutually exclusive union:

```typescript
type AgentModelSpec =
  | { model: string; modelClass?: never }
  | { model?: never; modelClass: ModelClass };
```

An agent declares EITHER an explicit `model` OR a `modelClass` capability tier;
TypeScript rejects both fields together. A `modelClass` resolves to its class
primary model (the first model entry on the first-preference provider). An
explicit `model` is used as requested and derives a class through
`MODEL_TO_CLASS` when it is known, so quota-fallback routing remains available.
Unknown explicit models have no class-derived fallback. The valid tiers are
`frontier`, `standard`, and `fast`.

## How to Verify

Run these commands from the repository root. Run each command to completion:

1. ```bash
   pnpm test
   ```
   Expected: 465 unit tests pass; Vitest exits with status 0. This includes
   the model-class, agent-registry, spawn-fallback, and extension
   phase-threading tests.

2. ```bash
   pnpm test:integration
   ```
   Expected: 18 integration tests pass and Vitest exits with status 0.

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
- The nine default agents resolve to their class primary as first-choice
  models and use these classes for fallback routing:

  | Agent | Class primary (first-choice model) |
  | --- | --- |
  | `belayd-scout` | `fast` → `opencode-go/mimo-v2.5` |
  | `belayd-planner` | `frontier` → `opencode-go/deepseek-v4.1-flash` |
  | `belayd-implementer` | `frontier` → `opencode-go/deepseek-v4.1-flash` |
  | `belayd-reviewer` | `standard` → `opencode-go/glm-5.2` |
  | `belayd-tester` | `standard` → `opencode-go/glm-5.2` |
  | `belayd-userguide` | `frontier` → `opencode-go/deepseek-v4.1-flash` |
  | `belayd-proof-generator` | `fast` → `opencode-go/mimo-v2.5` |
  | `belayd-documenter` | `frontier` → `opencode-go/deepseek-v4.1-flash` |
  | `belayd-committer` | `fast` → `opencode-go/mimo-v2.5` |

The tier-to-primary mapping used by `primaryModelOf` is:

| `modelClass` | Primary model |
| --- | --- |
| `frontier` | `opencode-go/deepseek-v4.1-flash` |
| `standard` | `opencode-go/glm-5.2` |
| `fast` | `opencode-go/mimo-v2.5` |

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
  modelClass: "fast",
  tools: ["read", "grep", "find", "ls", "bash", "ast_grep"],
  systemPrompt: "Investigate the repository and return concise, cited findings.",
};
```

Alternatively, pin an explicit model instead of a class (never both):

```typescript
const customAgent: AgentDefinition = {
  name: "belayd-custom-reviewer",
  description: "Review repository changes",
  model: "opencode-go/glm-5.2",
  tools: ["read", "grep", "find", "ls", "ast_grep"],
  systemPrompt: "Review the changes and report actionable findings.",
};
```

The model arm still receives class-derived fallback for known models:
`resolveModelSpec({ model: "opencode-go/glm-5.2" })` returns
`{ model: "opencode-go/glm-5.2", modelClass: "standard" }`. An unknown
explicit model has `modelClass: undefined` and is attempted as-is without
class expansion. To use a fallback class for an otherwise unknown model,
declare the `modelClass` arm instead.

### Resolve fallback candidates explicitly

Use `candidatesForModel(model, modelClass?)` when constructing or inspecting a
fallback list. To resolve an `AgentDefinition`'s declaration into its concrete
spawn pair, use `resolveModelSpec` (and `primaryModelOf` for the class
primary directly):

```typescript
import { candidatesForModel, primaryModelOf, resolveModelSpec } from "belayd-agent-harness";

primaryModelOf("fast");
// "opencode-go/mimo-v2.5"

resolveModelSpec({ modelClass: "standard" });
// { model: "opencode-go/glm-5.2", modelClass: "standard" }

resolveModelSpec({ model: "vendor/x" });
// { model: "vendor/x", modelClass: undefined }
```

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

Workflow overrides are modifiers on the selected agent, not `AgentModelSpec`.
Their `model` and `modelClass` fields are independent and may be set either
individually or together:

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
`opencode-go/deepseek-v4.1-flash` with class `frontier`:

| Override `model` | Override `modelClass` | Effective class | Result |
| --- | --- | --- | --- |
| absent | absent | Agent's `frontier` | The agent's declared tier is used. |
| set | absent | Derived from override model | The override model replaces the agent model; its own known class is derived. Unknown models stay class-of-one. |
| absent | set | Explicit override class | The explicit class replaces the agent class, even if it differs from the agent model's implicit class. |
| set | set | Explicit override class | The explicit class wins over both the agent class and the override model's implicit class. |

For example, an implement override of `{ model: "opencode-go/glm-5.2" }`
passes no explicit class, so it derives `standard`; an override of
`{ model: "opencode-go/glm-5.2", modelClass: "fast" }` uses `fast` instead.
