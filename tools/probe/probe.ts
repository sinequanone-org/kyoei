// Feasibility probe for a deployed account. It runs the real ArtifactsHost
// and WorkersAiModel against live bindings in a separate namespace, then
// deletes the repositories it created. It never returns a token secret.
//
//   npx wrangler deploy -c tools/probe/wrangler.jsonc
//   npx wrangler secret put PROBE_TOKEN_SHA256 -c tools/probe/wrangler.jsonc
//   curl -H "authorization: Bearer <probe token>" https://<worker>/run

import { ArtifactsHost, type ArtifactsBinding } from "../../src/worker/artifacts-host.ts";
import { WorkersAiModel, type AiBinding } from "../../src/worker/workers-ai.ts";
import { generateKey, sign, verify } from "../../src/crypto/signer.ts";
import { sha256, utf8 } from "../../src/core/canonical.ts";
import type { Store } from "../../src/node/store.ts";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

interface Env { ARTIFACTS: ArtifactsBinding & { delete(name: string): Promise<boolean> }; AI: AiBinding; PROBE_TOKEN_SHA256: string }

class MapStore implements Store {
  private readonly m = new Map<string, unknown>();
  get<T>(k: string): T | undefined { return this.m.get(k) as T | undefined; }
  put(k: string, v: unknown): void { this.m.set(k, v); }
  delete(k: string): void { this.m.delete(k); }
  list<T>(p: string): [string, T][] { return [...this.m].filter(([k]) => k.startsWith(p)) as [string, T][]; }
  transaction<T>(fn: () => T): T { return fn(); }
}

type Row = { check: string; ok: boolean; ms: number; detail?: unknown };

async function probe(env: Env): Promise<Row[]> {
  const rows: Row[] = [];
  const step = async (check: string, fn: () => Promise<unknown>, expectFail = false) => {
    const t = Date.now();
    try {
      const detail = await fn();
      rows.push({ check, ok: !expectFail, ms: Date.now() - t, detail });
    } catch (e) {
      rows.push({ check, ok: expectFail, ms: Date.now() - t, detail: String((e as Error).message).slice(0, 300).replace(/art_v1_[0-9a-f]+/g, "art_v1_<redacted>") });
    }
  };
  const ns = "kyoei-probe";
  const suffix = Date.now().toString(36);
  const src = `src-${suffix}`, fork = `fork-${suffix}`, other = `other-${suffix}`;
  const host = new ArtifactsHost(ns, env.ARTIFACTS, new MapStore());
  let c1 = "", c2 = "", c3 = "", write = { id: "", secret: "" }, read = { id: "", secret: "" };
  try {
    await step("create repository", async () => (await host.create(src)).repo);
    await step("mint write token", async () => { write = await host.mint(`${ns}/${src}`, "write", 600_000); return write.secret.slice(0, 7); });
    await step("commit and push from Worker (root commit)", async () => (c1 = await host.commit(`${ns}/${src}`, write.secret, { base: "", write: [{ path: "src/a.ts", text: "export const a = 1;\n" }, { path: "README.md", text: "probe\n" }], message: "c1", author: "probe" })));
    await step("commit on parent", async () => (c2 = await host.commit(`${ns}/${src}`, write.secret, { base: c1, write: [{ path: "src/a.ts", text: "export const a = 2;\n" }], message: "c2", author: "probe" })));
    await step("non-fast-forward push is refused", async () => (c3 = await host.commit(`${ns}/${src}`, write.secret, { base: c1, write: [{ path: "src/a.ts", text: "export const a = 3;\n" }], message: "c3", author: "probe" })), true);
    await step("push git note refs/notes/kyoei", async () => host.note(`${ns}/${src}`, write.secret, c2, "{\"probe\":true}\n"));
    await step("mint read token", async () => { read = await host.mint(`${ns}/${src}`, "read", 600_000); return read.secret.slice(0, 7); });
    await step("read head with read token", async () => { const h = await host.head(`${ns}/${src}`, read.secret); if (h !== c2) throw new Error(`head ${h} != ${c2}`); return h; });
    await step("read note with read token", async () => { const n = await host.readNote(`${ns}/${src}`, read.secret, c2); if (!n?.includes("probe")) throw new Error(`note ${n}`); return n; });
    await step("snapshot with read token", async () => (await host.snapshot(`${ns}/${src}`, c2, read.secret)).map(e => `${e.mode} ${e.path} ${e.bytes.byteLength}`));
    await step("push with read token is refused", async () => host.commit(`${ns}/${src}`, read.secret, { base: c2, write: [{ path: "x", text: "x" }], message: "x", author: "probe" }), true);
    await step("fork in namespace", async () => (await host.create(fork, { repo: `${ns}/${src}`, commit: c2 })).repo);
    await step("create second repository and copy by read token", async () => (await host.create(other, { repo: `${ns}/${src}`, commit: c2, token: read.secret })).head);
    await step("merge into stale expected head is refused", async () => { const r = await host.merge(`${ns}/${src}`, write.secret, `${ns}/${fork}`, read.secret, c2, c1, "{}"); if (r.status !== "stale") throw new Error(r.status); return r.status; });
    await step("revoke read token", async () => host.revoke(read.id));
    await step("read with revoked token is refused", async () => host.head(`${ns}/${src}`, read.secret), true);
    await step("ML-DSA-65 sign and verify", async () => {
      const { pair } = await generateKey("ML-DSA-65");
      const m = utf8("probe");
      const s = await sign(pair, m);
      return { verified: await verify("ML-DSA-65", pair.publicKey, s, m), tampered: await verify("ML-DSA-65", pair.publicKey, s, utf8("probf")) };
    });
    for (const model of ["@cf/moonshotai/kimi-k2.7-code", "@cf/openai/gpt-oss-120b"]) {
      await step(`Workers AI raw ${model}`, async () => {
        const out = await env.AI.run(model, { messages: [{ role: "user", content: "Return JSON {\"rationale\": \"ok\", \"files\": []}." }], response_format: { type: "json_schema", json_schema: { type: "object", properties: { rationale: { type: "string" }, files: { type: "array" } }, required: ["rationale", "files"] } }, max_tokens: 256 }) as Record<string, unknown>;
        return { keys: Object.keys(out ?? {}), responseType: typeof out?.response, sample: JSON.stringify(out).slice(0, 400) };
      });
    }
    await step("server advertises refs/notes/kyoei", async () => (await git.listServerRefs({ http, url: host.remote(`${ns}/${src}`), prefix: "refs/", onAuth: () => ({ username: "x", password: write.secret.split("?expires=")[0] }) })).map(r => r.ref));
    await step("Workers AI JSON output", async () => {
      const g = await new WorkersAiModel(env.AI).generate(
        { key: "p", agent: "p1", line: "p", version: 1, task: "Change the exported constant a to 4. Keep the file otherwise the same.", files: ["src/a.ts"], inputs: [], provides: [] },
        [{ path: "src/a.ts", text: "export const a = 2;\n" }], []);
      return { files: g.files.map(f => ({ path: f.path, text: f.text.slice(0, 80) })), rationale: g.rationale.slice(0, 160) };
    });
  } finally {
    await step("revoke write token", async () => host.revoke(write.id));
    for (const name of [src, fork, other]) await step(`delete ${name}`, async () => env.ARTIFACTS.delete(name));
  }
  return rows;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!env.PROBE_TOKEN_SHA256 || !bearer || (await sha256(bearer)) !== env.PROBE_TOKEN_SHA256) return new Response("forbidden", { status: 403 });
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    return Response.json(await probe(env));
  },
} satisfies ExportedHandler<Env>;
