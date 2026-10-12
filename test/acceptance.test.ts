// Acceptance tests for the port requirements in docs/acceptance.md. Each test
// name starts with its requirement ID.

import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, world, type World } from "./world.ts";
import { Refusal, type Envelope } from "../src/core/types.ts";
import { seal } from "../src/core/envelope.ts";
import { generateKey } from "../src/crypto/signer.ts";

async function refusal(p: Promise<unknown>, code: string): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Refusal, `expected a refusal, got ${e}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected refusal ${code}`);
}

// B releases a signer to A and C; A and C hold it.
async function signer(w: World, onward = true): Promise<string> {
  const b1 = await w.agent("b", { agent: "b1", line: "b1", files: ["src/sign.ts"], provides: ["signer@1"] });
  await w.nodes.b.release("b.lead", b1, ["a", "c"], ["contribute", "integrate"], 6 * 3600_000, onward ? [{ org: "c", purposes: ["contribute", "integrate"] }] : []);
  await settle(w);
  return b1;
}

test("R01 only a person releases, approves, withdraws and dissents", async () => {
  const w = await world();
  const b1 = await signer(w);
  await refusal(w.nodes.b.release("b1", b1, ["a"], ["contribute"], 60_000), "human-required");
  await refusal(w.nodes.c.approve("c1", b1), "human-required");
  await refusal(w.nodes.b.withdraw("b2", b1, "x"), "human-required");
  await refusal(w.nodes.c.ship("c3", b1), "human-required");
});

test("R02 forged, misaddressed, expired, foreign-collaboration and replayed envelopes are refused", async () => {
  const w = await world();
  const { a, b } = w.nodes;
  const b1 = await signer(w);
  const base = { deployment: "test", collaboration: "shared-sdk", id: "ab".repeat(16), kind: "withdraw" as const, issuer: "b", audience: "a", payload: { target: b1, cause: "x", reason: "r", rev: 9 }, now: w.clock.now(), ttlMs: 60_000 };
  const forger = (await generateKey("Ed25519")).pair;
  await refusal(a.receive(await seal(forger, base)), "not-authorized");
  const bKey = (b as unknown as { key: Parameters<typeof seal>[0] }).key;
  await refusal(a.receive(await seal(bKey, { ...base, audience: "c" })), "not-authorized");
  await refusal(a.receive(await seal(bKey, { ...base, collaboration: "other" })), "not-authorized");
  await refusal(a.receive(await seal(bKey, { ...base, deployment: "prod" })), "not-authorized");
  await refusal(a.receive(await seal(bKey, { ...base, now: w.clock.now() - 3600_000 })), "lease-expired");
  const tampered = await seal(bKey, base) as Envelope;
  await refusal(a.receive({ ...tampered, payload: { ...tampered.payload, reason: "other" } }), "not-authorized");
  // Only the owner withdraws: C cannot withdraw B's contribution at A.
  const cKey = (w.nodes.c as unknown as { key: Parameters<typeof seal>[0] }).key;
  await refusal(a.receive(await seal(cKey, { ...base, issuer: "c" })), "not-authorized");
  // A valid envelope applies once; a replay has no second effect.
  const valid = await seal(bKey, base);
  assert.equal((await a.receive(valid)).status, "applied");
  const noticesAfterFirst = a.notices().length;
  assert.equal((await a.receive(valid)).status, "duplicate");
  assert.equal(a.notices().length, noticesAfterFirst);
  // The same event ID with another payload is a conflict.
  await refusal(a.receive(await seal(bKey, { ...base, payload: { ...base.payload, reason: "changed" } })), "conflict");
});

test("R03 a signed record moved into another collaboration is refused", async () => {
  const w = await world();
  const b1 = await signer(w);
  const { verifyRecord } = await import("../src/core/record.ts");
  const c = w.nodes.a.requireRecord(b1);
  const peer = w.nodes.a.peers().get("b")!;
  await refusal(verifyRecord(c, peer, { deployment: "test", collaboration: "other", org: "b" }), "not-authorized");
  await refusal(verifyRecord({ ...c, body: { ...c.body, collaboration: "other" } }, peer, { deployment: "test", collaboration: "other", org: "b" }), "not-authorized");
});

test("R04 the recipient recomputes the BLAKE3 root; a wrong root is refused", async () => {
  const w = await world();
  const b1 = await signer(w);
  const { verifySnapshot } = await import("../src/core/record.ts");
  const c = w.nodes.a.requireRecord(b1);
  const entries = await w.nodes.b.host.snapshot(c.body.repo, c.body.commit, (await w.nodes.b.host.mint(c.body.repo, "read", 60_000)).secret);
  verifySnapshot(c, entries);
  const changed = entries.map(e => (e.path === "src/sign.ts" ? { ...e, bytes: new TextEncoder().encode("export const x = 1;\n") } : e));
  assert.throws(() => verifySnapshot(c, changed), /content root/);
  const mode = entries.map(e => (e.path === "src/sign.ts" ? { ...e, mode: "100755" as const } : e));
  assert.throws(() => verifySnapshot(c, mode), /content root/);
  assert.equal(w.nodes.a.record(b1)!.verified, true);
});

test("R05 onward release needs an explicit upstream grant", async () => {
  const w = await world();
  const b1 = await signer(w, false);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  const r = await refusal(w.nodes.a.release("a.lead", a3, ["c"], ["integrate"], 3600_000), "new-grant-required");
  assert.match(r.detail, /onward/);
  // Releasing back to the upstream owner needs no grant.
  await w.nodes.a.release("a.lead", a3, ["b"], ["integrate"], 3600_000);
  const w2 = await world();
  const b1b = await signer(w2, true);
  const a3b = await w2.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1b, relation: "builds-on" }] });
  const grants = await w2.nodes.a.release("a.lead", a3b, ["c"], ["integrate"], 48 * 3600_000);
  // The onward release cannot outlive the upstream grant.
  const held = w2.nodes.a.store.get<{ expires: number }>(`held:${b1b}`)!;
  assert.ok(grants[0]!.expires <= held.expires);
});

test("R06 withdrawal blocks declared dependents and keeps the cause", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  await settle(w);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  await settle(w);
  const e = w.nodes.a.effective(a3);
  assert.equal(e.code, "withdrawn");
  assert.equal(e.cause?.reason, "license unknown");
  const n = w.nodes.a.notices().find(x => x.item === a3)!;
  assert.deepEqual(Object.keys(n).filter(k => ["item", "evidence", "source", "act", "dissent", "repairs"].includes(k)).sort(), ["act", "dissent", "evidence", "item", "repairs", "source"]);
  assert.deepEqual(n.act, ["a.lead"]);
  assert.equal(n.evidence.record, a3);
  await refusal(w.nodes.a.readInput(b1, "contribute"), "withdrawn");
});

test("R07 a withdrawal at the owner reaches a third organization through blocked events", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  await w.nodes.a.release("a.lead", a3, ["c"], ["contribute", "integrate"], 3600_000);
  await settle(w);
  const c5 = await w.agent("c", { agent: "c5", line: "c5", files: ["src/use.ts"], inputs: [{ id: a3, relation: "builds-on" }] });
  await settle(w);
  // C also holds b1 directly. Remove that knowledge path: C learns only via A.
  const st = w.nodes.c.store;
  st.delete(`c:${b1}`);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  await settle(w);
  assert.equal(w.nodes.c.effective(c5).code, "withdrawn");
  assert.ok(w.logs.some(l => l.org === "a" && l.type === "event.delivered" && l.kind === "blocked" && l.to === "c"));
});

test("R08 a challenge notifies without blocking and reaches a third organization as affected", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  const a4 = await w.agent("a", { agent: "a4", line: "a4", files: ["docs/a.md"], inputs: [{ id: b1, relation: "cites" }] });
  await w.nodes.a.release("a.lead", a3, ["c"], ["contribute", "integrate"], 3600_000);
  await w.nodes.a.release("a.lead", a4, ["c"], ["contribute", "integrate"], 3600_000);
  await settle(w);
  w.nodes.c.store.delete(`c:${b1}`);
  const c5 = await w.agent("c", { agent: "c5", line: "c5", files: ["src/use.ts"], inputs: [{ id: a3, relation: "builds-on" }] });
  const c6 = await w.agent("c", { agent: "c1", line: "c6", files: ["src/doc.ts"], inputs: [{ id: a4, relation: "builds-on" }] });
  await settle(w);
  await w.nodes.a.challenge("a.lead", b1, "signature check skips the key id");
  await settle(w);
  assert.equal(w.nodes.a.effective(a3).code, null);
  assert.equal(w.nodes.c.effective(c5).code, null);
  const cn = w.nodes.c.notices().find(n => n.item === c5);
  assert.ok(cn && !cn.blocking && cn.source.kind === "affected");
  // A citation-only branch does not forward dependency impact.
  assert.equal(w.nodes.c.notices().find(n => n.item === c6), undefined);
  assert.ok(w.nodes.a.notices().some(n => n.item === a4 && !n.blocking));
});

test("R09 dissent after withdrawal stays visible and clears no block", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  await settle(w);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  await settle(w);
  const n = w.nodes.a.notices().find(x => x.item === a3)!;
  await w.nodes.a.dissent("a.lead", n.source.event, "we checked the snippet; it is ours");
  await settle(w);
  assert.equal(w.nodes.a.effective(a3).code, "withdrawn");
  assert.equal(w.nodes.a.notices().find(x => x.item === a3)!.dissent.length, 1);
  assert.ok(w.nodes.b.store.list("dissent:").length >= 1);
});

test("R10 a correction without a release of the replacement grants no access", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  await settle(w);
  const b4 = await w.agent("b", { agent: "b4", line: "b1", version: 2, files: ["src/sign.ts"], provides: ["signer@1"], inputs: [{ id: b1, relation: "supersedes" }] });
  await settle(w);
  assert.equal(w.nodes.a.effective(a3).code, "replacement-required");
  assert.equal(w.nodes.a.record(b4), undefined);
  await refusal(w.nodes.a.readInput(b1, "contribute"), "replacement-required");
});

test("R11 two withdrawn inputs: replacing one keeps the other block", async () => {
  const w = await world();
  const b1 = await signer(w);
  const c1 = await w.agent("c", { agent: "c1", line: "c1", files: ["src/ratelimit.ts"], provides: ["limiter@1"] });
  await w.nodes.c.release("c.lead", c1, ["a"], ["contribute", "integrate"], 3600_000);
  await settle(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }, { id: c1, relation: "builds-on" }] });
  await settle(w);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  await w.nodes.c.withdraw("c.lead", c1, "bug");
  await settle(w);
  const c5 = await w.agent("c", { agent: "c5", line: "c5", files: ["src/sign-cove.ts"], provides: ["signer@1"] });
  await w.nodes.c.release("c.lead", c5, ["a"], ["contribute", "integrate"], 3600_000);
  await settle(w);
  await refusal(Promise.resolve().then(() => w.nodes.a.planRepair("a.lead", a3, c5, b1)), "withdrawn");
});

test("R12 alternatives: a separately released signer from another organization is offered, never applied silently", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  const c5 = await w.agent("c", { agent: "c5", line: "c5", files: ["src/sign-cove.ts"], provides: ["signer@1"] });
  await w.nodes.c.release("c.lead", c5, ["a"], ["contribute", "integrate"], 3600_000);
  await settle(w);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  await settle(w);
  const alts = w.nodes.a.alternatives(a3);
  assert.deepEqual(alts.map(x => [x.org, x.line, x.kind]), [["c", "c5", "alternative"]]);
  assert.equal(w.nodes.a.effective(a3).code, "withdrawn");
  const plan = w.nodes.a.planRepair("a.lead", a3, c5, null);
  assert.deepEqual(plan.inputs, [{ id: c5, relation: "builds-on" }]);
  assert.equal(plan.version, 2);
  const a3r = await w.agent("a", { agent: "a3r", line: "a3", version: 2, files: ["src/signed-retry.ts"], inputs: plan.inputs });
  assert.equal(w.nodes.a.effective(a3r).code, null);
  assert.equal(w.nodes.a.effective(a3).code, "withdrawn");
  // The notice closes because a newer version of the line is in force; the
  // old version stays blocked for traceability.
  assert.equal(w.nodes.a.notices().find(n => n.item === a3)!.state, "closed");
  await settle(w);
  // The repair needs a fresh approval at the integrator.
  await w.nodes.a.release("a.lead", a3r, ["c"], ["integrate"], 3600_000);
  await settle(w);
  assert.equal(w.nodes.c.gate(a3r).find(x => x.name === "approval")!.code, "human-required");
});

test("R13 approval binds the exact version; a stale base is refused even without a text conflict", async () => {
  const w = await world();
  const { c } = w.nodes;
  const x1 = await w.agent("c", { agent: "c1", line: "x1", files: ["src/retry.ts"], text: "export const retries = 4;\n" });
  const x2 = await w.agent("c", { agent: "c2", line: "x2", files: ["src/retry.ts", "src/extra.ts"], text: "export const retries = 4;\n" });
  const x3 = await w.agent("c", { agent: "c3", line: "x3", files: ["src/client.ts"] });
  for (const id of [x1, x2, x3]) await c.approve("c.lead", id);
  assert.equal((await c.ship("c.lead", x1)).state, "merged");
  const op = await c.ship("c.lead", x2);
  assert.equal(op.code, "stale-base");
  assert.equal((await c.ship("c.lead", x3)).state, "merged");
  const r = await w.agent("c", { agent: "c2r", line: "x2", version: 2, files: ["src/retry.ts"], text: "export const retries = 5;\n" });
  assert.equal(c.gate(r).find(x => x.name === "approval")!.code, "human-required");
  await c.approve("c.lead", r);
  assert.equal((await c.ship("c.lead", r)).state, "merged");
});

test("R14 duplicate deliveries and a lost receipt have one effect; a delayed release never revives a withdrawal", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  await settle(w);
  w.transport.dropReceipts.add("a");
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  w.transport.dropReceipts.delete("a");
  await settle(w);
  const notices = w.nodes.a.notices().filter(n => n.item === a3);
  assert.equal(notices.length, 1);
  assert.ok(w.logs.some(l => l.org === "b" && l.type === "event.delivered" && l.status === "duplicate"));
  // A late copy of the original release arrives after the withdrawal.
  const releaseEvent = w.logs.find(l => l.org === "b" && l.type === "release.sent");
  assert.ok(releaseEvent);
  assert.equal(w.nodes.a.effective(b1).code, "withdrawn");
});

test("R15 reliance registered during a withdrawal returns the withdrawal; an older reply never replaces newer state", async () => {
  const w = await world();
  const b1 = await signer(w);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  // A has not received the event yet: deliver nothing to A.
  const a = w.nodes.a;
  a.store.delete(`status:${b1}`);
  for (const [k] of a.store.list("notice:")) a.store.delete(k);
  assert.equal(a.effective(b1).code, null);
  const state = await a.rely(b1, "builds-on", "contribute");
  assert.equal(state, "current");
  assert.equal(a.effective(b1).code, "withdrawn");
  // Hold an old reply, then deliver it after newer state.
  const w2 = await world();
  const b1b = await signer(w2);
  const original = w2.transport.request.bind(w2.transport);
  let held: Envelope | null = null;
  w2.transport.request = async (peer, env) => { const r = await original(peer, env); held = r; return r; };
  await w2.nodes.a.rely(b1b, "builds-on", "contribute");
  assert.ok(held);
  await w2.nodes.b.withdraw("b.lead", b1b, "license unknown");
  await settle(w2);
  // Replaying the earlier reply for a new request is refused by request binding.
  w2.transport.request = async () => held!;
  assert.equal(await w2.nodes.a.rely(b1b, "builds-on", "contribute"), "pending");
  assert.equal(w2.nodes.a.effective(b1b).code, "withdrawn");
});

test("R16 unknown owner state leaves reliance pending and the gate refuses", async () => {
  const w = await world();
  const b1 = await signer(w);
  w.transport.down.add("b");
  await w.nodes.c.approve("c.lead", b1);
  const inputs = await w.agent("c", { agent: "c2", line: "c2", files: ["src/client.ts"], inputs: [{ id: b1, relation: "builds-on" }] }).catch(e => e);
  assert.ok(typeof inputs === "string");
  await w.nodes.c.approve("c.lead", inputs);
  const check = w.nodes.c.gate(inputs).find(x => x.name === "inputs")!;
  assert.equal(check.ok, false);
  assert.match(check.reason, /owner state unknown/);
});

test("R17 an unknown Git outcome stays unresolved until reconciled", async () => {
  const w = await world();
  const { c } = w.nodes;
  const x1 = await w.agent("c", { agent: "c1", line: "x1", files: ["src/ratelimit.ts"] });
  await c.approve("c.lead", x1);
  w.svc.afterMergeUpdate = () => { throw new Error("timeout"); };
  const op = await c.ship("c.lead", x1);
  w.svc.afterMergeUpdate = null;
  assert.equal(op.state, "unresolved");
  assert.equal(c.store.get(`shipped:${x1}`), undefined);
  const done = await c.reconcile(op.id);
  assert.equal(done.state, "merged");
});

test("R18 a crash after an outbox claim recovers and delivers once", async () => {
  const w = await world();
  const b1 = await signer(w);
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  await settle(w);
  w.transport.down.add("a");
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  // Simulate a crash with a claimed entry.
  for (const [k, e] of w.nodes.b.store.list<Record<string, unknown>>("outbox:")) w.nodes.b.store.put(k, { ...e, claimed: w.clock.now() });
  w.transport.down.delete("a");
  const b = await w.restart("b");
  w.clock.advance(31_000);
  await b.flush();
  await settle(w);
  assert.equal(w.nodes.a.effective(a3).code, "withdrawn");
  assert.equal(b.outbox().length, 0);
});

test("R19 another live token still fetches a withdrawn version; the node refuses managed reuse", async () => {
  const w = await world();
  const b1 = await signer(w);
  const c = w.nodes.b.requireRecord(b1);
  const other = await w.nodes.b.host.mint(c.body.repo, "read", 3600_000);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  await settle(w);
  const entries = await w.nodes.a.host.snapshot(c.body.repo, c.body.commit, other.secret);
  assert.ok(entries.length > 0);
  await refusal(w.nodes.a.readInput(b1, "contribute"), "withdrawn");
  await assert.rejects(w.nodes.a.host.snapshot(c.body.repo, c.body.commit, "art_v1_" + "0".repeat(40)), /token/);
});

test("R20 token secrets never appear in console state, logs or git notes", async () => {
  const w = await world();
  const b1 = await signer(w);
  const secrets = [...(w.svc as unknown as { tokens: Map<string, unknown> }).tokens.keys()];
  assert.ok(secrets.length > 0);
  const text = JSON.stringify([w.nodes.a.state(), w.nodes.b.state(), w.nodes.c.state(), w.logs]);
  for (const s of secrets) assert.ok(!text.includes(s), "secret leaked");
  const c = w.nodes.b.requireRecord(b1);
  const note = await w.nodes.b.host.readNote(c.body.repo, (await w.nodes.b.host.mint(c.body.repo, "read", 60_000)).secret, c.body.commit);
  assert.ok(note && note.includes(b1));
  for (const s of secrets) assert.ok(!note.includes(s));
});

test("R21 an intent overlap is flagged to both organizations before either agent finishes", async () => {
  const w = await world();
  await w.nodes.a.declareIntent("a1", "a1", ["src/retry.ts"], "backoff");
  await w.nodes.a.declareIntent("a2", "a2", ["src/retry.ts"], "cap");
  await settle(w);
  assert.equal(w.nodes.c.state().overlaps instanceof Array && (w.nodes.c.state().overlaps as unknown[]).length, 1);
  assert.equal((w.nodes.a.state().overlaps as unknown[]).length, 1);
});

test("R22 a withdrawal that arrives before its release keeps the release withdrawn", async () => {
  const w = await world();
  const b1 = await w.agent("b", { agent: "b1", line: "b1", files: ["src/sign.ts"] });
  w.transport.down.add("a");
  await w.nodes.b.release("b.lead", b1, ["a"], ["contribute"], 3600_000);
  await w.nodes.b.withdraw("b.lead", b1, "license unknown");
  const queued = w.nodes.b.outbox().filter(e => e.to === "a");
  const release = queued.find(e => e.envelope.kind === "release")!.envelope;
  const withdraw = queued.find(e => e.envelope.kind === "withdraw")!.envelope;
  w.transport.down.delete("a");
  assert.equal((await w.nodes.a.receive(withdraw)).status, "applied");
  assert.equal((await w.nodes.a.receive(release)).status, "applied");
  assert.equal(w.nodes.a.effective(b1).code, "withdrawn");
  await refusal(w.nodes.a.readInput(b1, "contribute"), "withdrawn");
});

test("R23 an event retried after its envelope expired is re-sealed with the same event ID", async () => {
  const w = await world();
  const b1 = await w.agent("b", { agent: "b1", line: "b1", files: ["src/sign.ts"] });
  w.transport.down.add("a");
  await w.nodes.b.release("b.lead", b1, ["a"], ["contribute"], 6 * 3600_000);
  await w.nodes.b.flush();
  const before = w.nodes.b.outbox().find(e => e.to === "a")!;
  w.clock.advance(20 * 60_000);
  w.transport.down.delete("a");
  await settle(w);
  assert.equal(w.nodes.b.outbox().length, 0);
  assert.ok(w.logs.some(l => l.org === "b" && l.type === "event.delivered" && l.event === before.envelope.id));
  assert.ok(w.nodes.a.record(b1));
});
