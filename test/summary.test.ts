// scripts/summary.ts counts from the node logs only. These cases cover two
// log shapes that a time-based count gets wrong: the owner's node logs its own
// notices before `withdraw.issued`, and the integrator holds a second notice
// for the shipped copy `main:<id>` of each affected item.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

type Row = Record<string, unknown>;

function run(logs: Record<"a" | "b" | "c", Row[]>): any {
  const dir = mkdtempSync(join(tmpdir(), "kyoei-summary-"));
  try {
    for (const [org, rows] of Object.entries(logs)) writeFileSync(join(dir, `${org}.jsonl`), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    execFileSync(process.execPath, ["scripts/summary.ts", dir], { stdio: "ignore" });
    return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const W = "w".repeat(64);   // withdrawn record
const K = "k".repeat(64);   // cause digest of the withdrawal
const C5 = "5".repeat(64);  // alternative released by another organization
const notice = (t: number, org: string, item: string, line: string, blocking: boolean, cause = K) =>
  ({ t, org, type: "notice.opened", notice: `${cause.slice(0, 16)}:${item}`, item, line, version: 1, blocking, cause, kind: "withdraw" });

test("summary selects withdrawal notices by cause and item, not by time", () => {
  const s = run({
    b: [
      notice(100, "b", "b2-id", "b2", true),            // logged before withdraw.issued
      notice(100, "b", "b3-id", "b3", false),
      { t: 101, org: "b", type: "withdraw.issued", id: W, line: "b1", cause: K, tokens_revoked: 2 },
      { t: 104, org: "b", type: "event.delivered", kind: "withdraw", to: "a", ms: 40, attempt: 1, status: "applied" },
      { t: 105, org: "b", type: "event.delivered", kind: "withdraw", to: "c", ms: 65, attempt: 2, status: "applied" },
    ],
    a: [
      { t: 60, org: "c", type: "contribution.registered", id: C5, line: "c5", version: 1, inputs: [] },
      { t: 90, org: "a", type: "release.received", line: "b1", content_verified: true },
      { t: 91, org: "a", type: "release.received", line: "c5", content_verified: false },
      { t: 102, org: "a", type: "event.received", kind: "withdraw" },
      notice(102, "a", "a3-id", "a3", true),
      notice(103, "a", "a3-id", "a3", true, "z".repeat(64)),   // another cause: not counted
      { t: 110, org: "a", type: "repair.planned", line: "a3", onto: C5, from: W },
      { t: 120, org: "a", type: "ship.merged", line: "a3", version: 2 },
    ],
    c: [
      { t: 102, org: "c", type: "event.received", kind: "withdraw" },
      notice(102, "c", "c2-id", "c2", true),
      notice(102, "c", "main:c2-id", "c2", true),        // shipped copy of c2
      notice(102, "c", `main:${W}`, "b1", true),         // shipped copy of the withdrawn item
      { t: 105, org: "c", type: "ship.merged", line: "c4", version: 1 },
    ],
  });
  assert.equal(s.withdraw.blocked_work, 3);
  assert.deepEqual(s.withdraw.blocked_work_by_org, { a: 1, b: 1, c: 1 });
  assert.equal(s.withdraw.blocked_shipped, 2);
  assert.equal(s.withdraw.notice_only, 1);
  assert.equal(s.withdraw.unrelated_shipped, 1);
  assert.equal(s.withdraw.peers_reached, 2);
  assert.equal(s.withdraw.delivery_max_seconds, 0.001);
  assert.deepEqual([s.withdraw.ack_max_ms_owner_clock, s.withdraw.ack_attempts_max, s.withdraw.acks_applied], [65, 2, 2]);
  assert.deepEqual(s.repair.paths.map((p: any) => [p.line, p.kind, p.merged_seconds_after_withdrawal]), [["a3", "alternative", 0.019]]);
  assert.deepEqual(s.releases, { received: 2, content_verified: 1 });
  assert.equal(s.notices.open_at_end.length, 7);
});
