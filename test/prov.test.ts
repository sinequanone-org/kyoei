import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJsonLd, exportProv, importProv, type ProvArtifact } from "../src/core/prov.ts";
import { settle, world } from "./world.ts";

const id = (n: number) => n.toString(16).padStart(64, "0");

function artifact(n: number, inputs: ProvArtifact["inputs"] = [], extra: Partial<ProvArtifact> = {}): ProvArtifact {
  return {
    id: id(n), line: `line${n}`, version: 1, actor: n === 1 ? "a.lead" : "a1",
    actorKind: n === 1 ? "person" : "agent", org: "a", created: Date.UTC(2026, 9, 13, 8, 0, 0),
    withdrawnAt: null, inputs, ...extra,
  };
}

test("PROV-JSON and JSON-LD keep the five relation types and ignore imported authority", async () => {
  const rows = [
    artifact(1, [], { withdrawnAt: Date.UTC(2026, 9, 13, 9, 0, 0) }),
    artifact(2, [{ id: id(1), relation: "builds-on" }]),
    artifact(3, [{ id: id(1), relation: "cites" }]),
    artifact(4, [{ id: id(1), relation: "challenges" }]),
    artifact(5, [{ id: id(1), relation: "reproduces" }]),
    artifact(6, [{ id: id(1), relation: "supersedes" }], { version: 2 }),
  ];
  for (const doc of [await exportProv(rows), await exportJsonLd(rows)]) {
    const text = JSON.stringify(doc);
    for (const hidden of ["clinical-review", "kyoei:purpose", "kyoei:recipients", "kyoei:grants", "kyoei:expires"]) {
      assert.equal(text.includes(hidden), false, hidden);
    }
    const back = importProv(doc);
    assert.deepEqual(back.relations.map(r => [r.subject, r.relation, r.object]), [
      [id(2), "builds-on", id(1)],
      [id(3), "cites", id(1)],
      [id(4), "challenges", id(1)],
      [id(5), "reproduces", id(1)],
      [id(6), "supersedes", id(1)],
    ]);
    assert.equal(back.artifacts.find(a => a.id === id(1))?.withdrawnAt, rows[0]!.withdrawnAt);
    assert.equal(back.artifacts.find(a => a.id === id(2))?.withdrawnAt, null);
    assert.equal(back.artifacts.find(a => a.id === id(1))?.actorKind, "prov:Person");
    assert.equal(back.artifacts.find(a => a.id === id(2))?.actorKind, "prov:SoftwareAgent");
    assert.equal(back.artifacts.find(a => a.id === id(6))?.version, 2);
    assert.deepEqual(back.authority, []);
  }
  const hostile = await exportProv(rows) as { entity: Record<string, Record<string, unknown>> };
  const entity = Object.values(hostile.entity)[0]!;
  entity["kyoei:purpose"] = "clinical-review";
  entity["kyoei:recipients"] = "bruno";
  entity["kyoei:grants"] = "reviewer";
  (hostile as { actedOnBehalfOf?: unknown }).actedOnBehalfOf = {
    "_:hostile": {
      "prov:delegate": "kyoei:agent-a",
      "prov:responsible": "kyoei:agent-a",
      "prov:type": { $: "cito:citesAsAuthority", type: "prov:QUALIFIED_NAME" },
    },
  };
  const recovered = importProv(hostile);
  assert.deepEqual(recovered.authority.map(a => a.predicate).sort(), ["cito:citesAsAuthority", "kyoei:grants", "kyoei:purpose", "kyoei:recipients"]);
  assert.equal(recovered.authority.every(a => a.verified === false && a.status === "inert"), true);
  assert.ok(recovered.unmapped.some(u => u.predicate === "kyoei:purpose" && u.disposition === "reported_not_applied"));
  assert.equal(recovered.relations.length, 5);
});

test("a node exports held contributions without grants, tasks or withdrawal reasons", async () => {
  const w = await world();
  const source = await w.agent("b", { agent: "b1", line: "source", files: ["src/sign.ts"], task: "phrase-not-for-prov" });
  const grants = await w.nodes.b.release("b.lead", source, ["a"], ["contribute"], 60_000);
  await settle(w);
  const dependent = await w.agent("a", { agent: "a1", line: "dependent", files: ["src/use.ts"], inputs: [{ id: source, relation: "builds-on" }], task: "also-not-for-prov" });
  await w.nodes.b.withdraw("b.lead", source, "reason-not-for-prov");
  await settle(w);
  for (const org of ["a", "b"] as const) {
    const doc = await w.nodes[org].provenance();
    const text = JSON.stringify(doc);
    for (const hidden of ["phrase-not-for-prov", "also-not-for-prov", "reason-not-for-prov", grants[0]!.tokenId, "contribute"]) {
      assert.equal(text.includes(hidden), false, `${org} ${hidden}`);
    }
  }
  const owner = importProv((await w.nodes.b.provenance()).prov);
  const holder = importProv((await w.nodes.a.provenance()).jsonld);
  assert.equal(owner.artifacts.find(a => a.id === source)?.actorKind, "prov:SoftwareAgent");
  assert.equal(owner.artifacts.find(a => a.id === source)?.withdrawnAt, w.clock.now());
  assert.ok(holder.relations.some(r => r.subject === dependent && r.relation === "builds-on" && r.object === source));
  assert.equal(holder.artifacts.find(a => a.id === source)?.withdrawnAt, w.clock.now());
  assert.equal(holder.artifacts.find(a => a.id === dependent)?.withdrawnAt, null);
  assert.equal(holder.artifacts.find(a => a.id === dependent)?.actorKind, "prov:SoftwareAgent");
  assert.equal(holder.artifacts.find(a => a.id === source)?.actorKind, "prov:Agent");
});
