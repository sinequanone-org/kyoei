// HTTP client for the node API. The environment file holds node URLs and
// admin tokens; it lives in runs/<id>/state/, which git ignores.

import { readFileSync } from "node:fs";

export interface EnvFile {
  run: string;
  repoUrl: string;
  orgs: Record<string, { url: string; admin: string; name: string }>;
}

export function loadEnv(path = process.env.KYOEI_ENV ?? "runs/current/state/env.json"): EnvFile {
  return JSON.parse(readFileSync(path, "utf8")) as EnvFile;
}

export interface ContributionView {
  id: string; org: string; line: string; version: number; agent: string; own: boolean; commit: string; root: string;
  files: string[]; provides: string[]; inputs: { id: string; relation: string; label: string }[]; task: string; rationale: string;
  verified: boolean; state: string; cause: string | null; shipped: boolean; approved: boolean;
  released: { to: string; purposes: string[]; expires: number; revoked: boolean; token: string }[];
  held: { from: string; purposes: string[] } | null; challenges: number;
}

export interface StateView {
  org: string; integrator: string; fingerprint: string;
  contributions: ContributionView[];
  notices: { id: string; item: string; blocking: boolean; state: string; source: { event: string; kind: string; org: string; target: string; reason: string }; act: string[]; repairs: string[]; dissent: unknown[]; evidence: { commit: string; record: string; content: string } }[];
  intents: { org: string; agent: string; files: string[]; state: string }[];
  overlaps: { id: string; files: string[]; a: { org: string; agent: string }; b: { org: string; agent: string } }[];
  main: { head: string; id: string | null; files: string[] }[];
  ops: { id: string; contribution: string; state: string; code?: string }[];
  outbox: { to: string; kind: string; attempts: number; failed: string | null }[];
}

export class Client {
  readonly env: EnvFile;
  constructor(env: EnvFile) { this.env = env; }

  async call<T>(org: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const o = this.env.orgs[org];
    if (!o) throw new Error(`unknown organization ${org}`);
    const res = await fetch(new URL(path, o.url), {
      method,
      headers: { authorization: `Bearer ${o.admin}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as T & { error?: string; detail?: string };
    if (!res.ok) {
      const err = new Error(`${data.error}${data.detail ? `: ${data.detail}` : ""}`) as Error & { code?: string };
      err.code = data.error;
      throw err;
    }
    return data;
  }

  state(org: string): Promise<StateView> { return this.call(org, "GET", "/api/state"); }

  // Resolves "line", "line@2" or "org/line" to a record ID, from org's view.
  async resolve(org: string, ref: string): Promise<ContributionView> {
    const st = await this.state(org);
    const m = /^(?:([a-z])\/)?([A-Za-z0-9._-]+?)(?:@(\d+))?$/.exec(ref);
    if (!m) throw new Error(`bad reference ${ref}`);
    const [, owner, line, version] = m;
    const found = st.contributions
      .filter(c => c.line === line && (!owner || c.org === owner) && (!version || c.version === Number(version)))
      .sort((x, y) => y.version - x.version);
    if (!found.length) throw new Error(`${org} holds no contribution ${ref}`);
    return found[0]!;
  }
}
