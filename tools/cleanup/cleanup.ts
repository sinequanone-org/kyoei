// One-shot cleanup Worker for `node scripts/deploy.ts reset`. It deletes
// every repository in the three organization namespaces through the
// Artifacts binding, because `wrangler artifacts repos delete` cannot confirm
// without a terminal. The reset script deploys it, calls it once and deletes it.

import { sha256 } from "../../src/core/canonical.ts";

interface Namespace {
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: { name: string }[]; cursor?: string | null }>;
  delete(name: string): Promise<boolean>;
}
interface Env { NS_A: Namespace; NS_B: Namespace; NS_C: Namespace; CLEANUP_TOKEN_SHA256: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (request.method !== "POST" || !env.CLEANUP_TOKEN_SHA256 || !bearer || (await sha256(bearer)) !== env.CLEANUP_TOKEN_SHA256) return new Response("forbidden", { status: 403 });
    const deleted: Record<string, string[]> = {};
    for (const [name, ns] of [["kyoei-a", env.NS_A], ["kyoei-b", env.NS_B], ["kyoei-c", env.NS_C]] as const) {
      deleted[name] = [];
      for (let round = 0; round < 20; round++) {
        const { repos } = await ns.list({ limit: 100 });
        if (!repos.length) break;
        for (const r of repos) if (await ns.delete(r.name)) deleted[name]!.push(r.name);
      }
    }
    return Response.json(deleted);
  },
} satisfies ExportedHandler<Env>;
