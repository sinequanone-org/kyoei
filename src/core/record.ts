// Contribution records. The record ID is the SHA-256 digest of the canonical
// body. The organization key signs the same bytes. The body binds the
// deployment, collaboration, organization, repository, commit and the BLAKE3
// content root of the committed snapshot.

import { canonical, sha256, utf8 } from "./canonical.ts";
import { validateContent, verifyContent, type Entry } from "./content.ts";
import { sign, verify, type KeyPair } from "../crypto/signer.ts";
import { RELATIONS, refuse, type Contribution, type ContributionBody, type Peer } from "./types.ts";

const TAG = "kyoei-contribution-v1\0";
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID = /^[0-9a-f]{64}$/;

export function recordMessage(body: ContributionBody): Uint8Array {
  return utf8(TAG + canonical(body));
}

export async function recordId(body: ContributionBody): Promise<string> {
  return sha256(TAG + canonical(body));
}

export function validateBody(raw: unknown): ContributionBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("invalid-request", "record");
  const b = raw as ContributionBody;
  const keys = "actor,base,collaboration,commit,content,created,deployment,files,inputs,line,model,org,prompt,provides,rationale,repo,task,v,version";
  if (Object.keys(b).sort().join(",") !== keys) refuse("invalid-request", "record fields");
  if (b.v !== 1) refuse("invalid-request", "record version");
  if (typeof b.repo !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/.test(b.repo)) refuse("invalid-request", "record repo");
  for (const k of ["deployment", "collaboration", "org", "actor", "line"] as const) {
    if (typeof b[k] !== "string" || !NAME.test(b[k])) refuse("invalid-request", `record ${k}`);
  }
  if (typeof b.commit !== "string" || !COMMIT.test(b.commit)) refuse("invalid-request", "record commit");
  if (typeof b.base !== "string" || !COMMIT.test(b.base)) refuse("invalid-request", "record base");
  try { validateContent(b.content); } catch { refuse("invalid-request", "record content"); }
  if (typeof b.task !== "string" || b.task.length > 2000) refuse("invalid-request", "record task");
  if (typeof b.rationale !== "string" || b.rationale.length > 4000) refuse("invalid-request", "record rationale");
  if (!Array.isArray(b.files) || b.files.length > 64 || !b.files.every(f => typeof f === "string" && f.length <= 512)) refuse("invalid-request", "record files");
  if (!Array.isArray(b.provides) || b.provides.length > 16 || !b.provides.every(p => typeof p === "string" && /^[a-z0-9-]+@[0-9]+$/.test(p))) refuse("invalid-request", "record provides");
  if (!Array.isArray(b.inputs) || b.inputs.length > 64) refuse("invalid-request", "record inputs");
  for (const input of b.inputs) {
    if (!input || typeof input.id !== "string" || !ID.test(input.id) || !RELATIONS.includes(input.relation) || Object.keys(input).length !== 2) {
      refuse("invalid-request", "record input");
    }
  }
  if (!(b.model === null || (typeof b.model === "string" && b.model.length <= 200))) refuse("invalid-request", "record model");
  if (!(b.prompt === null || (typeof b.prompt === "string" && ID.test(b.prompt)))) refuse("invalid-request", "record prompt");
  if (!Number.isSafeInteger(b.version) || b.version < 1) refuse("invalid-request", "record version number");
  if (!Number.isSafeInteger(b.created) || b.created < 0) refuse("invalid-request", "record time");
  return b;
}

export async function signRecord(key: KeyPair, body: ContributionBody): Promise<Contribution> {
  validateBody(body);
  return { id: await recordId(body), body, signature: await sign(key, recordMessage(body)) };
}

export interface RecordScope {
  deployment: string;
  collaboration: string;
  org: string;
}

// Checks the signature with the pinned key of the owning organization and the
// expected scope. The algorithm comes from the pinned peer.
export async function verifyRecord(raw: unknown, owner: Peer, scope: RecordScope): Promise<Contribution> {
  if (!raw || typeof raw !== "object") refuse("invalid-request", "contribution");
  const c = raw as Contribution;
  if (Object.keys(c).sort().join(",") !== "body,id,signature") refuse("invalid-request", "contribution fields");
  const body = validateBody(c.body);
  if (body.deployment !== scope.deployment || body.collaboration !== scope.collaboration) refuse("not-authorized", "record scope");
  if (body.org !== scope.org || owner.org !== body.org) refuse("not-authorized", "record owner");
  if ((await recordId(body)) !== c.id) refuse("not-authorized", "record id");
  if (typeof c.signature !== "string" || !(await verify(owner.alg, owner.publicKey, c.signature, recordMessage(body)))) {
    refuse("not-authorized", "record signature");
  }
  return c;
}

// The recipient recomputes the BLAKE3 root from the exact commit it fetched.
export function verifySnapshot(c: Contribution, entries: readonly Entry[]): void {
  try { verifyContent(entries, c.body.content); } catch { refuse("not-authorized", "content root mismatch"); }
}
