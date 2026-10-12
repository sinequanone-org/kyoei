// Builds runs/<id>/summary.json from the node logs only. No number here is
// typed in: each one is a count or a time difference over logged events.
//   node scripts/summary.ts runs/<id>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type Ev = { t: number; org: string; type: string; [k: string]: any };

const dir = process.argv[2] ?? "runs/current";
const events: Ev[] = [];
for (const org of ["a", "b", "c"]) {
  const p = join(dir, `${org}.jsonl`);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) if (line) events.push(JSON.parse(line));
}
events.sort((x, y) => x.t - y.t);
const of = (type: string) => events.filter(e => e.type === type);

// Agent runs and concurrency.
const runs = [...of("run.finished"), ...of("run.failed")];
const spans = of("run.finished").map(e => ({ start: e.started as number, end: e.t, key: `${e.org}/${e.agent}` }));
let maxConcurrent = 0;
for (const s of spans) maxConcurrent = Math.max(maxConcurrent, spans.filter(o => o.start < s.end && o.end > s.start && o.start <= s.start).length);
const models = new Set(of("run.finished").map(e => e.model));

// Overlaps flagged before both agents finished.
const finishedAt = (org: string, agent: string) => of("run.finished").find(e => e.org === org && e.agent === agent)?.t ?? Infinity;
const early = of("overlap.flagged").filter(o => {
  const [x, y] = (o.agents as string[]).map(s => s.split("/"));
  return o.t < finishedAt(x![0]!, x![1]!) && o.t < finishedAt(y![0]!, y![1]!);
});

// The withdrawal and its delivery. Notices are selected by the withdrawal's
// cause digest, never by time: the owner's node logs its own notices before
// it logs `withdraw.issued`. An item `main:<id>` is the integrator's shipped
// copy of <id> in the shared repository, not a separate line of work.
const withdraw = of("withdraw.issued")[0];
const cause = withdraw?.cause as string | undefined;
const self = withdraw ? new Set([withdraw.id as string, `main:${withdraw.id}`]) : new Set<string>();
const deliveries = withdraw ? of("event.received").filter(e => e.kind === "withdraw" && e.t >= withdraw.t) : [];
// The owner's node logs each acknowledged delivery with `ms` from queueing to
// the peer's receipt, both read from the owner's own clock. A peer answers
// "applied" only after it has checked the event and opened its notices.
const acks = withdraw ? of("event.delivered").filter(e => e.org === withdraw.org && e.kind === "withdraw" && e.t >= withdraw.t) : [];
const causeNotices = cause ? of("notice.opened").filter(n => n.cause === cause && !self.has(n.item)) : [];
const blockedWork = causeNotices.filter(n => n.blocking && !(n.item as string).startsWith("main:"));
const blockedShipped = of("notice.opened").filter(n => cause && n.cause === cause && n.blocking && (n.item as string).startsWith("main:"));
const correction = withdraw ? of("release.sent").find(e => e.org === withdraw.org && e.line === withdraw.line && e.t > withdraw.t) : undefined;
const window = (e: Ev) => withdraw && e.t > withdraw.t && (!correction || e.t < correction.t);
const notified = new Set(causeNotices.map(n => n.line));
const shippedInWindow = of("ship.merged").filter(window);
const corrections = new Set(of("contribution.registered").filter(e => (e.inputs as { relation: string }[]).some(i => i.relation === "supersedes")).map(e => e.id));
const repairs = of("run.finished").filter(e => e.version > 1 && !corrections.has(e.contribution));
const repairShips = of("ship.merged").filter(e => e.version > 1 && correction && e.t >= correction.t);

// Each repair a person planned after the withdrawal: onto a replacement from
// the same owner, or onto an alternative another organization released.
const records = new Map(of("contribution.registered").map(e => [e.id as string, e]));
const paths = of("repair.planned").filter(e => withdraw && e.from === withdraw.id).map(e => {
  const onto = records.get(e.onto as string);
  const merged = of("ship.merged").find(m => m.org === e.org && m.line === e.line && m.version > 1 && m.t > e.t);
  return {
    org: e.org as string,
    line: e.line as string,
    onto: onto ? `${onto.org}/${onto.line}@${onto.version}` : null,
    kind: !onto ? "rebase" : onto.org === withdraw!.org && onto.line === withdraw!.line ? "replacement" : "alternative",
    merged_seconds_after_withdrawal: merged ? (merged.t - withdraw!.t) / 1000 : null,
  };
});

// Notices still open when the run ended.
const closedIds = new Set(of("notice.closed").map(e => e.notice));
const openAtEnd = of("notice.opened").filter(n => !closedIds.has(n.notice)).map(n => ({ org: n.org, line: n.line, kind: n.kind, blocking: n.blocking }));

const summary = {
  run: dir.split("/").pop(),
  source: "node logs a.jsonl, b.jsonl, c.jsonl; computed by scripts/summary.ts",
  runs: {
    total: runs.length,
    failed: of("run.failed").length,
    mode: [...models].join(", "),
    max_concurrent: maxConcurrent,
  },
  overlap: { flagged: of("overlap.flagged").length, flagged_early: early.length },
  events: { sent: of("event.delivered").length, refused: of("event.refused").length, retries: of("event.retry").length },
  releases: { received: of("release.received").length, content_verified: of("release.received").filter(e => e.content_verified === true).length },
  tokens: { issued: of("release.sent").reduce((n, e) => n + (e.tokens as string[]).length, 0), revoked: of("withdraw.issued").reduce((n, e) => n + (e.tokens_revoked as number), 0) },
  withdraw: {
    delivery_max_seconds: deliveries.length ? Math.max(...deliveries.map(d => d.t - withdraw!.t)) / 1000 : null,
    ack_max_ms_owner_clock: acks.length ? Math.max(...acks.map(a => a.ms as number)) : null,
    ack_attempts_max: acks.length ? Math.max(...acks.map(a => a.attempt as number)) : null,
    acks_applied: acks.filter(a => a.status === "applied").length,
    peers_reached: new Set(deliveries.map(d => d.org)).size,
    blocked_work: new Set(blockedWork.map(n => n.item)).size,
    blocked_work_by_org: Object.fromEntries([...new Set(blockedWork.map(n => n.org as string))].sort().map(o => [o, new Set(blockedWork.filter(n => n.org === o).map(n => n.item)).size])),
    blocked_shipped: new Set(blockedShipped.map(n => n.item)).size,
    notice_only: new Set(causeNotices.filter(n => !n.blocking).map(n => n.item)).size,
    unrelated_shipped: shippedInWindow.filter(e => !notified.has(e.line) && e.version === 1).length,
    notice_only_shipped: shippedInWindow.filter(e => causeNotices.some(n => !n.blocking && n.line === e.line && n.org === e.org)).length,
    gate_refusals: of("gate.decided").filter(e => window(e) && !e.ok).length,
  },
  repair: {
    runs: repairs.length,
    corrections: corrections.size,
    seconds_after_correction: correction && repairShips.length ? (Math.max(...repairShips.map(e => e.t)) - correction.t) / 1000 : null,
    paths,
  },
  merge: {
    shipped: of("ship.merged").length,
    stale_base: of("ship.refused").filter(e => e.code === "stale-base").length + of("gate.decided").filter(e => !e.ok && (e.checks as any[]).some(c => c.code === "stale-base")).length,
  },
  approvals: {
    total: of("approval.recorded").length + of("release.sent").length + of("withdraw.issued").length,
    signoffs: of("approval.recorded").length,
    releases: of("release.sent").length,
    withdrawals: of("withdraw.issued").length,
  },
  notices: { opened: of("notice.opened").length, closed: of("notice.closed").length, open_at_end: openAtEnd },
  elapsed_seconds: events.length ? (events[events.length - 1]!.t - events[0]!.t) / 1000 : null,
};

writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
