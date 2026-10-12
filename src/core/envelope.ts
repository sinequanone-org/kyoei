// Signed envelopes between nodes. The signature covers every field except
// `sig`, in canonical JSON, after a domain tag.

import { canonical, randomId, utf8 } from "./canonical.ts";
import { sign, verify, type KeyPair } from "../crypto/signer.ts";
import { EVENT_KINDS, refuse, type Envelope, type EventKind, type Peer } from "./types.ts";

const TAG = "kyoei-envelope-v1\0";
export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const CLOCK_SKEW_MS = 120_000;

function message(e: Omit<Envelope, "sig">): Uint8Array {
  return utf8(TAG + canonical(e));
}

export interface SealInput {
  deployment: string;
  collaboration: string;
  id: string;
  kind: EventKind;
  issuer: string;
  audience: string;
  payload: Record<string, unknown>;
  now: number;
  ttlMs: number;
}

export async function seal(key: KeyPair, input: SealInput): Promise<Envelope> {
  const body: Omit<Envelope, "sig"> = {
    v: 1,
    protocol: "kyoei/1",
    deployment: input.deployment,
    collaboration: input.collaboration,
    id: input.id,
    kind: input.kind,
    issuer: input.issuer,
    audience: input.audience,
    payload: input.payload,
    iat: input.now,
    exp: input.now + input.ttlMs,
    nonce: randomId(12),
  };
  return { ...body, sig: await sign(key, message(body)) };
}

export interface OpenContext {
  self: string;
  deployment: string;
  collaborations: ReadonlySet<string>;
  peers: ReadonlyMap<string, Peer>;
  now: number;
}

// Returns the envelope when every check passes. Refuses otherwise. Authority
// over the named object is checked later, by the handler for the kind.
export async function open(raw: unknown, ctx: OpenContext): Promise<Envelope> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("invalid-request", "envelope");
  const e = raw as Envelope;
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "audience,collaboration,deployment,exp,iat,id,issuer,kind,nonce,payload,protocol,sig,v") refuse("invalid-request", "envelope fields");
  if (e.v !== 1 || e.protocol !== "kyoei/1") refuse("invalid-request", "protocol");
  if (!EVENT_KINDS.includes(e.kind)) refuse("invalid-request", "kind");
  if (typeof e.id !== "string" || !/^[0-9a-f]{32,64}$/.test(e.id)) refuse("invalid-request", "event id");
  if (typeof e.sig !== "string" || typeof e.nonce !== "string") refuse("invalid-request", "signature");
  if (!e.payload || typeof e.payload !== "object" || Array.isArray(e.payload)) refuse("invalid-request", "payload");
  if (e.deployment !== ctx.deployment) refuse("not-authorized", "deployment");
  if (e.audience !== ctx.self) refuse("not-authorized", "audience");
  if (!ctx.collaborations.has(e.collaboration)) refuse("not-authorized", "collaboration");
  const peer = ctx.peers.get(e.issuer);
  if (!peer) refuse("not-authorized", "unknown issuer");
  if (!Number.isSafeInteger(e.iat) || !Number.isSafeInteger(e.exp) || e.exp <= e.iat) refuse("invalid-request", "times");
  if (e.iat > ctx.now + CLOCK_SKEW_MS) refuse("not-authorized", "issued in the future");
  if (e.exp < ctx.now) refuse("lease-expired", "envelope expired");
  const { sig, ...body } = e;
  if (!(await verify(peer.alg, peer.publicKey, sig, message(body)))) refuse("not-authorized", "signature");
  return e;
}
