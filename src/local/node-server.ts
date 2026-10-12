// One organization's node as a local process. Usage (set by scripts/local.ts):
//   node src/local/node-server.ts <config.json>
// Secrets come from the environment: KYOEI_ADMIN_TOKEN, KYOEI_NS_CREDENTIAL.

import { createServer } from "node:http";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../core/canonical.ts";
import { handle } from "../node/api.ts";
import { OrgNode, type NodeConfig } from "../node/node.ts";
import { HttpTransport } from "../node/transport.ts";
import { ScriptedModel, type ScriptedEdit } from "../agents/scripted.ts";
import { FileStore } from "./file-store.ts";
import { RemoteRepoHost } from "./repo-server.ts";

interface LocalConfig {
  node: NodeConfig;
  port: number;
  repoUrl: string;
  statePath: string;
  logPath: string;
  editsDir: string;
  speed: number;
  baseline?: string;
}

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as LocalConfig;
const admin = process.env.KYOEI_ADMIN_TOKEN;
const credential = process.env.KYOEI_NS_CREDENTIAL;
if (!admin || !credential) throw new Error("KYOEI_ADMIN_TOKEN and KYOEI_NS_CREDENTIAL are required");
delete process.env.KYOEI_ADMIN_TOKEN;
delete process.env.KYOEI_NS_CREDENTIAL;

const edits: Record<string, ScriptedEdit> = {};
for (const f of readdirSync(cfg.editsDir).filter(f => f.endsWith(".json"))) edits[f.slice(0, -5)] = JSON.parse(readFileSync(join(cfg.editsDir, f), "utf8"));

const node = new OrgNode({
  config: cfg.node,
  store: new FileStore(cfg.statePath),
  host: new RemoteRepoHost(cfg.repoUrl, credential),
  transport: new HttpTransport(),
  log: e => appendFileSync(cfg.logPath, JSON.stringify(e) + "\n"),
});
await node.init();

const adminDigest = await sha256(admin);
const pending = new Set<Promise<unknown>>();
const sharedToken = async () => {
  if (cfg.node.org === cfg.node.integrator) return (await node.host.mint(cfg.node.integrationRepo, "read", 300_000)).secret;
  const seed = node.store.list<{ c: { body: { line: string; org: string }; id: string } }>("c:").find(([, r]) => r.c.body.line === "seed" && r.c.body.org === cfg.node.integrator);
  if (!seed) throw new Error("integration repository not released to this organization");
  return node.heldToken(seed[1].c.id);
};

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const request = new Request(new URL(req.url ?? "/", `http://127.0.0.1:${cfg.port}`), {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string") as [string, string][],
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await handle(request, {
    node, adminTokenDigest: adminDigest, model: new ScriptedModel(edits, cfg.speed), sharedToken,
    background: p => { pending.add(p); void p.finally(() => pending.delete(p)); },
  });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

// Retries for queued events run on a timer, like a Durable Object alarm.
setInterval(() => void node.flush(), 500).unref();
server.listen(cfg.port, "127.0.0.1", () => process.stdout.write(`ready ${cfg.node.org} ${cfg.port}\n`));
