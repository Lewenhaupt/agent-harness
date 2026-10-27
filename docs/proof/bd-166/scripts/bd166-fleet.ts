// usage: jiti bd166-fleet.ts <harness-checkout> <cwd> '<json [[tool,args],…]>' [waitMs]
interface FleetTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text: string }>;
    details: { exitCode: number };
  }>;
}
const [repo, cwd, stepsJson, waitMs = "0"] = process.argv.slice(2);
if (repo === undefined || cwd === undefined)
  throw new Error("usage: <repo> <cwd> <steps> [waitMs]");
const steps = JSON.parse(stepsJson ?? "[]") as Array<[string, unknown]>;
const mod = (await import(`${repo}/extensions/index.ts`)) as { default: (api: unknown) => void };
const tools = new Map<string, FleetTool>();
const notifications: Array<{ message: string; level?: string }> = [];
const api = {
  registerTool: (def: FleetTool & { name: string }) => tools.set(def.name, def),
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => [],
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);
const ctx = {
  cwd,
  ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  sessionManager: {
    getSessionId: () => "demo-session",
    getSessionName: () => "fleet-supervisor-demo",
    getSessionFile: () => `${cwd}/session.jsonl`,
  },
};
async function run(name: string, args: unknown): Promise<void> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`${name} was not registered`);
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  const result = await tool.execute("doc", args, undefined, undefined, ctx);
  console.log(result.content.map((part) => part.text).join("\n"));
  console.error(`[${name} exit=${result.details.exitCode}]`);
}
for (const [name, args] of steps) await run(name, args);
if (Number(waitMs) > 0) {
  // The run loop is a timer inside this process; keep it alive so ticks happen.
  console.log(`\n… letting the supervisor ticker run for ${waitMs} ms`);
  await new Promise((resolve) => setTimeout(resolve, Number(waitMs)));
  await run("belayd_fleet_status", {});
}
if (notifications.length > 0)
  console.log("\nnotifications:", JSON.stringify(notifications, null, 2));
process.exit(0);
