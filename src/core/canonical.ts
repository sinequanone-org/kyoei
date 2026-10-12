// Canonical JSON, digests and encodings. Every signature and record ID uses
// this encoding, so two nodes always hash the same bytes.

const encoder = new TextEncoder();
const MAX_DEPTH = 16;

export function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("invalid-json");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("invalid-json");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("invalid-json");
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error("invalid-json");
    return "[" + value.map(v => canonical(v, depth + 1)).join(",") + "]";
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value as object).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k], depth + 1)).join(",") + "}";
  }
  throw new Error("invalid-json");
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new Error("invalid-hex");
  return Uint8Array.from(text.match(/../g) ?? [], s => parseInt(s, 16));
}

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid-base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));
}

// Record and event IDs: a domain tag, then the canonical body.
export async function digest(tag: string, body: unknown): Promise<string> {
  return sha256(tag + "\0" + canonical(body));
}

export function randomId(bytes = 16): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}
