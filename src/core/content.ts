import { blake3 } from "@noble/hashes/blake3.js";

export const ALGORITHM = "blake3-snapshot-v1";
export const LIMITS = Object.freeze({ files: 4096, path: 1024, file: 8 * 1024 * 1024, total: 32 * 1024 * 1024 });
export type Mode = "100644" | "100755" | "120000";
export interface Entry { path: string; mode: Mode; bytes: Uint8Array }
export interface Content { alg: typeof ALGORITHM; root: string; files: number; bytes: number }
const encoder = new TextEncoder();

function fail(): never { throw new Error("invalid-snapshot"); }

export function pathBytes(path: string): Uint8Array {
  if (typeof path !== "string" || path.normalize("NFC") !== path || /[\u0000-\u001f\u007f-\u009f\\:]/u.test(path)) fail();
  if (path.split("/").some(p => p === "" || p === "." || p === ".." || p.toLowerCase() === ".git")) fail();
  const bytes = encoder.encode(path);
  if (bytes.length > LIMITS.path || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== path) fail();
  return bytes;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function number(value: number, size: 4 | 8): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  if (size === 4) view.setUint32(0, value, false);
  else view.setBigUint64(0, BigInt(value), false);
  return bytes;
}

export function contentRoot(entries: readonly Entry[]): Content {
  if (!Array.isArray(entries) || entries.length > LIMITS.files) fail();
  let total = 0;
  const paths = new Set<string>();
  const ordered = entries.map(entry => {
    if (!entry || !["100644", "100755", "120000"].includes(entry.mode) || !(entry.bytes instanceof Uint8Array)) fail();
    if (!(entry.bytes.buffer instanceof ArrayBuffer) || entry.bytes.byteLength > LIMITS.file) fail();
    const path = pathBytes(entry.path);
    if (paths.has(entry.path)) fail();
    paths.add(entry.path);
    total += entry.bytes.length;
    if (total > LIMITS.total) fail();
    return { entry, path };
  });
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) fail();
  }
  ordered.sort((a, b) => compare(a.path, b.path));
  const hash = blake3.create({ dkLen: 32 });
  hash.update(encoder.encode("kyoei-content-snapshot-v1\0"));
  hash.update(number(entries.length, 4));
  for (const { entry, path } of ordered) {
    hash.update(number(path.length, 4));
    hash.update(path);
    hash.update(encoder.encode(entry.mode));
    hash.update(number(entry.bytes.length, 8));
    hash.update(entry.bytes);
  }
  const root = Array.from(hash.digest(), b => b.toString(16).padStart(2, "0")).join("");
  return { alg: ALGORITHM, root, files: entries.length, bytes: total };
}

export function validateContent(value: unknown): Content {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "alg,bytes,files,root" || v.alg !== ALGORITHM) fail();
  if (typeof v.root !== "string" || !/^[0-9a-f]{64}$/.test(v.root)) fail();
  for (const [key, max] of [["files", LIMITS.files], ["bytes", LIMITS.total]] as const) {
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0 || (v[key] as number) > max) fail();
  }
  return { alg: ALGORITHM, root: v.root, files: v.files as number, bytes: v.bytes as number };
}

export function verifyContent(entries: readonly Entry[], expected: unknown): Content {
  const want = validateContent(expected);
  const got = contentRoot(entries);
  if (want.root !== got.root || want.files !== got.files || want.bytes !== got.bytes) throw new Error("content-mismatch");
  return got;
}
