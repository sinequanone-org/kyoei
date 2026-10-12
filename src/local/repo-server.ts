// HTTP front for the local repository service, and a RepoHost client for it.
// One repository-service process stands in for Artifacts in the offline demo.
// Each organization's node process gets only its own namespace credential,
// like a Worker binding. Listens on 127.0.0.1 only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { b64u, unb64u } from "../core/canonical.ts";
import type { Entry } from "../core/content.ts";
import type { CommitInput, MergeResult, RepoHost, Token } from "../git/host.ts";
import { GitService } from "./git-service.ts";

const OPS = new Set(["create", "mint", "revoke", "head", "snapshot", "commit", "note", "readNote", "merge"]);

async function read(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startRepoServer(root: string, port: number, namespaces: string[]): Promise<{ url: string; credentials: Record<string, string>; svc: GitService; close(): Promise<void> }> {
  mkdirSync(root, { recursive: true });
  const svc = new GitService(root);
  const credentials: Record<string, string> = {};
  for (const ns of namespaces) credentials[ns] = svc.addNamespace(ns);
  const bindings = new Map(Object.entries(credentials).map(([ns, cred]) => [cred, svc.binding(ns, cred)]));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/bundle") {
        // A plain-Git export of main and the kyoei notes, with a read token.
        const repo = url.searchParams.get("repo") ?? "";
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const out = join(root, `export-${Date.now()}.bundle`);
        await svc.bundle(repo, token, out);
        const { readFileSync, rmSync } = await import("node:fs");
        const data = readFileSync(out);
        rmSync(out);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(data);
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/rpc") return send(res, 404, { error: "not-found" });
      const host = bindings.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!host) return send(res, 401, { error: "not-authorized" });
      const { op, args } = await read(req);
      if (!OPS.has(op) || !Array.isArray(args)) return send(res, 400, { error: "invalid-request" });
      let result = await (host as any)[op](...args);
      if (op === "snapshot") result = (result as Entry[]).map(e => ({ path: e.path, mode: e.mode, bytes: b64u(e.bytes) }));
      send(res, 200, { result: result ?? null });
    } catch (e) {
      const message = String((e as Error).message);
      send(res, /not-authorized/.test(message) ? 403 : 400, { error: message.slice(0, 300) });
    }
  });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return { url: `http://127.0.0.1:${actual}`, credentials, svc, close: () => new Promise(r => server.close(() => r())) };
}

export class RemoteRepoHost implements RepoHost {
  private readonly url: string;
  private readonly credential: string;

  constructor(url: string, credential: string) {
    this.url = url;
    this.credential = credential;
  }

  private async call<T>(op: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(`${this.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.credential}` },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { result?: T; error?: string };
    if (!res.ok) throw new Error(body.error ?? `repo service ${res.status}`);
    return body.result as T;
  }

  create(name: string, from?: { repo: string; commit: string; token?: string }) { return this.call<{ repo: string; head: string }>("create", name, from); }
  mint(repo: string, scope: "read" | "write", ttlMs: number) { return this.call<Token>("mint", repo, scope, ttlMs); }
  revoke(tokenId: string) { return this.call<boolean>("revoke", tokenId); }
  head(repo: string, token: string) { return this.call<string>("head", repo, token); }
  async snapshot(repo: string, commit: string, token: string): Promise<Entry[]> {
    const rows = await this.call<{ path: string; mode: Entry["mode"]; bytes: string }[]>("snapshot", repo, commit, token);
    return rows.map(r => ({ path: r.path, mode: r.mode, bytes: new Uint8Array(unb64u(r.bytes)) }));
  }
  commit(repo: string, token: string, input: CommitInput) { return this.call<string>("commit", repo, token, input); }
  async note(repo: string, token: string, commit: string, text: string) { await this.call("note", repo, token, commit, text); }
  readNote(repo: string, token: string, commit: string) { return this.call<string | null>("readNote", repo, token, commit); }
  merge(target: string, writeToken: string, source: string, sourceToken: string, commit: string, expectedHead: string, note: string) {
    return this.call<MergeResult>("merge", target, writeToken, source, sourceToken, commit, expectedHead, note);
  }
}
