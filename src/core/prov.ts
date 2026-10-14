// Export and import of held contributions as W3C PROV.
// Relation types use the Citation Typing Ontology. Permissions do not travel.

import { sha256 } from "./canonical.ts";
import { RELATIONS, type Relation } from "./types.ts";

export const PREFIXES = {
  cito: "http://purl.org/spar/cito/",
  dcterms: "http://purl.org/dc/terms/",
  kyoei: "https://kyoei.lemma.ventures/prov/",
  pav: "http://purl.org/pav/",
  prov: "http://www.w3.org/ns/prov#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
} as const;

const RELATION = {
  "builds-on": { record: "wasDerivedFrom", cito: "cito:extends", revision: false },
  challenges: { record: "wasInfluencedBy", cito: "cito:disputes", revision: false },
  cites: { record: "wasInfluencedBy", cito: "cito:cites", revision: false },
  reproduces: { record: "wasInfluencedBy", cito: "cito:confirms", revision: false },
  supersedes: { record: "wasDerivedFrom", cito: "cito:corrects", revision: true },
} as const satisfies Record<Relation, { record: "wasDerivedFrom" | "wasInfluencedBy"; cito: string; revision: boolean }>;

const BY_CITO = new Map<string, Relation>(Object.entries(RELATION).map(([name, spec]) => [spec.cito, name as Relation]));

const AUTHORITY = new Set([
  "cito:citesAsAuthority", "prov:actedOnBehalfOf", "prov:hadDelegate",
  "kyoei:grants", "kyoei:recipients", "kyoei:purpose", "kyoei:expires",
]);

const KNOWN_GROUPS = new Set([
  "prefix", "entity", "agent", "activity", "wasGeneratedBy", "wasAttributedTo",
  "wasAssociatedWith", "wasInvalidatedBy", "specializationOf", "wasDerivedFrom", "wasInfluencedBy",
]);

export interface ProvArtifact {
  id: string;
  line: string;
  version: number;
  actor: string;
  actorKind: "person" | "agent" | "unknown";
  org: string;
  created: number;
  withdrawnAt: number | null;
  inputs: { id: string; relation: Relation }[];
}

export interface ProvRecovery {
  artifacts: {
    id: string;
    version: number;
    actor: string | null;
    actorKind: string | null;
    org: string | null;
    created: number | null;
    withdrawnAt: number | null;
  }[];
  relations: { subject: string; relation: Relation; object: string }[];
  authority: { predicate: string; verified: false; status: "inert" }[];
  unmapped: { subject: string | null; predicate: string; disposition: string }[];
}

type QName = { $: string; type: "prov:QUALIFIED_NAME" };
type Bag = Record<string, Record<string, unknown>>;

function qn(value: string): QName {
  return { $: value, type: "prov:QUALIFIED_NAME" };
}

function fail(): never {
  throw new Error("invalid-provenance");
}

function moment(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) fail();
  return new Date(ms).toISOString();
}

function parseTime(value: unknown): number | null {
  const text = literal(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isSafeInteger(ms) ? ms : null;
}

function literal(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.$ === "string") return record.$;
  if (typeof record["@value"] === "string") return record["@value"];
  if (typeof record["@id"] === "string") return record["@id"];
  return null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function terms(value: unknown): string[] {
  const out: string[] = [];
  for (const item of asList(value)) {
    const text = literal(item);
    if (text) out.push(contract(text));
  }
  return out;
}

function contract(value: string): string {
  const bases = Object.entries(PREFIXES).sort((a, b) => b[1].length - a[1].length);
  for (const [prefix, base] of bases) if (value.startsWith(base)) return `${prefix}:${value.slice(base.length)}`;
  return value;
}

function checked(artifacts: readonly ProvArtifact[]): ProvArtifact[] {
  if (artifacts.length > 4096) fail();
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (!/^[0-9a-f]{64}$/.test(artifact.id) || seen.has(artifact.id)) fail();
    seen.add(artifact.id);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(artifact.line)) fail();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(artifact.actor)) fail();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(artifact.org)) fail();
    if (!Number.isSafeInteger(artifact.version) || artifact.version < 1) fail();
    if (!Number.isSafeInteger(artifact.created) || artifact.created < 0) fail();
    if (!(artifact.withdrawnAt === null || (Number.isSafeInteger(artifact.withdrawnAt) && artifact.withdrawnAt >= 0))) fail();
    if (artifact.actorKind !== "person" && artifact.actorKind !== "agent" && artifact.actorKind !== "unknown") fail();
    if (!Array.isArray(artifact.inputs) || artifact.inputs.length > 64) fail();
    const pairs = new Set<string>();
    for (const input of artifact.inputs) {
      if (!/^[0-9a-f]{64}$/.test(input.id) || !(RELATIONS as readonly string[]).includes(input.relation)) fail();
      const pair = `${input.relation}\0${input.id}`;
      if (pairs.has(pair)) fail();
      pairs.add(pair);
    }
  }
  return [...artifacts].sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function localName(prefix: string, value: string): Promise<string> {
  const tail = /^[A-Za-z0-9_-]{1,72}$/.test(value) ? value : (await sha256(value)).slice(0, 32);
  return `kyoei:${prefix}-${tail}`;
}

async function index(artifacts: readonly ProvArtifact[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const put = async (prefix: string, value: string) => {
    const key = `${prefix}\0${value}`;
    if (!map.has(key)) map.set(key, await localName(prefix, value));
  };
  for (const artifact of artifacts) {
    await put("contribution", artifact.id);
    await put("lineage", artifact.line);
    await put("publish", artifact.id);
    await put("agent", artifact.actor);
    await put("org", artifact.org);
    if (artifact.withdrawnAt !== null) await put("withdraw", artifact.id);
    for (const input of artifact.inputs) await put("contribution", input.id);
  }
  return map;
}

function ref(map: Map<string, string>, prefix: string, value: string): string {
  const name = map.get(`${prefix}\0${value}`);
  if (!name) fail();
  return name;
}

function agentType(kind: ProvArtifact["actorKind"]): string {
  if (kind === "person") return "prov:Person";
  if (kind === "agent") return "prov:SoftwareAgent";
  return "prov:Agent";
}

function specificKind(types: string[]): string | null {
  for (const name of ["prov:Person", "prov:SoftwareAgent", "prov:Organization", "prov:Agent"]) {
    if (types.includes(name)) return name;
  }
  return null;
}

function links(artifact: ProvArtifact): { id: string; relation: Relation }[] {
  return [...artifact.inputs].sort((a, b) => (a.relation === b.relation ? (a.id < b.id ? -1 : 1) : a.relation < b.relation ? -1 : 1));
}

export async function exportProv(raw: readonly ProvArtifact[]): Promise<Record<string, unknown>> {
  const artifacts = checked(raw);
  const names = await index(artifacts);
  const entity: Bag = {};
  const agent: Bag = {};
  const activity: Bag = {};
  const generated: Bag = {};
  const attributed: Bag = {};
  const associated: Bag = {};
  const invalidated: Bag = {};
  const specialized: Bag = {};
  const derived: Bag = {};
  const influenced: Bag = {};
  const seenAgents = new Set<string>();
  const seenOrgs = new Set<string>();
  for (const artifact of artifacts) {
    const node = ref(names, "contribution", artifact.id);
    const act = ref(names, "publish", artifact.id);
    const who = ref(names, "agent", artifact.actor);
    const org = ref(names, "org", artifact.org);
    entity[node] = {
      "prov:type": qn("prov:Entity"),
      "dcterms:identifier": artifact.id,
      "dcterms:creator": artifact.actor,
      "dcterms:publisher": artifact.org,
      "pav:version": String(artifact.version),
    };
    const lineage = ref(names, "lineage", artifact.line);
    entity[lineage] ??= { "prov:type": qn("prov:Entity"), "dcterms:identifier": artifact.line };
    const kind = agentType(artifact.actorKind);
    if (!seenAgents.has(artifact.actor)) {
      seenAgents.add(artifact.actor);
      agent[who] = { "prov:type": qn(kind), "dcterms:identifier": artifact.actor };
    } else if (literal(agent[who]?.["prov:type"]) !== kind) fail();
    if (!seenOrgs.has(artifact.org)) {
      seenOrgs.add(artifact.org);
      agent[org] = { "prov:type": qn("prov:Organization"), "dcterms:identifier": artifact.org };
    }
    activity[act] = { "prov:type": qn("prov:Activity") };
    generated[`_:gen-${Object.keys(generated).length}`] = { "prov:entity": node, "prov:activity": act, "prov:time": moment(artifact.created) };
    specialized[`_:spec-${Object.keys(specialized).length}`] = { "prov:specificEntity": node, "prov:generalEntity": lineage };
    attributed[`_:att-${Object.keys(attributed).length}`] = { "prov:entity": node, "prov:agent": who };
    associated[`_:asc-${Object.keys(associated).length}`] = { "prov:activity": act, "prov:agent": who };
    if (artifact.withdrawnAt !== null) {
      const stop = ref(names, "withdraw", artifact.id);
      activity[stop] = { "prov:type": qn("prov:Activity") };
      invalidated[`_:inv-${Object.keys(invalidated).length}`] = {
        "prov:entity": node, "prov:activity": stop, "prov:time": moment(artifact.withdrawnAt),
      };
    }
    for (const input of links(artifact)) {
      if (!entity[ref(names, "contribution", input.id)]) {
        entity[ref(names, "contribution", input.id)] = { "prov:type": qn("prov:Entity"), "dcterms:identifier": input.id };
      }
      const spec = RELATION[input.relation];
      const types = [qn(spec.cito), ...(spec.revision ? [qn("prov:Revision")] : [])];
      const attributes = { "prov:type": types.length > 1 ? types : types[0] };
      const subject = node;
      const target = ref(names, "contribution", input.id);
      if (spec.record === "wasDerivedFrom") {
        derived[`_:der-${Object.keys(derived).length}`] = { ...attributes, "prov:generatedEntity": subject, "prov:usedEntity": target };
      } else {
        influenced[`_:inf-${Object.keys(influenced).length}`] = { ...attributes, "prov:influencee": subject, "prov:influencer": target };
      }
    }
  }
  const document: Record<string, unknown> = {
    prefix: { ...PREFIXES }, entity, agent, activity, wasGeneratedBy: generated,
    wasAttributedTo: attributed, wasAssociatedWith: associated, wasInvalidatedBy: invalidated,
    specializationOf: specialized, wasDerivedFrom: derived, wasInfluencedBy: influenced,
  };
  return Object.fromEntries(Object.entries(document).filter(([, value]) => value && (typeof value !== "object" || Object.keys(value as object).length)));
}

export async function exportJsonLd(raw: readonly ProvArtifact[]): Promise<Record<string, unknown>> {
  const artifacts = checked(raw);
  const names = await index(artifacts);
  const nodes = new Map<string, Record<string, unknown>>();
  const graph: Record<string, unknown>[] = [];
  for (const artifact of artifacts) {
    const node = ref(names, "contribution", artifact.id);
    const record: Record<string, unknown> = {
      "@id": node,
      "@type": ["prov:Entity"],
      "dcterms:identifier": artifact.id,
      "dcterms:creator": artifact.actor,
      "dcterms:publisher": artifact.org,
      "pav:version": String(artifact.version),
      "prov:wasAttributedTo": { "@id": ref(names, "agent", artifact.actor) },
      "prov:specializationOf": { "@id": ref(names, "lineage", artifact.line) },
      "prov:wasGeneratedBy": { "@id": ref(names, "publish", artifact.id) },
    };
    if (artifact.withdrawnAt !== null) record["prov:wasInvalidatedBy"] = { "@id": ref(names, "withdraw", artifact.id) };
    nodes.set(node, record);
  }
  for (const artifact of artifacts) {
    for (const input of links(artifact)) {
      const spec = RELATION[input.relation];
      const holder = nodes.get(ref(names, "contribution", artifact.id));
      if (!holder) fail();
      const target = { "@id": ref(names, "contribution", input.id) };
      if (spec.record === "wasDerivedFrom") {
        const key = spec.revision ? "prov:qualifiedRevision" : "prov:qualifiedDerivation";
        const base = spec.revision ? "prov:Revision" : "prov:Derivation";
        const plain = spec.revision ? "prov:wasRevisionOf" : "prov:wasDerivedFrom";
        push(holder, key, { "@type": [base, spec.cito], "prov:entity": target });
        push(holder, plain, target);
      } else {
        push(holder, "prov:qualifiedInfluence", { "@type": ["prov:Influence", spec.cito], "prov:influencer": target });
        push(holder, "prov:wasInfluencedBy", target);
      }
    }
  }
  graph.push(...[...nodes.values()].sort((a, b) => String(a["@id"]) < String(b["@id"]) ? -1 : 1));
  const seenAgents = new Map<string, string>();
  const seenOrgs = new Set<string>();
  for (const artifact of artifacts) {
    const kind = agentType(artifact.actorKind);
    const prior = seenAgents.get(artifact.actor);
    if (prior === undefined) {
      seenAgents.set(artifact.actor, kind);
      graph.push({
        "@id": ref(names, "agent", artifact.actor),
        "@type": ["prov:Agent", kind],
        "dcterms:identifier": artifact.actor,
      });
    } else if (prior !== kind) fail();
    if (!seenOrgs.has(artifact.org)) {
      seenOrgs.add(artifact.org);
      graph.push({
        "@id": ref(names, "org", artifact.org),
        "@type": ["prov:Agent", "prov:Organization"],
        "dcterms:identifier": artifact.org,
      });
    }
    graph.push({
      "@id": ref(names, "publish", artifact.id),
      "@type": ["prov:Activity"],
      "prov:endedAtTime": { "@type": "xsd:dateTime", "@value": moment(artifact.created) },
    });
    if (artifact.withdrawnAt !== null) {
      graph.push({
        "@id": ref(names, "withdraw", artifact.id),
        "@type": ["prov:Activity"],
        "prov:endedAtTime": { "@type": "xsd:dateTime", "@value": moment(artifact.withdrawnAt) },
      });
    }
  }
  return { "@context": { ...PREFIXES }, "@graph": graph };
}

function push(holder: Record<string, unknown>, key: string, value: unknown): void {
  const list = holder[key];
  if (Array.isArray(list)) list.push(value);
  else holder[key] = [value];
}

function noteAuthority(record: Record<string, unknown>, authority: ProvRecovery["authority"]): void {
  for (const name of Object.keys(record)) if (AUTHORITY.has(contract(name))) authority.push({ predicate: contract(name), verified: false, status: "inert" });
  for (const value of terms(record["prov:type"] ?? record["@type"])) {
    if (AUTHORITY.has(value)) authority.push({ predicate: value, verified: false, status: "inert" });
  }
}

function collectAuthority(value: unknown): ProvRecovery["authority"] {
  const found: ProvRecovery["authority"] = [];
  const seen = new WeakSet<object>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const record = item as Record<string, unknown>;
    noteAuthority(record, found);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...new Map(found.map(entry => [entry.predicate, entry])).values()];
}

function identifier(entities: Bag, reference: unknown): string | null {
  const name = literal(reference);
  if (!name) return null;
  const record = entities[name] ?? entities[contract(name)];
  return record ? literal(record["dcterms:identifier"]) ?? contract(name) : contract(name);
}

function relationOf(record: Record<string, unknown>): Relation | null {
  const found = terms(record["prov:type"] ?? record["@type"]).filter((t): t is Relation => BY_CITO.has(t)).map(t => BY_CITO.get(t)!);
  if (found.length > 1) fail();
  return found[0] ?? null;
}

export function importProv(document: unknown): ProvRecovery {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail();
  const doc = document as Record<string, unknown>;
  if (Array.isArray(doc["@graph"])) return importJsonLd(doc);
  const entities = (doc.entity ?? {}) as Bag;
  const agents = (doc.agent ?? {}) as Bag;
  const authority = collectAuthority(doc);
  const unmapped: ProvRecovery["unmapped"] = [];
  const artifacts = new Map<string, ProvRecovery["artifacts"][number]>();
  const agentKind = new Map<string, string>();
  for (const record of Object.values(agents)) {
    if (!record || typeof record !== "object") continue;
    const body = record as Record<string, unknown>;
    const name = literal(body["dcterms:identifier"]);
    const kind = specificKind(terms(body["prov:type"]));
    if (name && kind && kind !== "prov:Organization") agentKind.set(name, kind);
  }
  for (const record of Object.values(entities)) {
    if (!record || typeof record !== "object") continue;
    const body = record as Record<string, unknown>;
    const version = literal(body["pav:version"]);
    if (version === null) continue;
    const id = literal(body["dcterms:identifier"]);
    if (!id || !/^[0-9a-f]{64}$/.test(id) || !/^[0-9]+$/.test(version)) continue;
    const actor = literal(body["dcterms:creator"]);
    artifacts.set(id, {
      id, version: Number(version), actor, actorKind: actor ? agentKind.get(actor) ?? null : null,
      org: literal(body["dcterms:publisher"]), created: null, withdrawnAt: null,
    });
    for (const name of Object.keys(body)) {
      if (!["prov:type", "dcterms:identifier", "dcterms:creator", "dcterms:publisher", "pav:version"].includes(contract(name))) {
        unmapped.push({ subject: id, predicate: contract(name), disposition: "reported_not_applied" });
      }
    }
  }
  for (const [group, record] of Object.entries((doc.wasGeneratedBy ?? {}) as Bag)) {
    void group;
    const entity = identifier(entities, record["prov:entity"]);
    const artifact = entity ? artifacts.get(entity) : undefined;
    if (artifact) artifact.created = parseTime(record["prov:time"]);
  }
  for (const record of Object.values((doc.wasInvalidatedBy ?? {}) as Bag)) {
    const entity = identifier(entities, record["prov:entity"]);
    const artifact = entity ? artifacts.get(entity) : undefined;
    if (artifact) artifact.withdrawnAt = parseTime(record["prov:time"]);
  }
  const relations: ProvRecovery["relations"] = [];
  for (const [group, subjectKey, objectKey] of [
    ["wasDerivedFrom", "prov:generatedEntity", "prov:usedEntity"],
    ["wasInfluencedBy", "prov:influencee", "prov:influencer"],
  ] as const) {
    for (const record of Object.values((doc[group] ?? {}) as Bag)) {
      const relation = relationOf(record);
      const subject = identifier(entities, record[subjectKey]);
      const object = identifier(entities, record[objectKey]);
      if (!relation || !subject || !object) {
        unmapped.push({ subject, predicate: group, disposition: relation ? "incomplete_relation_reported" : "untyped_relation_reported" });
        continue;
      }
      relations.push({ subject, relation, object });
    }
  }
  for (const group of Object.keys(doc)) {
    if (!KNOWN_GROUPS.has(group)) unmapped.push({ subject: null, predicate: group, disposition: "unknown_record_type_reported" });
  }
  relations.sort((a, b) => (a.subject === b.subject ? (a.relation === b.relation ? (a.object < b.object ? -1 : 1) : a.relation < b.relation ? -1 : 1) : a.subject < b.subject ? -1 : 1));
  return {
    artifacts: [...artifacts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    relations, authority, unmapped,
  };
}

function importJsonLd(doc: Record<string, unknown>): ProvRecovery {
  const graph = doc["@graph"] as Record<string, unknown>[];
  const byId = new Map<string, Record<string, unknown>>();
  for (const node of graph) if (node && typeof node["@id"] === "string") byId.set(node["@id"], node);
  const authority = collectAuthority(doc);
  const unmapped: ProvRecovery["unmapped"] = [];
  const artifacts: ProvRecovery["artifacts"] = [];
  const relations: ProvRecovery["relations"] = [];
  const kindOf = new Map<string, string>();
  for (const node of graph) {
    const name = literal(node["dcterms:identifier"]);
    const kind = specificKind(terms(node["@type"]));
    if (name && kind && kind !== "prov:Organization") kindOf.set(name, kind);
  }
  for (const node of graph) {
    const version = literal(node["pav:version"]);
    const id = literal(node["dcterms:identifier"]);
    if (version === null || !id || !/^[0-9a-f]{64}$/.test(id)) continue;
    const actor = literal(node["dcterms:creator"]);
    const generated = byId.get(literal(node["prov:wasGeneratedBy"]) ?? "");
    const invalidated = byId.get(literal(node["prov:wasInvalidatedBy"]) ?? "");
    artifacts.push({
      id, version: Number(version), actor, actorKind: actor ? kindOf.get(actor) ?? null : null,
      org: literal(node["dcterms:publisher"]),
      created: generated ? parseTime(generated["prov:endedAtTime"]) : null,
      withdrawnAt: invalidated ? parseTime(invalidated["prov:endedAtTime"]) : null,
    });
    for (const [key, subjectKey] of [
      ["prov:qualifiedDerivation", "prov:entity"],
      ["prov:qualifiedRevision", "prov:entity"],
      ["prov:qualifiedInfluence", "prov:influencer"],
    ] as const) {
      for (const item of asList(node[key])) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const relation = relationOf(record);
        const object = identifierFromNode(record[subjectKey]);
        if (!relation || !object) {
          unmapped.push({ subject: id, predicate: key, disposition: "untyped_relation_reported" });
          continue;
        }
        relations.push({ subject: id, relation, object });
      }
    }
  }
  relations.sort((a, b) => (a.subject === b.subject ? (a.relation === b.relation ? (a.object < b.object ? -1 : 1) : a.relation < b.relation ? -1 : 1) : a.subject < b.subject ? -1 : 1));
  return { artifacts: artifacts.sort((a, b) => (a.id < b.id ? -1 : 1)), relations, authority, unmapped };
}

function identifierFromNode(value: unknown): string | null {
  const name = literal(value);
  if (!name) return null;
  const hex = /([0-9a-f]{64})$/.exec(name);
  return hex ? hex[1]! : null;
}
