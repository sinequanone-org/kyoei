import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, world, type World } from "./world.ts";
import { seal } from "../src/core/envelope.ts";
import type { OrgNode } from "../src/node/node.ts";
import git from "isomorphic-git";
import { ArtifactsHost } from "../src/worker/artifacts-host.ts";
import { MemoryStore } from "../src/node/store.ts";
import { MemoryFS } from "../src/worker/memfs.ts";

async function input(w: World, to = ["a", "c"]): Promise<string> {
  const id = await w.agent("b", { agent: "b1", line: "source", files: ["src/sign.ts"] });
  await w.nodes.b.release("b.lead", id, to, ["contribute", "integrate"], 60_000, [{ org: "c", purposes: ["contribute", "integrate"] }]);
  await settle(w);
  return id;
}

async function request(node: OrgNode, target: string, purpose: string) {
  return seal((node as unknown as { key: Parameters<typeof seal>[0] }).key, {
    deployment: "test", collaboration: "shared-sdk", id: crypto.randomUUID().replaceAll("-", ""), kind: "rely", issuer: node.config.org, audience: "b", payload: { target, relation: "builds-on", purpose }, now: node.now(), ttlMs: 60_000,
  });
}

test("R24 an expired transitive input grant blocks an owned candidate", async () => {
  const w = await world();
  const source = await input(w);
  const middle = await w.agent("c", { agent: "c1", line: "middle", files: ["src/middle.ts"], inputs: [{ id: source, relation: "builds-on" }] });
  const candidate = await w.agent("c", { agent: "c2", line: "candidate", files: ["src/final.ts"], inputs: [{ id: middle, relation: "builds-on" }] });
  await w.nodes.c.approve("c.lead", candidate);
  assert.ok(w.nodes.c.gate(candidate).every(c => c.ok));
  w.clock.advance(60_001);
  assert.equal((await w.nodes.c.ship("c.lead", candidate)).code, "lease-expired");
});

test("R25 pending candidate reliance refuses ship until the owner answers", async () => {
  const w = await world();
  const candidate = await input(w);
  w.transport.down.add("b");
  await w.nodes.c.approve("c.lead", candidate);
  assert.equal((await w.nodes.c.ship("c.lead", candidate)).state, "refused");
  w.transport.down.delete("b");
  await w.nodes.c.approve("c.lead", candidate);
  assert.equal((await w.nodes.c.ship("c.lead", candidate)).state, "merged");
});

test("R26 a withdrawal retains delivery work before network revocation", async () => {
  const w = await world();
  const source = await input(w);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id: source, relation: "builds-on" }] });
  await settle(w);
  let snapshot: Record<string, string> | undefined;
  const revoke = w.nodes.b.host.revoke.bind(w.nodes.b.host);
  w.nodes.b.host.revoke = async () => { snapshot ??= w.stores.b.dump(); return false; };
  w.transport.down.add("a");
  w.transport.down.add("c");
  await w.nodes.b.withdraw("b.lead", source, "terms withdrawn");
  w.nodes.b.host.revoke = revoke;
  assert.ok(snapshot);
  w.stores.b.load(snapshot);
  await w.restart("b");
  w.transport.down.clear();
  await settle(w);
  assert.equal(w.nodes.a.effective(dependent).code, "withdrawn");
});

test("R27 an inbox receipt and forwarding survive a crash before signing", async () => {
  const w = await world();
  const source = await input(w, ["a"]);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id: source, relation: "builds-on" }] });
  await w.nodes.a.release("a.lead", dependent, ["c"], ["integrate"], 50_000);
  await settle(w);
  w.stores.c.delete(`c:${source}`);
  const node = w.nodes.a as unknown as { enqueue: (...args: unknown[]) => Promise<void> };
  node.enqueue = async () => { throw new Error("simulated stop before signing"); };
  await w.nodes.b.withdraw("b.lead", source, "terms withdrawn");
  await w.restart("a");
  await settle(w);
  assert.equal(w.nodes.c.effective(dependent).code, "withdrawn");
});

test("R28 reliance requires this recipient's current purpose grant", async () => {
  const w = await world();
  const source = await input(w, ["a"]);
  await assert.rejects(w.nodes.b.answerRely(await request(w.nodes.c, source, "integrate")), /new-grant-required/);
  await assert.rejects(w.nodes.b.answerRely(await request(w.nodes.a, source, "unreleased-purpose")), /new-grant-required/);
  await w.nodes.b.answerRely(await request(w.nodes.a, source, "contribute"));
  w.clock.advance(60_001);
  await assert.rejects(w.nodes.b.answerRely(await request(w.nodes.a, source, "contribute")), /new-grant-required/);
});

test("R29 dissent does not disclose a private notice to an unrelated peer", async () => {
  const w = await world();
  const source = await input(w, ["a"]);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id: source, relation: "builds-on" }] });
  await w.nodes.b.withdraw("b.lead", source, "private reason");
  await settle(w);
  const notice = w.nodes.a.notices().find(n => n.item === dependent)!;
  await w.nodes.a.dissent("a.lead", notice.source.event, "private evidence");
  await settle(w);
  assert.equal(w.stores.b.list("dissent:").length, 1);
  assert.equal(w.stores.c.list("dissent:").length, 0);
});

test("R30 a failed Artifacts note write cannot advance main", async t => {
  const fs = new MemoryFS();
  await git.init({ fs, dir: "/w", defaultBranch: "main" });
  await fs.promises.writeFile("/w/base.txt", "base");
  await git.add({ fs, dir: "/w", filepath: "base.txt" });
  const author = { name: "Tester", email: "tester@invalid" };
  const head = await git.commit({ fs, dir: "/w", message: "base", author });
  await fs.promises.writeFile("/w/change.txt", "change");
  await git.add({ fs, dir: "/w", filepath: "change.txt" });
  const candidate = await git.commit({ fs, dir: "/w", message: "candidate", author });
  await git.writeRef({ fs, dir: "/w", ref: "refs/heads/main", value: head, force: true });
  const host = new ArtifactsHost("c", {} as never, new MemoryStore());
  t.mock.method(host as unknown as { clone: () => Promise<MemoryFS> }, "clone", async () => fs);
  t.mock.method(host, "remote", () => "https://example.invalid/repo");
  t.mock.method(git, "fetch", async () => ({}));
  const pushed: string[] = [];
  t.mock.method(git, "push", async (opts: { remoteRef: string }) => { pushed.push(opts.remoteRef); return { ok: true }; });
  t.mock.method(host, "note", async () => { throw new Error("note write failed"); });
  await assert.rejects(host.merge("c/main", "dummy", "b/source", "dummy", candidate, head, '{"op":"test"}'), /note write failed/);
  assert.deepEqual(pushed, []);
});


test("R31 a pinned peer needs HTTPS outside loopback", async () => {
  const w = await world();
  const peer = { ...w.nodes.b.identity(), url: "http://peer.example.invalid/" };
  await assert.rejects(w.nodes.a.pin(peer, peer.fingerprint), /HTTPS/);
  await w.nodes.a.pin({ ...peer, url: "http://127.0.0.1:3400/" }, peer.fingerprint);
});

for (const fault of ["expiry", "task", "purpose", "files", "person", "used"] as const) {
  test(`R32 register refuses a delegation outside its ${fault} limit`, async () => {
    const w = await world();
    const source = await input(w);
    const c = w.nodes.b.requireRecord(source);
    const key = `bounded-${fault}`;
    const grant = { key, agent: "b1", actor: "b.lead", task: c.body.task, files: c.body.files, inputs: c.body.inputs, purpose: "contribute", expires: w.clock.now() + 1000, used: undefined as string | undefined };
    if (fault === "expiry") grant.expires = w.clock.now() - 1;
    if (fault === "task") grant.task = "another task";
    if (fault === "purpose") grant.purpose = "integrate";
    if (fault === "files") grant.files = ["another.ts"];
    if (fault === "person") grant.actor = "b2";
    if (fault === "used") grant.used = source;
    w.stores.b.put(`delegation:${key}`, grant);
    const token = await w.nodes.b.host.mint(c.body.repo, "write", 60_000);
    await assert.rejects(w.nodes.b.register({ delegation: key, agent: "b1", repo: c.body.repo, commit: c.body.commit, base: c.body.base, files: c.body.files, task: c.body.task, rationale: c.body.rationale, inputs: c.body.inputs, provides: c.body.provides, model: null, prompt: null, line: c.body.line, version: 2, writeToken: token.secret }), fault === "expiry" ? /lease-expired/ : /not-authorized/);
  });
}

test("R33 a forwarded challenge labels the evidence as withheld in the notice", async () => {
  const w = await world();
  const source = await input(w, ["a"]);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id: source, relation: "builds-on" }] });
  await w.nodes.a.release("a.lead", dependent, ["c"], ["contribute", "integrate"], 50_000);
  await settle(w);
  const local = await w.agent("c", { agent: "c1", line: "local", files: ["src/local.ts"], inputs: [{ id: dependent, relation: "builds-on" }] });
  await w.nodes.b.challenge("b.lead", source, "check the evidence");
  await settle(w);
  const notice = w.nodes.c.notices().find(n => n.item === local)!;
  assert.equal(notice.source.kind, "affected");
  assert.equal(notice.source.evidence, "withheld");
  assert.equal(notice.blocking, false);
});

test("R37 dissent survives a crash before its event is signed", async () => {
  const w = await world();
  const source = await input(w, ["a"]);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id: source, relation: "builds-on" }] });
  await w.nodes.b.withdraw("b.lead", source, "terms changed");
  await settle(w);
  const notice = w.nodes.a.notices().find(n => n.item === dependent)!;
  (w.nodes.a as unknown as { enqueue: () => Promise<void> }).enqueue = async () => { throw new Error("stop before signing"); };
  await assert.rejects(w.nodes.a.dissent("a.lead", notice.source.event, "please review"), /stop before signing/);
  await w.restart("a");
  await settle(w);
  assert.equal(w.stores.b.list("dissent:").length, 1);
});

test("R38 interrupted approval leaves candidate reliance pending", async () => {
  const w = await world();
  const source = await input(w);
  await w.nodes.c.approve("c.lead", source);
  w.nodes.c.rely = async () => { throw new Error("stop before request"); };
  await assert.rejects(w.nodes.c.approve("c.lead", source), /stop before request/);
  await w.restart("c");
  assert.equal((await w.nodes.c.ship("c.lead", source)).state, "refused");
});

test("R39 failed token revocation is retried after a restart", async () => {
  const w = await world();
  const source = await input(w, ["a"]);
  const revoke = w.nodes.b.host.revoke.bind(w.nodes.b.host);
  w.nodes.b.host.revoke = async () => false;
  await w.nodes.b.withdraw("b.lead", source, "terms changed");
  w.nodes.b.host.revoke = revoke;
  await w.restart("b");
  w.clock.advance(30_001);
  await w.nodes.b.flush();
  assert.ok(w.nodes.b.grants(source).every(g => g.revokeResult === "revoked"));
});
