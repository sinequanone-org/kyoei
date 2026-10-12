// G1 flow: a withdrawal at B blocks the dependents at A, B and C. Unrelated
// work ships. Every result below comes from the nodes' own state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, world } from "./world.ts";

test("withdrawal blocks only dependent work at every node", async () => {
  const w = await world();
  const { a, b, c } = w.nodes;
  const b1 = await w.agent("b", { agent: "b1", line: "b1", files: ["src/sign.ts"], provides: ["signer@1"] });
  await b.release("b.lead", b1, ["a", "c"], ["contribute", "integrate"], 6 * 3600_000, [{ org: "c", purposes: ["contribute", "integrate"] }]);
  await settle(w);
  const a1 = await w.agent("a", { agent: "a1", line: "a1", files: ["src/retry.ts"] });
  const a3 = await w.agent("a", { agent: "a3", line: "a3", files: ["src/signed-retry.ts"], inputs: [{ id: b1, relation: "builds-on" }, { id: a1, relation: "builds-on" }] });
  const b2 = await w.agent("b", { agent: "b2", line: "b2", files: ["test/sign.test.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  const b3 = await w.agent("b", { agent: "b3", line: "b3", files: ["docs/signing.md"], inputs: [{ id: b1, relation: "cites" }] });
  await a.release("a.lead", a1, ["c"], ["integrate"], 3600_000);
  await a.release("a.lead", a3, ["c"], ["integrate"], 3600_000);
  await settle(w);
  const c2 = await w.agent("c", { agent: "c2", line: "c2", files: ["src/client.ts"], inputs: [{ id: b1, relation: "builds-on" }] });
  for (const id of [b1, a1, c2]) { await c.approve("c.lead", id); }
  for (const id of [b1, a1, c2]) assert.equal((await c.ship("c.lead", id)).state, "merged", c.label(id));
  await c.approve("c.lead", a3);

  const out = await b.withdraw("b.lead", b1, "origin of one snippet not verified");
  await settle(w);
  assert.equal(out.revoked, 2);
  assert.equal(a.effective(a3).code, "withdrawn");
  assert.equal(a.effective(a1).code, null);
  assert.equal(b.effective(b2).code, "withdrawn");
  assert.equal(b.effective(b3).code, null);
  const b3notice = b.notices().find(n => n.item === b3);
  assert.equal(b3notice?.blocking, false);
  assert.equal(c.effective(c2).code, "withdrawn");
  const main = c.notices().filter(n => n.item.startsWith("main:")).map(n => n.item.slice(5)).sort();
  assert.deepEqual(main, [b1, c2].sort());
  const gate = c.gate(a3).find(x => x.name === "inputs");
  assert.equal(gate?.code, "withdrawn");
  assert.equal((await c.ship("c.lead", a3)).code, "withdrawn");
  // Unrelated work ships during the incident.
  const c4 = await w.agent("c", { agent: "c4", line: "c4", files: ["README.md"] });
  await c.approve("c.lead", c4);
  assert.equal((await c.ship("c.lead", c4)).state, "merged");
});
