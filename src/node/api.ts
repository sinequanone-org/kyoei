// HTTP API of one node, on the standard Request and Response types, so the
// same code serves a Worker and a local Node process.
//
// /kyoei/inbox and /kyoei/rely accept signed envelopes from pinned peers.
// /api/* needs the organization's admin token. Responses never contain token
// secrets.

import { sha256 } from "../core/canonical.ts";
import { Refusal } from "../core/types.ts";
import { runAgent, type AgentTask, type Model } from "../agents/run.ts";
import type { OrgNode } from "./node.ts";

export interface ApiOptions {
  node: OrgNode;
  adminTokenDigest: string;           // sha256 of the admin token
  model: Model;
  sharedToken: () => Promise<string>;
  background: (p: Promise<unknown>) => void;
  // Log entries after sequence number `after`, when the node keeps its log (Worker).
  log?: (after: number, limit: number) => { seq: number; entry: unknown }[];
}

const STATUS: Record<string, number> = {
  "invalid-request": 400, "not-authorized": 403, "human-required": 403, "new-grant-required": 403,
  "lease-expired": 403, "withdrawn": 409, "replacement-required": 409, "stale-base": 409, "conflict": 409,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function error(e: unknown): Response {
  if (e instanceof Refusal) return json({ error: e.code, detail: e.detail }, STATUS[e.code] ?? 400);
  return json({ error: "unavailable" }, 503);
}

async function body(req: Request): Promise<Record<string, any>> {
  const text = await req.text();
  if (text.length > 512 * 1024) throw new Refusal("invalid-request", "body too large");
  try {
    const v = JSON.parse(text || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new Refusal("invalid-request", "json");
  }
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every(x => typeof x === "string")) throw new Refusal("invalid-request", "string list");
  return v;
}

async function authorized(req: Request, digest: string): Promise<boolean> {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const got = await sha256(h.slice(7));
  let diff = got.length ^ digest.length;
  for (let i = 0; i < Math.min(got.length, digest.length); i++) diff |= got.charCodeAt(i) ^ digest.charCodeAt(i);
  return diff === 0;
}

export async function handle(req: Request, o: ApiOptions): Promise<Response> {
  const url = new URL(req.url);
  const node = o.node;
  try {
    if (req.method === "POST" && url.pathname === "/kyoei/inbox") return json(await node.receive(await body(req)));
    if (req.method === "POST" && url.pathname === "/kyoei/rely") return json(await node.answerRely(await body(req)));
    if (req.method === "GET" && url.pathname === "/kyoei/identity") return json(node.identity());
    if (!url.pathname.startsWith("/api/")) return json({ error: "not-found" }, 404);
    if (!(await authorized(req, o.adminTokenDigest))) return json({ error: "not-authorized" }, 401);
    const b = req.method === "POST" ? await body(req) : {};
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/state":
        return json(node.state());
      case "GET /api/log": {
        if (!o.log) return json({ error: "not-found" }, 404);
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        return json(o.log(after, 500));
      }
      case "GET /api/alternatives":
        return json(node.alternatives(url.searchParams.get("for") ?? ""));
      case "GET /api/gate":
        return json(node.gate(url.searchParams.get("for") ?? ""));
      case "POST /api/seed":
        return json(await node.seed(String(b.actor), (Array.isArray(b.files) ? b.files : []).map((f: any) => ({ path: String(f.path), text: String(f.text) }))));
      case "POST /api/pin":
        await node.pin(b.peer, String(b.fingerprint));
        return json({ ok: true });
      case "POST /api/agents": {
        const tasks = (Array.isArray(b.tasks) ? b.tasks : []) as AgentTask[];
        if (!tasks.length || tasks.length > 16) throw new Refusal("invalid-request", "1 to 16 tasks");
        for (const t of tasks) {
          if (node.actor(t.agent).kind !== "agent") throw new Refusal("invalid-request", "agent");
          strings(t.files);
        }
        node.store.transaction(() => {
          for (const t of tasks) node.delegateTask(String(b.actor ?? node.actor(t.agent).delegate), t, Number(b.ttlMs ?? 3600_000));
        });
        for (const t of tasks) o.background(runAgent(node, t, o.model, { sharedToken: o.sharedToken }).catch(() => undefined));
        return json({ started: tasks.map(t => t.key) }, 202);
      }
      case "POST /api/release":
        return json((await node.release(String(b.actor), String(b.id), strings(b.to), strings(b.purposes), Number(b.ttlMs) || 3600_000, Array.isArray(b.onward) ? b.onward : []))
          .map(g => ({ to: g.to, purposes: g.purposes, expires: g.expires, token: g.tokenId })));
      case "POST /api/approve":
        return json(await node.approve(String(b.actor), String(b.id)));
      case "POST /api/ship":
        return json(await node.ship(String(b.actor), String(b.id)));
      case "POST /api/reconcile":
        return json(await node.reconcile(String(b.op)));
      case "POST /api/withdraw":
        return json(await node.withdraw(String(b.actor), String(b.id), String(b.reason ?? "")));
      case "POST /api/challenge":
        return json({ cause: await node.challenge(String(b.actor), String(b.id), String(b.reason ?? "")) });
      case "POST /api/dissent":
        await node.dissent(String(b.actor), String(b.cause), String(b.text ?? ""));
        return json({ ok: true });
      case "POST /api/repair": {
        const plan = node.planRepair(String(b.actor), String(b.id), b.onto ? String(b.onto) : null, b.from ? String(b.from) : null);
        const agent = String(b.agent);
        if (node.actor(agent).kind !== "agent") throw new Refusal("invalid-request", "agent");
        const task: AgentTask = {
          key: String(b.key ?? `${agent}-${plan.line}-v${plan.version}`), agent, line: plan.line, version: plan.version,
          task: String(b.task ?? `Repair ${plan.line}: ${plan.task}`), files: strings(b.files ?? plan.files),
          inputs: plan.inputs, provides: plan.provides, edit: String(b.edit ?? ""),
        };
        node.delegateTask(String(b.actor), task, Number(b.ttlMs ?? 3600_000));
        o.background(runAgent(node, task, o.model, { sharedToken: o.sharedToken }).catch(() => undefined));
        return json({ started: task.key, plan }, 202);
      }
      case "POST /api/flush":
        await node.flush();
        return json({ outbox: node.outbox().length });
      default:
        return json({ error: "not-found" }, 404);
    }
  } catch (e) {
    return error(e);
  }
}
