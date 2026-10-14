// kyoei: command line for one organization's node.
//
//   kyoei status   --org a
//   kyoei watch    --org a                 live view: work, notices, overlaps
//   kyoei release  b1 --org b --to a,c --purpose contribute,integrate [--onward c]
//   kyoei approve  a1 --org c
//   kyoei ship     a1 --org c
//   kyoei gate     a3 --org c
//   kyoei withdraw b1 --org b --reason "..."
//   kyoei challenge b1 --org a --reason "..."
//   kyoei alternatives a3 --org a
//   kyoei rebase   a3 --org a --onto c/c5 --agent a3r [--edit a3r]
//   kyoei log      a3 --org a              the record and its git note fields
//   kyoei prov     --org a                 PROV-JSON for held contributions (--format jsonld)
//
// --as names the person; the default is "<org>.lead".

import { Client, loadEnv, type ContributionView, type StateView } from "./client.ts";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m" };
const ORG_COLOR: Record<string, string> = { a: C.blue, b: C.yellow, c: C.magenta };
const ORG_NAME: Record<string, string> = { a: "Acme", b: "Birch", c: "Cove" };

function args(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[++i]! : "true";
    else pos.push(a);
  }
  return { cmd, pos, flags };
}

function label(c: ContributionView): string {
  return `${ORG_COLOR[c.org] ?? ""}${c.org}/${c.line}${c.version > 1 ? ` v${c.version}` : ""}${C.reset}`;
}

function stateColor(s: string): string {
  if (s === "usable") return `${C.green}usable${C.reset}`;
  if (s === "withdrawn") return `${C.red}withdrawn${C.reset}`;
  return `${C.yellow}${s}${C.reset}`;
}

export function render(st: StateView, width = 100): string {
  const out: string[] = [];
  const name = ORG_NAME[st.org] ?? st.org;
  out.push(`${C.bold}${ORG_COLOR[st.org] ?? ""}${name}${C.reset} ${C.dim}node ${st.org} · key ${st.fingerprint.slice(0, 12)}${st.org === st.integrator ? " · integrator" : ""}${C.reset}`);
  out.push("");
  out.push(`${C.bold}Work${C.reset}`);
  const rows = [...st.contributions].filter(c => c.line !== "seed").sort((x, y) => (x.own === y.own ? x.line.localeCompare(y.line) || x.version - y.version : x.own ? -1 : 1));
  for (const c of rows) {
    const flags = [c.shipped ? `${C.green}shipped${C.reset}` : "", c.approved && !c.shipped ? "approved" : "", c.challenges ? `${C.yellow}challenged${C.reset}` : ""].filter(Boolean).join(" ");
    const rel = c.own ? (c.released.length ? `→ ${[...new Set(c.released.map(r => r.to))].join(",")}${c.released.every(r => r.revoked) ? " (revoked)" : ""}` : "") : `from ${c.held?.from ?? c.org}`;
    const inputs = c.inputs.map(i => `${i.relation === "builds-on" ? "⟵" : "·"}${i.label}`).join(" ");
    out.push(`  ${label(c).padEnd(22)} ${stateColor(c.state).padEnd(30)} ${rel.padEnd(16)} ${flags} ${C.dim}${inputs}${C.reset}`.slice(0, width + 40));
  }
  const open = st.notices.filter(n => n.state === "open");
  out.push("");
  out.push(`${C.bold}Notices${C.reset} ${C.dim}(${open.length} open, ${st.notices.length - open.length} closed)${C.reset}`);
  for (const n of open) {
    const item = n.item.startsWith("main:") ? `main ⟵ ${short(st, n.item.slice(5))}` : short(st, n.item);
    out.push(`  ${n.blocking ? `${C.red}■ blocked${C.reset}` : `${C.yellow}□ notice ${C.reset}`} ${item.padEnd(20)} ${n.source.kind} by ${n.source.org}: ${n.source.reason}`.slice(0, width + 20));
    out.push(`    ${C.dim}who can act: ${n.act.join(", ")} · repairs: ${n.repairs.join(", ")}${n.dissent.length ? ` · dissent: ${n.dissent.length}` : ""}${C.reset}`);
  }
  if (st.overlaps.length) {
    out.push("");
    out.push(`${C.bold}Overlaps${C.reset}`);
    for (const o of st.overlaps) out.push(`  ${C.yellow}△${C.reset} ${o.a.org}/${o.a.agent} and ${o.b.org}/${o.b.agent} both declared ${o.files.join(", ")}`);
  }
  if (st.org === st.integrator && st.main.length) {
    out.push("");
    out.push(`${C.bold}main${C.reset} ${C.dim}${st.main.at(-1)!.head.slice(0, 12)} · ${st.main.length - 1} merges${C.reset}`);
    const refused = st.ops.filter(o => o.state === "refused").slice(-3);
    for (const o of refused) out.push(`  ${C.red}✗${C.reset} ${short(st, o.contribution)} refused: ${o.code}`);
  }
  const pending = st.outbox.length;
  out.push("");
  out.push(`${C.dim}outbox: ${pending} pending${st.outbox.some(o => o.failed) ? " (some refused)" : ""}${C.reset}`);
  return out.join("\n");
}

function short(st: StateView, id: string): string {
  const c = st.contributions.find(x => x.id === id);
  return c ? `${c.org}/${c.line}${c.version > 1 ? ` v${c.version}` : ""}` : id.slice(0, 12);
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = args(process.argv.slice(2));
  if (cmd === "help" || flags.help) {
    process.stdout.write((await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n") + "\n");
    return;
  }
  const client = new Client(loadEnv(flags.env));
  const org = flags.org ?? "a";
  const actor = flags.as ?? `${org}.lead`;
  const list = (v?: string) => (v ? v.split(",").map(s => s.trim()).filter(Boolean) : []);
  switch (cmd) {
    case "status": {
      process.stdout.write(render(await client.state(org)) + "\n");
      return;
    }
    case "watch": {
      const interval = Number(flags.interval ?? 500);
      for (;;) {
        let text: string;
        try { text = render(await client.state(org), process.stdout.columns || 100); } catch (e) { text = `${C.dim}waiting for node ${org}: ${(e as Error).message}${C.reset}`; }
        process.stdout.write("\x1b[H\x1b[2J" + text + "\n");
        if (flags.once) return;
        await new Promise(r => setTimeout(r, interval));
      }
    }
    case "release": {
      const c = await client.resolve(org, pos[0]!);
      const purposes = list(flags.purpose ?? "contribute,integrate");
      const onward = list(flags.onward).map(o => ({ org: o, purposes }));
      const r = await client.call<{ to: string }[]>(org, "POST", "/api/release", { actor, id: c.id, to: list(flags.to), purposes, ttlMs: Number(flags.ttl ?? 6 * 3600_000), onward });
      process.stdout.write(`released ${label(c)} to ${r.map(x => x.to).join(", ")} for ${purposes.join(", ")}; one read token per recipient\n`);
      return;
    }
    case "approve": {
      const c = await client.resolve(org, pos[0]!);
      await client.call(org, "POST", "/api/approve", { actor, id: c.id });
      process.stdout.write(`${actor} signed off ${label(c)} at commit ${c.commit.slice(0, 12)}, root ${c.root.slice(0, 12)}\n`);
      return;
    }
    case "gate": {
      const c = await client.resolve(org, pos[0]!);
      const checks = await client.call<{ name: string; ok: boolean; code?: string; reason: string }[]>(org, "GET", `/api/gate?for=${c.id}`);
      process.stdout.write(`gate for ${label(c)}\n` + checks.map(x => `  ${x.ok ? `${C.green}✓${C.reset}` : `${C.red}✗ ${x.code}${C.reset}`} ${x.name.padEnd(9)} ${x.reason}`).join("\n") + "\n");
      return;
    }
    case "ship": {
      const c = await client.resolve(org, pos[0]!);
      const op = await client.call<{ state: string; code?: string; head?: string }>(org, "POST", "/api/ship", { actor, id: c.id });
      process.stdout.write(op.state === "merged" ? `${C.green}shipped${C.reset} ${label(c)} → main ${op.head?.slice(0, 12)}\n` : `${C.red}refused${C.reset} ${label(c)}: ${op.code ?? op.state}\n`);
      return;
    }
    case "withdraw": {
      const c = await client.resolve(org, pos[0]!);
      const r = await client.call<{ revoked: number; failed: number }>(org, "POST", "/api/withdraw", { actor, id: c.id, reason: flags.reason ?? "" });
      process.stdout.write(`withdrew ${label(c)}: ${r.revoked} read tokens revoked${r.failed ? `, ${r.failed} failed` : ""}; signed withdraw sent\n`);
      return;
    }
    case "challenge": {
      const c = await client.resolve(org, pos[0]!);
      await client.call(org, "POST", "/api/challenge", { actor, id: c.id, reason: flags.reason ?? "" });
      process.stdout.write(`challenged ${label(c)}\n`);
      return;
    }
    case "alternatives": {
      const c = await client.resolve(org, pos[0]!);
      const alts = await client.call<{ org: string; line: string; version: number; provides: string[]; kind: string }[]>(org, "GET", `/api/alternatives?for=${c.id}`);
      process.stdout.write(`options for ${label(c)} (state ${c.state}):\n` + (alts.length ? alts.map(a => `  ${a.kind.padEnd(12)} ${ORG_COLOR[a.org]}${a.org}/${a.line}${a.version > 1 ? ` v${a.version}` : ""}${C.reset} provides ${a.provides.join(", ")}`).join("\n") : "  none released to this organization") + "\n");
      return;
    }
    case "rebase": {
      const c = await client.resolve(org, pos[0]!);
      const onto = flags.onto ? await client.resolve(org, flags.onto) : null;
      const r = await client.call<{ started: string; plan: { version: number } }>(org, "POST", "/api/repair", { actor, id: c.id, onto: onto?.id ?? null, agent: flags.agent, edit: flags.edit ?? flags.agent, key: flags.key });
      process.stdout.write(`repair agent ${flags.agent} started: ${org}/${c.line} v${r.plan.version}${onto ? ` onto ${label(onto)}` : " on main"}\n`);
      return;
    }
    case "prov": {
      const doc = await client.call<{ prov: unknown; jsonld: unknown }>(org, "GET", "/api/prov");
      const body = flags.format === "jsonld" ? doc.jsonld : doc.prov;
      process.stdout.write(JSON.stringify(body, null, 1) + "\n");
      return;
    }
    case "log": {
      const c = await client.resolve(org, pos[0]!);
      process.stdout.write(`${label(c)} ${c.state}\n  record  ${c.id}\n  commit  ${c.commit}\n  content ${c.root}\n  task    ${c.task}\n  why     ${c.rationale}\n` + c.inputs.map(i => `  input   ${i.relation} ${i.label}`).join("\n") + "\n");
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("kyoei.mjs")) {
  main().catch(e => {
    process.stderr.write(`kyoei: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
