// Test world: one local repository service with three namespaces, three
// nodes with separate stores and keys, and an in-memory transport that
// serializes every envelope.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/local/git-service.ts";
import { OrgNode, type LogEvent, type NodeConfig } from "../src/node/node.ts";
import { MemoryStore } from "../src/node/store.ts";
import { MemoryTransport } from "../src/node/transport.ts";
import { runAgent, type AgentTask } from "../src/agents/run.ts";
import { ScriptedModel, type ScriptedEdit } from "../src/agents/scripted.ts";
import type { Input } from "../src/core/types.ts";

export const ORGS = ["a", "b", "c"] as const;
export type Org = (typeof ORGS)[number];

export class Clock {
  t = Date.UTC(2026, 9, 12, 9, 0, 0);
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

export interface World {
  svc: GitService;
  transport: MemoryTransport;
  nodes: Record<Org, OrgNode>;
  stores: Record<Org, MemoryStore>;
  logs: LogEvent[];
  clock: Clock;
  baseline: string;
  edits: Record<string, ScriptedEdit>;
  agent(org: Org, t: Partial<AgentTask> & { agent: string; line: string; files: string[]; text?: string; inputs?: Input[]; provides?: string[] }): Promise<string>;
  restart(org: Org): Promise<OrgNode>;
}

export function config(org: string, extraActors: { name: string; kind: "person" | "agent" }[] = []): NodeConfig {
  return {
    org, deployment: "test", collaboration: "shared-sdk", url: `https://${org}.test/`, alg: "Ed25519",
    integrator: "c", integrationRepo: "c/shared-sdk",
    actors: [{ name: `${org}.lead`, kind: "person" }, ...["1", "2", "3", "4", "5", "1r", "2r", "3r", "4r", "5r"].map(n => ({ name: `${org}${n}`, kind: "agent" as const, delegate: `${org}.lead` })), ...extraActors],
  };
}

export async function world(): Promise<World> {
  const clock = new Clock();
  const svc = new GitService(mkdtempSync(join(tmpdir(), "kyoei-test-")), clock.now);
  const transport = new MemoryTransport();
  const logs: LogEvent[] = [];
  const stores = { a: new MemoryStore(), b: new MemoryStore(), c: new MemoryStore() };
  const creds: Record<string, string> = {};
  const make = async (org: Org) => {
    creds[org] ??= svc.addNamespace(org);
    const node = new OrgNode({ config: config(org), store: stores[org], host: svc.binding(org, creds[org]!), transport, now: clock.now, log: e => logs.push(e) });
    await node.init();
    transport.nodes.set(org, node);
    return node;
  };
  const nodes = { a: await make("a"), b: await make("b"), c: await make("c") };
  for (const x of ORGS) for (const y of ORGS) if (x !== y) await nodes[x].pin(nodes[y].identity(), nodes[y].identity().fingerprint);
  // The integrator seeds shared-sdk and releases it to A and B.
  const c = nodes.c;
  const { repo } = await c.host.create("shared-sdk");
  const w = await c.host.mint(repo, "write", 60_000);
  const seed = await c.host.commit(repo, w.secret, { base: "", author: "c.lead", message: "seed", write: [
    { path: "README.md", text: "# shared-sdk\n" },
    { path: "src/retry.ts", text: "export const retries = 3;\n" },
    { path: "src/sign.ts", text: "export {};\n" },
    { path: "src/client.ts", text: "export const timeout = 0;\n" },
    { path: "src/ratelimit.ts", text: "export const burst = 1;\n" },
  ] });
  c.setMainBase(seed);
  const base = await c.register({ agent: "c.lead", repo, commit: seed, base: seed, files: ["README.md"], task: "seed shared-sdk", rationale: "baseline", inputs: [], provides: [], model: null, prompt: null, line: "c0", version: 1, writeToken: w.secret });
  await c.release("c.lead", base.id, ["a", "b"], ["contribute"], 12 * 3600_000);
  await c.flush();
  const edits: Record<string, ScriptedEdit> = {};
  const W: World = {
    svc, transport, nodes, stores, logs, clock, baseline: base.id, edits,
    async agent(org, t) {
      const node = W.nodes[org];
      const key = t.key ?? `${t.agent}-${t.line}-${Math.random().toString(16).slice(2, 8)}`;
      edits[key] = { files: t.files.map(path => ({ path, text: t.text ?? `// ${t.line} ${t.version ?? 1} ${path}\n` })), rationale: `edit by ${t.agent}` };
      const task: AgentTask = { key, agent: t.agent, line: t.line, version: t.version ?? 1, task: t.task ?? `work on ${t.line}`, files: t.files, inputs: t.inputs ?? [], provides: t.provides ?? [], edit: key };
      node.delegateTask(`${org}.lead`, task);
      const sharedToken = async () => (org === "c" ? (await node.host.mint("c/shared-sdk", "read", 60_000)).secret : node.heldToken(W.baseline));
      return runAgent(node, task, new ScriptedModel(edits), { sharedToken });
    },
    async restart(org) {
      const node = new OrgNode({ config: config(org), store: stores[org], host: svc.binding(org, creds[org]!), transport, now: clock.now, log: e => logs.push(e) });
      await node.init();
      transport.nodes.set(org, node);
      W.nodes[org] = node;
      return node;
    },
  };
  return W;
}

export async function settle(w: World): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.all(ORGS.map(o => w.nodes[o].flush()));
    if (ORGS.every(o => w.nodes[o].outbox().filter(e => !e.failed).length === 0)) return;
    w.clock.advance(60_000);
  }
}
