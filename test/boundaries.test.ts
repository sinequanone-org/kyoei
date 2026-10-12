import { test } from "node:test";
import assert from "node:assert/strict";
import { contentRoot, pathBytes, type Entry } from "../src/core/content.ts";
import { seal } from "../src/core/envelope.ts";
import { settle, world } from "./world.ts";

const bytes = new TextEncoder();

test("R34 content identity binds symlink targets and refuses submodules and unsafe paths", () => {
  const link: Entry = { path: "link", mode: "120000", bytes: bytes.encode("../outside") };
  assert.notEqual(contentRoot([link]).root, contentRoot([{ ...link, bytes: bytes.encode("inside") }]).root);
  assert.notEqual(contentRoot([link]).root, contentRoot([{ ...link, mode: "100644" }]).root);
  assert.throws(() => contentRoot([{ ...link, mode: "160000" } as unknown as Entry]), /invalid-snapshot/);
  for (const path of ["../file", "/absolute", "a/./b", "a//b", ".git/config", "A/.Git/config", "a\\b", "a\0b", "a:b", "e\u0301"]) assert.throws(() => pathBytes(path), /invalid-snapshot/);
  assert.throws(() => contentRoot([link, link]), /invalid-snapshot/);
  assert.throws(() => contentRoot([link, { ...link, path: "link/child" }]), /invalid-snapshot/);
});

test("R35 concurrent reliance registers both recipients without losing newer state", async () => {
  const w = await world();
  const id = await w.agent("b", { agent: "b1", line: "source", files: ["src/sign.ts"] });
  await w.nodes.b.release("b.lead", id, ["a", "c"], ["contribute", "integrate"], 60_000);
  await settle(w);
  assert.deepEqual(await Promise.all([w.nodes.a.rely(id, "builds-on", "contribute"), w.nodes.c.rely(id, "builds-on", "integrate")]), ["current", "current"]);
  assert.deepEqual(w.stores.b.get(`subs:${id}`), ["a", "c"]);
  const request = w.transport.request.bind(w.transport);
  let held: Awaited<ReturnType<typeof request>>;
  let arrived!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  w.transport.request = async (peer, envelope) => {
    held = await request(peer, envelope);
    arrived();
    await released;
    return held;
  };
  const pending = w.nodes.a.rely(id, "builds-on", "contribute");
  await waiting;
  await w.nodes.b.withdraw("b.lead", id, "terms changed");
  await settle(w);
  const revision = w.nodes.a.status(id).rev;
  resume();
  await pending;
  assert.equal(w.nodes.a.status(id).rev, revision);
  assert.equal(w.nodes.a.effective(id).code, "withdrawn");
});

test("R36 two envelopes for the same cause create one notice and one forwarding event", async () => {
  const w = await world();
  const id = await w.agent("b", { agent: "b1", line: "source", files: ["src/sign.ts"] });
  await w.nodes.b.release("b.lead", id, ["a"], ["contribute"], 60_000, [{ org: "c", purposes: ["integrate"] }]);
  await settle(w);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id, relation: "builds-on" }] });
  await w.nodes.a.release("a.lead", dependent, ["c"], ["integrate"], 50_000);
  await settle(w);
  const key = (w.nodes.b as unknown as { key: Parameters<typeof seal>[0] }).key;
  for (const event of ["ab", "cd"]) {
    await w.nodes.a.receive(await seal(key, { deployment: "test", collaboration: "shared-sdk", id: event.repeat(16), kind: "withdraw", issuer: "b", audience: "a", payload: { target: id, cause: "same-cause", reason: "terms changed", rev: 1 }, now: w.clock.now(), ttlMs: 60_000 }));
    await settle(w);
  }
  assert.equal(w.nodes.a.notices().filter(n => n.item === dependent).length, 1);
  assert.equal(w.logs.filter(l => l.org === "a" && l.type === "event.delivered" && l.kind === "blocked" && l.to === "c").length, 1);
});
