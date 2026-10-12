// One command runs the whole scenario offline:
//   npm run demo -- [--run <id>] [--speed 1] [--hold]
// or against three deployed nodes (see docs/deploy.md):
//   npm run demo -- --remote <env.json> [--run <id>]
//
// It starts one repository service (it stands in for Artifacts) and one OS
// process per organization. Each process has its own key, its own state file
// and its own namespace credential. Nodes talk only through signed HTTP
// envelopes. The script then acts as the three organizations' people, through
// each node's admin API. Every number in runs/<id>/summary.json comes from
// the logs that the nodes write (scripts/summary.ts).

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomId } from "../src/core/canonical.ts";
import { startRepoServer } from "../src/local/repo-server.ts";
import { Client, loadEnv, type EnvFile, type StateView } from "../src/cli/client.ts";
import type { NodeConfig } from "../src/node/node.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
const ROOT = resolve(import.meta.dirname, "..");
const run = flag("run", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const speed = Number(flag("speed", "1"));
const basePort = Number(flag("port", "8700"));
const hold = argv.includes("--hold");
const remote = argv.includes("--remote") ? resolve(flag("remote", "")) : null;
const dir = join(ROOT, "runs", run);
const state = join(dir, "state");
mkdirSync(state, { recursive: true });
const t0 = Date.now();
const NAMES: Record<string, string> = { a: "Acme", b: "Birch", c: "Cove" };

function say(text: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  process.stdout.write(`\x1b[2m${s}s\x1b[0m ${text}\n`);
}
function act(type: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(join(dir, "demo.jsonl"), JSON.stringify({ t: Date.now(), type, ...extra }) + "\n");
}

const AGENTS: Record<string, string[]> = { a: ["a1", "a2", "a3", "a2r", "a3r"], b: ["b1", "b2", "b3", "b4", "b2r"], c: ["c1", "c2", "c3", "c4", "c5", "c2r"] };

const children: ChildProcess[] = [];
const repoRoot = remote ? "" : mkdtempSync(join(tmpdir(), "kyoei-repos-"));
const repo = remote ? null : await startRepoServer(repoRoot, basePort, ["a", "b", "c"]);
const env: EnvFile = remote ? { ...loadEnv(remote), run } : { run, repoUrl: repo!.url, orgs: {} };
const envPath = remote ?? join(state, "env.json");
try {
  for (const [i, org] of (remote ? [] : ["a", "b", "c"]).entries()) {
    const port = basePort + 1 + i;
    const node: NodeConfig = {
      org, deployment: "local", collaboration: "shared-sdk", url: `http://127.0.0.1:${port}/`, alg: "Ed25519",
      integrator: "c", integrationRepo: "c/shared-sdk",
      actors: [{ name: `${org}.lead`, kind: "person" }, ...AGENTS[org]!.map(n => ({ name: n, kind: "agent" as const, delegate: `${org}.lead` }))],
    };
    const cfgPath = join(state, `${org}.config.json`);
    writeFileSync(cfgPath, JSON.stringify({ node, port, repoUrl: repo!.url, statePath: join(state, `${org}.state.json`), logPath: join(dir, `${org}.jsonl`), editsDir: join(ROOT, "demo", "edits"), speed }, null, 1));
    const admin = "adm_" + randomId(20);
    env.orgs[org] = { url: `http://127.0.0.1:${port}/`, admin, name: NAMES[org]! };
    const child = spawn(process.execPath, [join(ROOT, "src/local/node-server.ts"), cfgPath], {
      env: { ...process.env, KYOEI_ADMIN_TOKEN: admin, KYOEI_NS_CREDENTIAL: repo!.credentials[org]! },
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    await new Promise<void>((ok, fail) => {
      child.stdout!.once("data", () => ok());
      child.once("exit", code => fail(new Error(`node ${org} exited ${code}`)));
    });
  }
  if (!remote) writeFileSync(envPath, JSON.stringify(env, null, 1), { mode: 0o600 });
  const current = join(ROOT, "runs", "current");
  rmSync(current, { force: true });
  symlinkSync(run, current);
  const k = new Client(env);
  say(`three nodes up: ${Object.values(env.orgs).map(v => `${v.name} ${v.url}`).join(", ")}`);

  // Join: exchange key fingerprints (out of band here: this script) and pin.
  const ids: Record<string, any> = {};
  for (const org of ["a", "b", "c"]) ids[org] = await (await fetch(new URL("/kyoei/identity", env.orgs[org]!.url))).json();
  for (const x of ["a", "b", "c"]) for (const y of ["a", "b", "c"]) if (x !== y) await k.call(x, "POST", "/api/pin", { peer: ids[y], fingerprint: ids[y].fingerprint });
  say("join: each node pinned the other two keys by fingerprint");
  act("join");

  const seed = JSON.parse(readFileSync(join(ROOT, "demo", "seed.json"), "utf8"));
  const base = await k.call<{ id: string }>("c", "POST", "/api/seed", { actor: "c.lead", files: seed.files });
  await k.call("c", "POST", "/api/release", { actor: "c.lead", id: base.id, to: ["a", "b"], purposes: ["contribute"], ttlMs: 12 * 3600_000 });
  say("Cove created shared-sdk and released it to Acme and Birch for contribute");
  await until(async () => (await k.state("a")).contributions.some(c => c.line === "seed") && (await k.state("b")).contributions.some(c => c.line === "seed"));

  const id = async (org: string, ref: string) => (await k.resolve(org, ref)).id;
  const task = (agent: string, line: string, files: string[], text: string, extra: Record<string, unknown> = {}) =>
    ({ key: `${agent}-${randomId(3)}`, agent, line, version: 1, task: text, files, inputs: [], provides: [], edit: agent, ...extra });
  const start = async (org: string, tasks: ReturnType<typeof task>[]) => {
    await k.call(org, "POST", "/api/agents", { tasks });
    for (const t of tasks) act("agent.start", { org, agent: t.agent, line: t.line, version: t.version });
  };
  const done = async (org: string, line: string, version = 1) =>
    until(async () => (await k.state(org)).contributions.some(c => c.own && c.line === line && c.version === version), 120_000);
  const cli = async (...a: string[]) => {
    const out = await new Promise<string>((ok, fail) => {
      execFile(process.execPath, [join(ROOT, "bin/kyoei.mjs"), ...a], { env: { ...process.env, KYOEI_ENV: envPath } }, (err, stdout, stderr) =>
        err ? fail(new Error(`kyoei ${a.join(" ")}: ${stderr || err.message}`)) : ok(stdout));
    });
    for (const line of out.trimEnd().split("\n")) say(`$ kyoei ${a.join(" ")}\n         ${line}`);
    act("cli", { args: a });
    return out;
  };

  // Wave 1: six agents at once, each in its own repository.
  say("wave 1: six agents start at the same time");
  await Promise.all([
    start("a", [task("a1", "a1", ["src/retry.ts"], "Add jitter to retry backoff"), task("a2", "a2", ["src/retry.ts"], "Cap the retry delay")]),
    start("b", [task("b1", "b1", ["src/sign.ts"], "HMAC request signer", { provides: ["signer@1"] })]),
    start("c", [task("c1", "c1", ["src/ratelimit.ts"], "Burst option for the rate limiter"), task("c3", "c3", ["src/client.ts"], "Request timeout"), task("c5", "c5", ["src/sign-cove.ts"], "Cove signer for the gateway", { provides: ["signer@1"] })]),
  ]);
  await until(async () => (await k.state("c")).overlaps.length > 0, 30_000);
  say("Cove's node flagged an overlap: a1 and a2 both declared src/retry.ts");
  await Promise.all([done("a", "a1"), done("a", "a2"), done("b", "b1"), done("c", "c1"), done("c", "c3"), done("c", "c5")]);
  say("wave 1 finished: six signed contributions");

  await cli("release", "b1", "--org", "b", "--to", "a,c", "--purpose", "contribute,integrate", "--onward", "c");
  await cli("release", "a1", "--org", "a", "--to", "c", "--purpose", "contribute,integrate");
  await cli("release", "a2", "--org", "a", "--to", "c", "--purpose", "integrate");
  await cli("release", "c5", "--org", "c", "--to", "a", "--purpose", "contribute,integrate");
  await until(async () => (await k.state("c")).contributions.filter(c => !c.own && c.verified).length >= 3 && (await k.state("a")).contributions.some(c => c.line === "c5"));

  for (const l of ["c1", "c3", "a1", "b1", "c5", "a2"]) await cli("approve", l, "--org", "c");
  for (const l of ["c1", "c3", "a1", "b1", "c5"]) await cli("ship", l, "--org", "c");
  await cli("gate", "a2", "--org", "c");
  await cli("ship", "a2", "--org", "c");
  await cli("rebase", "a2", "--org", "a", "--agent", "a2r");
  await done("a", "a2", 2);
  await cli("release", "a2@2", "--org", "a", "--to", "c", "--purpose", "integrate");
  await until(async () => (await k.state("c")).contributions.some(c => c.line === "a2" && c.version === 2));
  await cli("approve", "a2@2", "--org", "c");
  await cli("ship", "a2@2", "--org", "c");

  // Wave 2: four agents build on released work.
  const b1 = await id("a", "b/b1");
  const a1 = await id("a", "a1");
  say("wave 2: four agents start; three build on Birch's signer b1");
  await Promise.all([
    start("a", [task("a3", "a3", ["src/signed-retry.ts"], "Signed retries", { inputs: [{ id: b1, relation: "builds-on" }, { id: a1, relation: "builds-on" }] })]),
    start("c", [task("c2", "c2", ["src/client.ts"], "Sign each request when a secret is set", { inputs: [{ id: await id("c", "b/b1"), relation: "builds-on" }] })]),
    start("b", [task("b2", "b2", ["test/sign.vectors.ts"], "Signer test vectors", { inputs: [{ id: await id("b", "b1"), relation: "builds-on" }] }),
      task("b3", "b3", ["docs/signing.md"], "Signing documentation", { inputs: [{ id: await id("b", "b1"), relation: "cites" }] })]),
  ]);
  await Promise.all([done("a", "a3"), done("c", "c2"), done("b", "b2"), done("b", "b3")]);
  await cli("release", "a3", "--org", "a", "--to", "c", "--purpose", "integrate");
  await until(async () => (await k.state("c")).contributions.some(c => c.line === "a3"));
  await cli("approve", "c2", "--org", "c");
  await cli("ship", "c2", "--org", "c");
  await cli("approve", "a3", "--org", "c");

  // Incident.
  say("incident: Birch withdraws b1");
  act("incident.start");
  await cli("withdraw", "b1", "--org", "b", "--reason", "origin of one snippet is not verified; license unknown");
  await start("c", [task("c4", "c4", ["README.md"], "README update")]);
  await until(async () => (await k.state("a")).contributions.find(c => c.line === "a3")?.state === "withdrawn"
    && (await k.state("c")).notices.some(n => n.item.startsWith("main:")) && (await k.state("b")).contributions.find(c => c.line === "b2")?.state === "withdrawn");
  say("each node computed its own affected work");
  await cli("gate", "a3", "--org", "c");
  await cli("ship", "a3", "--org", "c");
  await done("c", "c4");
  await cli("approve", "c4", "--org", "c");
  await cli("ship", "c4", "--org", "c");
  await cli("release", "b3", "--org", "b", "--to", "c", "--purpose", "integrate");
  await until(async () => (await k.state("c")).contributions.some(c => c.line === "b3"));
  await cli("approve", "b3", "--org", "c");
  await cli("ship", "b3", "--org", "c");

  // Acme moves onto Cove's released signer.
  await cli("alternatives", "a3", "--org", "a");
  await cli("rebase", "a3", "--org", "a", "--onto", "c/c5", "--agent", "a3r");
  await done("a", "a3", 2);
  await cli("release", "a3@2", "--org", "a", "--to", "c", "--purpose", "integrate");
  await until(async () => (await k.state("c")).contributions.some(c => c.line === "a3" && c.version === 2));
  await cli("approve", "a3@2", "--org", "c");
  await cli("ship", "a3@2", "--org", "c");

  // Birch publishes a clean replacement.
  say("correction: Birch writes a clean replacement for b1");
  await start("b", [task("b4", "b1", ["src/sign.ts"], "Clean signer written from the specification", { version: 2, provides: ["signer@1"], inputs: [{ id: await id("b", "b1"), relation: "supersedes" }] })]);
  await done("b", "b1", 2);
  await cli("release", "b1@2", "--org", "b", "--to", "a,c", "--purpose", "contribute,integrate", "--onward", "c");
  await until(async () => (await k.state("c")).contributions.some(c => c.line === "b1" && c.version === 2 && c.verified));
  await cli("rebase", "c2", "--org", "c", "--onto", "b/b1@2", "--agent", "c2r");
  await cli("rebase", "b2", "--org", "b", "--onto", "b1@2", "--agent", "b2r");
  await Promise.all([done("c", "c2", 2), done("b", "b2", 2)]);
  await cli("release", "b2@2", "--org", "b", "--to", "c", "--purpose", "integrate");
  await until(async () => (await k.state("c")).contributions.some(c => c.line === "b2" && c.version === 2));
  for (const l of ["b/b1@2", "c2@2", "b/b2@2"]) await cli("approve", l, "--org", "c");
  for (const l of ["b/b1@2", "c2@2", "b/b2@2"]) await cli("ship", l, "--org", "c");
  await until(async () => (await Promise.all(["a", "b", "c"].map(o => k.state(o)))).every(s => s.outbox.length === 0), 30_000);

  // Plain Git: clone the integration repository with a read token.
  const clone = join(state, "shared-sdk");
  rmSync(clone, { recursive: true, force: true });
  if (repo) {
    const token = repo.svc.mint("c", "c/shared-sdk", "read", 300_000);
    const bundle = join(state, "shared-sdk.bundle");
    const res = await fetch(`${repo.url}/bundle?repo=c/shared-sdk`, { headers: { authorization: `Bearer ${token.secret}` } });
    writeFileSync(bundle, Buffer.from(await res.arrayBuffer()));
    repo.svc.revoke("c", token.id);
    execFileSync("git", ["clone", "-q", "--branch", "main", bundle, clone]);
    execFileSync("git", ["-C", clone, "fetch", "-q", bundle, "refs/notes/kyoei:refs/notes/kyoei"]);
  } else {
    // Artifacts: a short read token from Wrangler, sent as a header through
    // the environment, so it is not in the URL, the arguments or any log.
    const wrangler = (args: string[]) => JSON.parse(execFileSync("npx", ["wrangler", ...args, "--json"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString());
    const info = wrangler(["artifacts", "repos", "get", "shared-sdk", "--namespace", "kyoei-c"]);
    const issued = wrangler(["artifacts", "repos", "issue-token", "shared-sdk", "--namespace", "kyoei-c", "--scope", "read", "--ttl", "120"]);
    const secret = String(issued.plaintext ?? issued.token ?? "");
    if (!secret) throw new Error("no read token issued");
    const gitEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` };
    execFileSync("git", ["clone", "-q", "--branch", "main", String(info.remote), clone], { env: gitEnv });
    execFileSync("git", ["-C", clone, "fetch", "-q", "origin", "refs/notes/kyoei:refs/notes/kyoei"], { env: gitEnv });
  }
  const log = execFileSync("git", ["-C", clone, "log", "--notes=kyoei", "--format=%h %s%n%N"]).toString();
  writeFileSync(join(dir, "git-log.txt"), log);
  say("plain git log --notes=kyoei on a fresh clone:");
  const shown = execFileSync("git", ["-C", clone, "log", "--notes=kyoei", "--no-merges", "-n", "2", "--format=%h %s%n%N"]).toString();
  for (const l of shown.split("\n")) if (l && !l.startsWith("signed-record:")) say(`  ${l.slice(0, 110)}`);
  act("done");

  if (remote) {
    // Deployed nodes keep their logs in storage; copy them next to the run.
    for (const o of ["a", "b", "c"]) {
      const lines: string[] = [];
      for (let after = 0; ;) {
        const page = await k.call<{ seq: number; entry: unknown }[]>(o, "GET", `/api/log?after=${after}`);
        if (!page.length) break;
        for (const r of page) lines.push(JSON.stringify(r.entry));
        after = page[page.length - 1]!.seq;
      }
      writeFileSync(join(dir, `${o}.jsonl`), lines.join("\n") + "\n");
    }
  }
  const finals: Record<string, StateView> = {};
  for (const o of ["a", "b", "c"]) finals[o] = await k.state(o);
  writeFileSync(join(dir, "final-state.json"), JSON.stringify(finals, null, 1));
  execFileSync(process.execPath, [join(ROOT, "scripts/summary.ts"), dir], { stdio: "inherit" });
  if (hold) {
    say("holding; press Ctrl-C to stop");
    await new Promise(() => {});
  }
} finally {
  for (const c of children) c.kill();
  if (repo) {
    await repo.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function until(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error("timed out waiting for the scenario");
    await new Promise(r => setTimeout(r, 200));
  }
}

void existsSync;
