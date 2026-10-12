// Worker entry: one deployment per organization. Every request goes to the
// organization's single OrgNode Durable Object, which owns the ledger, the
// signing key and the outbox. Agent runs execute inside that object; an alarm
// retries queued events.
//
// Each node keeps its event log in its own storage (log:<seq>); the admin
// route GET /api/log reads it, so a remote run can rebuild its summary.

import { DurableObject } from "cloudflare:workers";
import { handle } from "../node/api.ts";
import { OrgNode, type NodeConfig } from "../node/node.ts";
import { HttpTransport } from "../node/transport.ts";
import type { Store } from "../node/store.ts";
import { ScriptedModel, type ScriptedEdit } from "../agents/scripted.ts";
import type { Model } from "../agents/run.ts";
import { ArtifactsHost, type ArtifactsBinding } from "./artifacts-host.ts";
import { WorkersAiModel, type AiBinding } from "./workers-ai.ts";
import edits from "../../demo/edits.bundle.json" with { type: "json" };

export interface Env {
  ORG_NODE: DurableObjectNamespace<OrgNodeObject>;
  ARTIFACTS: ArtifactsBinding;
  AI: AiBinding;
  ORG: string;
  NAMESPACE: string;
  DEPLOYMENT: string;
  COLLABORATION: string;
  INTEGRATOR: string;
  INTEGRATION_REPO: string;
  PUBLIC_URL: string;
  SIGNATURE: "ML-DSA-65" | "Ed25519";
  ACTORS: string;              // JSON list of {name, kind, delegate}
  MODEL_MODE: "workers-ai" | "scripted";
  ADMIN_TOKEN_SHA256: string;  // secret
}

// A Store over the synchronous KV API of SQLite-backed Durable Objects.
class DurableStore implements Store {
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { this.storage = storage; }
  get<T>(key: string): T | undefined { return this.storage.kv.get(key) as T | undefined; }
  put(key: string, value: unknown): void { this.storage.kv.put(key, JSON.parse(JSON.stringify(value))); }
  delete(key: string): void { this.storage.kv.delete(key); }
  list<T>(prefix: string): [string, T][] { return [...this.storage.kv.list({ prefix })] as [string, T][]; }
  transaction<T>(fn: () => T): T { return this.storage.transactionSync(fn); }
}

export class OrgNodeObject extends DurableObject<Env> {
  private node: OrgNode;
  private model: Model;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store = new DurableStore(ctx.storage);
    const config: NodeConfig = {
      org: env.ORG, deployment: env.DEPLOYMENT, collaboration: env.COLLABORATION, url: env.PUBLIC_URL,
      alg: env.SIGNATURE, integrator: env.INTEGRATOR, integrationRepo: env.INTEGRATION_REPO, actors: JSON.parse(env.ACTORS),
    };
    const host = new ArtifactsHost(env.NAMESPACE, env.ARTIFACTS, store);
    this.node = new OrgNode({ config, store, host, transport: new HttpTransport((input, init) => fetch(input, init)), log: e => this.append(e) });
    this.model = env.MODEL_MODE === "workers-ai" ? new WorkersAiModel(env.AI) : new ScriptedModel(edits as Record<string, ScriptedEdit>);
    ctx.blockConcurrencyWhile(() => this.node.init().then(() => undefined));
  }

  private append(entry: unknown): void {
    const seq = (this.ctx.storage.kv.get("log-seq") as number | undefined ?? 0) + 1;
    this.ctx.storage.kv.put("log-seq", seq);
    this.ctx.storage.kv.put(`log:${String(seq).padStart(10, "0")}`, JSON.parse(JSON.stringify(entry)));
  }

  private readLog(after: number, limit: number): { seq: number; entry: unknown }[] {
    const rows = this.ctx.storage.kv.list({ prefix: "log:", start: `log:${String(after + 1).padStart(10, "0")}`, limit });
    return [...rows].map(([k, entry]) => ({ seq: Number(k.slice(4)), entry }));
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    const response = await handle(request, {
      node: this.node,
      adminTokenDigest: this.env.ADMIN_TOKEN_SHA256,
      model: this.model,
      sharedToken: async () => {
        if (this.env.ORG === this.env.INTEGRATOR) return (await this.node.host.mint(this.env.INTEGRATION_REPO, "read", 300_000)).secret;
        const seed = this.node.store.list<{ c: { id: string; body: { line: string } } }>("c:").find(([, r]) => r.c.body.line === "seed");
        if (!seed) throw new Error("integration repository not released");
        return this.node.heldToken(seed[1].c.id);
      },
      background: p => this.ctx.waitUntil(p),
      log: (after, limit) => this.readLog(after, limit),
    });
    if (this.node.nextDelivery() !== null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return response;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    await this.node.flush();
    const next = this.node.nextDelivery();
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 500, next));

  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ org: env.ORG, ok: true });
    return env.ORG_NODE.get(env.ORG_NODE.idFromName("node")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
