// Deploys the three organization Workers to one Cloudflare account, or
// removes them. Needs `npx wrangler login` first.
//
//   node scripts/deploy.ts up    <env.json> [--model scripted|workers-ai]
//   node scripts/deploy.ts reset <env.json>
//
// `up` writes <env.json> with new admin tokens (mode 0600) when it does not
// exist, and stores only their SHA-256 digests as Worker secrets. Keep the
// file outside the repository. `reset` deletes the Workers (and with them
// each node's Durable Object state and key) and every repository in the
// three Artifacts namespaces, so the next `up` starts clean.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { EnvFile } from "../src/cli/client.ts";

const [command, envArg] = process.argv.slice(2);
const argv = process.argv.slice(2);
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1]! : "scripted";
const ROOT = resolve(import.meta.dirname, "..");
const ORGS = { a: "Acme", b: "Birch", c: "Cove" } as const;
if (!envArg || !["up", "reset"].includes(command ?? "")) {
  console.error("usage: node scripts/deploy.ts up|reset <env.json> [--model scripted|workers-ai]");
  process.exit(2);
}
if (!["scripted", "workers-ai"].includes(model)) throw new Error("--model must be scripted or workers-ai");
const envPath = resolve(envArg);
if (envPath.startsWith(ROOT + "/")) throw new Error("keep the env file outside the repository");

function wrangler(args: string[], input?: string): string {
  return execFileSync("npx", ["wrangler", ...args], { cwd: ROOT, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).toString();
}

function subdomain(): string {
  const known = existsSync(envPath) ? (JSON.parse(readFileSync(envPath, "utf8")) as EnvFile).orgs.a?.url : undefined;
  const m = known ? /^https:\/\/kyoei-org-a\.([a-z0-9-]+)\.workers\.dev\/$/.exec(known) : null;
  if (m) return m[1]!;
  const flag = argv.includes("--subdomain") ? argv[argv.indexOf("--subdomain") + 1] : undefined;
  if (!flag || !/^[a-z0-9-]+$/.test(flag)) throw new Error("pass --subdomain <your workers.dev subdomain> on the first run");
  return flag;
}

if (command === "up") {
  const sub = subdomain();
  if (!existsSync(envPath)) {
    const env: EnvFile = { run: "deployed", repoUrl: "", orgs: {} };
    for (const [org, name] of Object.entries(ORGS)) {
      env.orgs[org] = { url: `https://kyoei-org-${org}.${sub}.workers.dev/`, admin: "adm_" + randomBytes(20).toString("hex"), name };
    }
    writeFileSync(envPath, JSON.stringify(env, null, 1), { mode: 0o600 });
  }
  const env = JSON.parse(readFileSync(envPath, "utf8")) as EnvFile;
  for (const org of Object.keys(ORGS)) {
    const o = env.orgs[org]!;
    wrangler(["deploy", "--env", `org-${org}`, "--var", `PUBLIC_URL:${o.url}`, "--var", `MODEL_MODE:${model}`]);
    wrangler(["secret", "put", "ADMIN_TOKEN_SHA256", "--env", `org-${org}`], createHash("sha256").update(o.admin).digest("hex"));
    console.log(`deployed ${o.name}: ${o.url} (model ${model})`);
  }
} else {
  for (const org of Object.keys(ORGS)) {
    try {
      wrangler(["delete", "--env", `org-${org}`, "--force"]);
      console.log(`deleted Worker kyoei-org-${org}`);
    } catch {
      console.log(`no Worker kyoei-org-${org}`);
    }
  }
  // Repository deletes go through a one-shot cleanup Worker (tools/cleanup).
  const cleanup = ["-c", "tools/cleanup/wrangler.jsonc"];
  const token = randomBytes(24).toString("hex");
  const out = wrangler(["deploy", ...cleanup]);
  const url = /https:\/\/kyoei-cleanup\.[a-z0-9-]+\.workers\.dev/.exec(out)?.[0];
  if (!url) throw new Error("cleanup Worker URL not found");
  try {
    wrangler(["secret", "put", "CLEANUP_TOKEN_SHA256", ...cleanup], createHash("sha256").update(token).digest("hex"));
    let body = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      if (res.ok) { body = await res.text(); break; }
    }
    if (!body) throw new Error("cleanup Worker did not answer");
    for (const [ns, names] of Object.entries(JSON.parse(body) as Record<string, string[]>)) console.log(`deleted ${names.length} repositories in ${ns}`);
  } finally {
    wrangler(["delete", ...cleanup, "--force"]);
  }
}
