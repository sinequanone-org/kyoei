// Shared vocabulary. The words here are fixed by the specification:
// do not add synonyms.

import type { Content } from "./content.ts";

export const RELATIONS = ["builds-on", "cites", "challenges", "reproduces", "supersedes"] as const;
export type Relation = (typeof RELATIONS)[number];

export const REFUSALS = [
  "withdrawn",
  "replacement-required",
  "new-grant-required",
  "lease-expired",
  "human-required",
  "stale-base",
  "not-authorized",
] as const;
export type RefusalCode = (typeof REFUSALS)[number];

export const REPAIRS = ["rebase", "withdraw", "dissent"] as const;
export type Repair = (typeof REPAIRS)[number];

export const EVENT_KINDS = [
  "release", "rely", "intent", "overlap", "withdraw", "correct",
  "blocked", "affected", "challenge", "dissent", "signoff",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export class Refusal extends Error {
  readonly code: RefusalCode | "invalid-request" | "conflict" | "unknown";
  readonly detail: string;
  constructor(code: Refusal["code"], detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export function refuse(code: Refusal["code"], detail = ""): never {
  throw new Refusal(code, detail);
}

export interface Input {
  id: string;          // record digest of the target contribution
  relation: Relation;
}

// The signed contribution body. `id` is the digest of this body.
export interface ContributionBody {
  v: 1;
  deployment: string;
  collaboration: string;
  org: string;
  actor: string;
  repo: string;
  commit: string;
  base: string;            // parent commit on the integration line
  content: Content;
  task: string;
  rationale: string;
  files: string[];
  inputs: Input[];
  provides: string[];      // interface names, for example "signer@1"
  model: string | null;
  prompt: string | null;   // prompt digest, never the prompt
  version: number;         // 1 for a new line of work, n+1 for a repair
  line: string;            // stable name of the line of work, for example "a3"
  created: number;         // unix milliseconds
}

export interface Contribution {
  id: string;
  body: ContributionBody;
  signature: string;       // hex, over "kyoei-contribution-v1\0" + canonical(body)
}

export interface Actor {
  name: string;
  kind: "person" | "agent";
  delegate?: string;       // for an agent: the person who delegated it
}

export interface Peer {
  org: string;
  url: string;
  alg: SignatureAlgorithm;
  publicKey: string;       // base64url SPKI
  fingerprint: string;     // sha256 of the SPKI bytes
}

export type SignatureAlgorithm = "ML-DSA-65" | "Ed25519";

export interface Envelope {
  v: 1;
  protocol: "kyoei/1";
  deployment: string;
  collaboration: string;
  id: string;              // stable event ID, the same across retries
  kind: EventKind;
  issuer: string;
  audience: string;
  payload: Record<string, unknown>;
  iat: number;
  exp: number;
  nonce: string;
  sig: string;             // base64url signature over the other fields
}

export interface Receipt {
  event: string;
  org: string;
  status: "applied" | "duplicate";
  revision?: number;
}

export interface Notice {
  id: string;
  item: string;            // affected contribution or "main"
  evidence: { commit: string; record: string; content: string };
  source: { event: string; kind: EventKind | "withdraw-local"; org: string; target: string; reason: string; evidence?: "withheld" };
  act: string[];           // who can act: people of this organization
  dissent: { org: string; actor: string; text: string }[];
  repairs: Repair[];
  blocking: boolean;
  state: "open" | "closed";
  opened: number;
  closed?: number;
}

export interface Check {
  name: "signature" | "release" | "inputs" | "approval" | "base" | "content" | "reliance";
  ok: boolean;
  code?: RefusalCode;
  reason: string;
}
