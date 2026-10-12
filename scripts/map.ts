// Branch map of a run: time runs left to right; each organization is a band;
// each line of work is a branch inside its organization's band. Every mark
// comes from a logged event:
//   run.started → run.finished       branch segment (agent at work)
//   release.sent                      dashed link to each recipient band
//   contribution.registered inputs   builds-on link from the input's branch
//   ship.merged                       dot on Cove's main line
//   notice.opened (blocking)          grey hatch from the notice time on
//   withdraw.issued                   red cross on the withdrawn branch
// Usage: node scripts/map.ts runs/<id>  → runs/<id>/map.svg

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type Ev = { t: number; org: string; type: string; [k: string]: any };
const dir = process.argv[2] ?? "runs/current";
const events: Ev[] = [];
for (const org of ["a", "b", "c"]) {
  const p = join(dir, `${org}.jsonl`);
  if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) if (l) events.push(JSON.parse(l));
}
events.sort((x, y) => x.t - y.t);
const of = (type: string) => events.filter(e => e.type === type);

const COLOR: Record<string, string> = { a: "#2f6fdb", b: "#d9822b", c: "#8b4fc7" };
const NAME: Record<string, string> = { a: "Acme", b: "Birch", c: "Cove" };
const t0 = Math.min(...events.map(e => e.t));
const t1 = Math.max(...events.map(e => e.t));
const W = 1600, LEFT = 120, RIGHT = 30, ROW = 26;
const x = (t: number) => LEFT + ((t - t0) / Math.max(1, t1 - t0)) * (W - LEFT - RIGHT);

// One branch per (org, line, version), in order of first appearance.
interface Branch { key: string; org: string; line: string; version: number; agent: string; start: number; end: number; id?: string; y: number }
const branches: Branch[] = [];
for (const e of of("run.started")) {
  const fin = of("run.finished").find(f => f.run === e.run);
  branches.push({ key: `${e.org}/${e.line}/${e.version}`, org: e.org, line: e.line, version: e.version, agent: e.agent, start: e.t, end: fin?.t ?? e.t, id: fin?.contribution, y: 0 });
}
const bands: Record<string, { top: number; rows: string[] }> = {};
let y = 40;
for (const org of ["a", "b", "c"]) {
  const lines = [...new Set(branches.filter(b => b.org === org).map(b => b.line))];
  if (org === "c") lines.unshift("main");
  bands[org] = { top: y, rows: lines };
  y += 30 + lines.length * ROW;
}
const H = y + 30;
const rowY = (org: string, line: string) => bands[org]!.top + 30 + bands[org]!.rows.indexOf(line) * ROW;
for (const b of branches) b.y = rowY(b.org, b.line);
const byId = new Map(branches.filter(b => b.id).map(b => [b.id!, b]));
const seed = of("contribution.registered").find(e => e.line === "seed");

const out: string[] = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, monospace" font-size="12">`);
out.push(`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="6" stroke="#8a8a8a" stroke-width="3"/></pattern>`);
out.push(`<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#555"/></marker></defs>`);
out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
for (const org of ["a", "b", "c"]) {
  const band = bands[org]!;
  out.push(`<rect x="0" y="${band.top}" width="${W}" height="${20 + band.rows.length * ROW}" fill="${COLOR[org]}" fill-opacity="0.06"/>`);
  out.push(`<text x="10" y="${band.top + 18}" font-weight="bold" fill="${COLOR[org]}">${NAME[org]}</text>`);
  for (const line of band.rows) out.push(`<text x="10" y="${rowY(org, line) + 4}" fill="#444">${line}</text>`);
}
// Cove's main line.
const mainY = rowY("c", "main");
out.push(`<line x1="${x(seed?.t ?? t0)}" y1="${mainY}" x2="${W - RIGHT}" y2="${mainY}" stroke="${COLOR.c}" stroke-width="4"/>`);

// Blocking notices: hatch from the notice time to the end, on the branch.
const blockedAt = new Map<string, number>();
for (const n of of("notice.opened").filter(n => n.blocking)) {
  const id = String(n.item).replace(/^main:/, "");
  if (!blockedAt.has(id)) blockedAt.set(id, n.t);
}
for (const w of of("withdraw.issued")) blockedAt.set(w.id, Math.min(blockedAt.get(w.id) ?? Infinity, w.t));

// Branch segments.
for (const b of branches) {
  const color = COLOR[b.org];
  const blocked = b.id ? blockedAt.get(b.id) : undefined;
  out.push(`<line x1="${x(b.start)}" y1="${b.y}" x2="${x(b.end)}" y2="${b.y}" stroke="${color}" stroke-width="6" stroke-linecap="round"><title>${b.org}/${b.line} v${b.version} by ${b.agent}</title></line>`);
  const shipped = of("ship.merged").find(s => s.id === b.id);
  const until = blocked ?? shipped?.t ?? t1;
  out.push(`<line x1="${x(b.end)}" y1="${b.y}" x2="${x(until)}" y2="${b.y}" stroke="${color}" stroke-width="2" stroke-opacity="0.6"/>`);
  if (blocked) out.push(`<rect x="${x(blocked)}" y="${b.y - 5}" width="${Math.max(2, x(t1) - x(blocked))}" height="10" fill="url(#hatch)" stroke="#8a8a8a" stroke-width="0.5"><title>affected from ${((blocked - t0) / 1000).toFixed(1)} s</title></rect>`);
  out.push(`<text x="${x(b.start)}" y="${b.y - 8}" fill="${color}" font-size="10">${b.agent}${b.version > 1 ? ` (v${b.version})` : ""}</text>`);
}
// Builds-on and citation links from each input's branch end to the dependent's start.
for (const r of of("contribution.registered")) {
  const dep = byId.get(r.id);
  if (!dep) continue;
  for (const i of r.inputs as { id: string; relation: string }[]) {
    const src = byId.get(i.id);
    if (!src) continue;
    const dash = i.relation === "builds-on" ? "" : ` stroke-dasharray="2,3"`;
    const color = i.relation === "supersedes" ? "#c0392b" : "#555";
    out.push(`<path d="M${x(src.end)},${src.y} C${x(src.end) + 30},${src.y} ${x(dep.start) - 30},${dep.y} ${x(dep.start)},${dep.y}" fill="none" stroke="${color}" stroke-width="1.2"${dash} marker-end="url(#arrow)"><title>${i.relation}</title></path>`);
  }
}
// Releases: a short dashed tick into each recipient band.
for (const r of of("release.sent")) {
  const src = byId.get(r.id);
  if (!src) continue;
  for (const to of r.to as string[]) {
    const ty = bands[to]!.top + 8;
    out.push(`<line x1="${x(r.t)}" y1="${src.y}" x2="${x(r.t)}" y2="${ty}" stroke="${COLOR[src.org]}" stroke-width="1" stroke-dasharray="4,3" stroke-opacity="0.7"><title>release ${src.line} to ${NAME[to]}</title></line>`);
  }
}
// Ships onto main.
for (const s of of("ship.merged")) {
  const src = byId.get(s.id);
  if (src) out.push(`<path d="M${x(src.end)},${src.y} L${x(s.t)},${mainY}" stroke="${COLOR[src.org]}" stroke-width="1" stroke-opacity="0.5" fill="none"/>`);
  out.push(`<circle cx="${x(s.t)}" cy="${mainY}" r="5" fill="${src ? COLOR[src.org] : "#333"}" stroke="#fff" stroke-width="1.5"><title>ship ${s.line} v${s.version}</title></circle>`);
}
for (const s of of("ship.refused")) out.push(`<text x="${x(s.t)}" y="${mainY + 18}" fill="#c0392b" font-size="10">✗ ${s.line} ${s.code}</text>`);
for (const g of of("gate.decided").filter(g => !g.ok)) out.push(`<text x="${x(g.t)}" y="${mainY + 18}" fill="#c0392b" font-size="10">✗ ${g.line}</text>`);
for (const w of of("withdraw.issued")) {
  const b = byId.get(w.id);
  if (b) out.push(`<text x="${x(w.t) - 5}" y="${b.y + 5}" fill="#c0392b" font-size="16" font-weight="bold">✕<title>withdrawn: ${w.reason}</title></text>`);
}
for (const o of of("overlap.flagged")) out.push(`<text x="${x(o.t)}" y="${bands.a!.top + 18}" fill="#b7791f" font-size="11">△ overlap ${(o.files as string[]).join(",")}</text>`);
// Time axis.
for (let s = 0; s <= (t1 - t0) / 1000; s += 10) {
  const tx = x(t0 + s * 1000);
  out.push(`<line x1="${tx}" y1="${H - 24}" x2="${tx}" y2="${H - 18}" stroke="#999"/><text x="${tx - 8}" y="${H - 6}" fill="#777" font-size="10">${s}s</text>`);
}
out.push(`<text x="${W - 420}" y="20" fill="#777" font-size="10">generated from ${dir.split("/").pop()} node logs by scripts/map.ts</text>`);
out.push("</svg>");
writeFileSync(join(dir, "map.svg"), out.join("\n"));
process.stdout.write(`wrote ${join(dir, "map.svg")}: ${branches.length} branches, ${of("ship.merged").length} ships\n`);
