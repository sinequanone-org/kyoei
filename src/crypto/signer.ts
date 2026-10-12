// Organization keys. ML-DSA-65 runs in Workers behind the compatibility flag
// `webcrypto_modern_algorithms`. Ed25519 is the configured fallback and the
// algorithm the Node tests use, because Node 22 WebCrypto has no ML-DSA.
// The algorithm comes from local configuration or a pinned peer, never from
// an incoming message.

import { b64u, sha256, unb64u } from "../core/canonical.ts";
import type { SignatureAlgorithm } from "../core/types.ts";

type Bytes = Uint8Array<ArrayBuffer>;

export interface KeyPair {
  alg: SignatureAlgorithm;
  privateKey: CryptoKey;
  publicKey: string;     // base64url SPKI
  fingerprint: string;
}

export interface StoredKey {
  alg: SignatureAlgorithm;
  pkcs8: string;
  spki: string;
}

function params(alg: SignatureAlgorithm): AlgorithmIdentifier {
  return { name: alg };
}

export async function generateKey(alg: SignatureAlgorithm): Promise<{ pair: KeyPair; stored: StoredKey }> {
  const keys = (await crypto.subtle.generateKey(params(alg), true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const stored = { alg, pkcs8: b64u(pkcs8), spki: b64u(spki) };
  return { pair: { alg, privateKey: keys.privateKey, publicKey: stored.spki, fingerprint: await sha256(spki) }, stored };
}

export async function loadKey(stored: StoredKey): Promise<KeyPair> {
  const privateKey = await crypto.subtle.importKey("pkcs8", unb64u(stored.pkcs8) as Bytes, params(stored.alg), false, ["sign"]);
  return { alg: stored.alg, privateKey, publicKey: stored.spki, fingerprint: await sha256(unb64u(stored.spki)) };
}

export async function sign(pair: KeyPair, message: Uint8Array): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.sign(params(pair.alg), pair.privateKey, message as Bytes)));
}

const verifierCache = new Map<string, Promise<CryptoKey>>();

export async function verify(alg: SignatureAlgorithm, publicKey: string, signature: string, message: Uint8Array): Promise<boolean> {
  let key = verifierCache.get(alg + ":" + publicKey);
  if (!key) {
    key = crypto.subtle.importKey("spki", unb64u(publicKey) as Bytes, params(alg), false, ["verify"]);
    verifierCache.set(alg + ":" + publicKey, key);
  }
  let sig: Uint8Array;
  try { sig = unb64u(signature); } catch { return false; }
  if (sig.length === 0 || sig.length > 8192) return false;
  return crypto.subtle.verify(params(alg), await key, sig as Bytes, message as Bytes);
}

export async function fingerprint(publicKey: string): Promise<string> {
  return sha256(unb64u(publicKey));
}
