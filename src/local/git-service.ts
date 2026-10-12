// A local repository service with the same contract as the Artifacts host:
// namespaces, repo-scoped read and write tokens with expiry and revocation,
// and Git operations that check the token on every call. It stores bare
// repositories on disk and runs the `git` command. It exists for tests and
// the offline demo; it is not a security boundary.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hex, randomId } from "../core/canonical.ts";
import type { Entry, Mode } from "../core/content.ts";
import type { CommitInput, MergeResult, RepoHost, Token } from "../git/host.ts";

interface TokenState { id: string; repo: string; scope: "read" | "write"; expires: number; revoked: boolean }

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const IDENT = { GIT_AUTHOR_NAME: "kyoei", GIT_AUTHOR_EMAIL: "kyoei@localhost", GIT_COMMITTER_NAME: "kyoei", GIT_COMMITTER_EMAIL: "kyoei@localhost" };

export function git(cwd: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string>; okCodes?: number[] } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.KYOEI_GIT ?? "git", args, { cwd, env: { ...process.env, ...IDENT, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...opts.env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (b: Buffer) => { size += b.length; if (size <= 64 * 1024 * 1024) out.push(b); });
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    // Resolve on exit, then wait briefly for the pipes to drain. A wrapper
    // process can keep a pipe open after git exits, so "close" may never fire.
    child.on("exit", code => {
      const drained = Promise.all([child.stdout, child.stderr].map(s => s.readableEnded ? null : new Promise(r => { s.once("end", r); setTimeout(r, 250); })));
      void drained.then(() => {
        const c = code ?? -1;
        const stderr = Buffer.concat(err).toString();
        if (size > 64 * 1024 * 1024) return reject(new Error(`git ${args[0]}: output too large`));
        if (c !== 0 && !(opts.okCodes ?? []).includes(c)) return reject(new Error(`git ${args[0]} failed (${c}): ${stderr.slice(0, 300)}`));
        resolve({ code: c, stdout: Buffer.concat(out), stderr });
      });
    });
    child.stdin.end(opts.input ?? "");
  });
}

export class GitService {
  readonly root: string;
  private readonly tokens = new Map<string, TokenState>();     // secret -> state
  private readonly byId = new Map<string, string>();           // id -> secret
  private readonly namespaces = new Map<string, string>();     // namespace -> credential
  private readonly locks = new Map<string, Promise<unknown>>();
  readonly now: () => number;
  // Test hook: called before a merge updates the ref. It may throw.
  beforeMergeUpdate: ((repo: string) => void) | null = null;
  afterMergeUpdate: ((repo: string) => void) | null = null;

  constructor(root: string, now: () => number = () => Date.now()) {
    this.root = root;
    this.now = now;
    mkdirSync(root, { recursive: true });
  }

  addNamespace(ns: string): string {
    if (!NAME.test(ns)) throw new Error("invalid namespace");
    const credential = "ns_" + randomId(20);
    this.namespaces.set(ns, credential);
    mkdirSync(join(this.root, ns), { recursive: true });
    return credential;
  }

  // A RepoHost bound to one namespace, like a Worker's Artifacts binding.
  binding(ns: string, credential: string): RepoHost {
    if (this.namespaces.get(ns) !== credential) throw new Error("not-authorized: namespace");
    return new NamespaceHost(this, ns);
  }

  path(repo: string): string {
    const [ns, name, ...rest] = repo.split("/");
    if (!ns || !name || rest.length || !NAME.test(ns) || !NAME.test(name) || !this.namespaces.has(ns)) throw new Error("invalid repo");
    return join(this.root, ns, `${name}.git`);
  }

  check(secret: string, repo: string, scope: "read" | "write"): void {
    const t = this.tokens.get(secret);
    if (!t || t.revoked || t.repo !== repo || t.expires <= this.now()) throw new Error("not-authorized: token");
    if (scope === "write" && t.scope !== "write") throw new Error("not-authorized: token scope");
  }

  mint(ns: string, repo: string, scope: "read" | "write", ttlMs: number): Token {
    if (!repo.startsWith(ns + "/")) throw new Error("not-authorized: namespace");
    if (!existsSync(this.path(repo))) throw new Error("unknown repo");
    const expires = this.now() + Math.max(1_000, Math.min(ttlMs, 24 * 3600_000));
    const secret = `art_v1_${hex(crypto.getRandomValues(new Uint8Array(20)))}?expires=${Math.floor(expires / 1000)}`;
    const id = "tok_" + randomId(8);
    this.tokens.set(secret, { id, repo, scope, expires, revoked: false });
    this.byId.set(id, secret);
    return { id, secret, repo, scope, expires };
  }

  revoke(ns: string, id: string): boolean {
    const secret = this.byId.get(id);
    const t = secret ? this.tokens.get(secret) : undefined;
    if (!t || !t.repo.startsWith(ns + "/")) return false;
    t.revoked = true;
    return true;
  }

  async lock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => (release = r));
    this.locks.set(repo, prev.then(() => next));
    await prev.catch(() => {});
    try { return await fn(); } finally { release(); }
  }

  // A bundle with main and the kyoei notes, for a plain `git clone`.
  async bundle(repo: string, secret: string, out: string): Promise<void> {
    this.check(secret, repo, "read");
    const refs = ["refs/heads/main"];
    if ((await git(this.path(repo), ["show-ref", "--verify", "--quiet", "refs/notes/kyoei"], { okCodes: [1] })).code === 0) refs.push("refs/notes/kyoei");
    await git(this.path(repo), ["bundle", "create", out, ...refs]);
  }
}

class NamespaceHost implements RepoHost {
  private readonly svc: GitService;
  private readonly ns: string;

  constructor(svc: GitService, ns: string) {
    this.svc = svc;
    this.ns = ns;
  }

  async create(name: string, from?: { repo: string; commit: string; token?: string }): Promise<{ repo: string; head: string }> {
    if (!NAME.test(name)) throw new Error("invalid repo name");
    const repo = `${this.ns}/${name}`;
    const path = this.svc.path(repo);
    if (existsSync(path)) throw new Error("repo exists");
    mkdirSync(path, { recursive: true });
    await git(path, ["init", "--bare", "-q", "-b", "main"]);
    if (!from) return { repo, head: "" };
    if (!from.repo.startsWith(this.ns + "/")) this.svc.check(from.token ?? "", from.repo, "read");
    await git(path, ["fetch", "-q", this.svc.path(from.repo), `${from.commit}:refs/heads/main`]);
    return { repo, head: from.commit };
  }

  async mint(repo: string, scope: "read" | "write", ttlMs: number): Promise<Token> {
    return this.svc.mint(this.ns, repo, scope, ttlMs);
  }

  async revoke(tokenId: string): Promise<boolean> {
    return this.svc.revoke(this.ns, tokenId);
  }

  async head(repo: string, token: string): Promise<string> {
    this.svc.check(token, repo, "read");
    const r = await git(this.svc.path(repo), ["rev-parse", "--verify", "-q", "refs/heads/main"], { okCodes: [1] });
    return r.code === 0 ? r.stdout.toString().trim() : "";
  }

  async snapshot(repo: string, commit: string, token: string): Promise<Entry[]> {
    this.svc.check(token, repo, "read");
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("invalid commit");
    const path = this.svc.path(repo);
    const tree = await git(path, ["ls-tree", "-r", "-z", "--full-tree", commit]);
    const rows = tree.stdout.toString("utf8").split("\0").filter(Boolean);
    const meta = rows.map(row => {
      const tab = row.indexOf("\t");
      const [mode, type, sha] = row.slice(0, tab).split(" ");
      if (type !== "blob" || !["100644", "100755", "120000"].includes(mode!)) throw new Error("unsupported entry: submodule or mode");
      return { mode: mode as Mode, sha: sha!, path: row.slice(tab + 1) };
    });
    if (!meta.length) return [];
    // One `cat-file --batch` process reads every blob.
    const batch = (await git(path, ["cat-file", "--batch"], { input: meta.map(m => m.sha).join("\n") + "\n" })).stdout;
    const entries: Entry[] = [];
    let at = 0;
    for (const m of meta) {
      const nl = batch.indexOf(10, at);
      const [sha, type, len] = batch.subarray(at, nl).toString().split(" ");
      if (sha !== m.sha || type !== "blob") throw new Error("cat-file batch mismatch");
      const n = Number(len);
      const bytes = new Uint8Array(n);
      bytes.set(batch.subarray(nl + 1, nl + 1 + n));
      entries.push({ path: m.path, mode: m.mode, bytes });
      at = nl + 1 + n + 1;
    }
    return entries;
  }

  async commit(repo: string, token: string, input: CommitInput): Promise<string> {
    this.svc.check(token, repo, "write");
    const path = this.svc.path(repo);
    return this.svc.lock(repo, async () => {
      const work = mkdtempSync(join(tmpdir(), "kyoei-index-"));
      const env = { GIT_INDEX_FILE: join(work, "index"), GIT_AUTHOR_NAME: input.author, GIT_COMMITTER_NAME: input.author };
      try {
        if (input.base) await git(path, ["read-tree", input.base], { env });
        for (const w of input.write) {
          const sha = (await git(path, ["hash-object", "-w", "--stdin"], { input: w.text })).stdout.toString().trim();
          await git(path, ["update-index", "--add", "--cacheinfo", `${w.mode ?? "100644"},${sha},${w.path}`], { env });
        }
        const tree = (await git(path, ["write-tree"], { env })).stdout.toString().trim();
        const args = ["commit-tree", tree, "-m", input.message];
        if (input.base) args.push("-p", input.base);
        const commit = (await git(path, args, { env })).stdout.toString().trim();
        await git(path, ["update-ref", "refs/heads/main", commit, ...(input.base ? [input.base] : [])]);
        return commit;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  async note(repo: string, token: string, commit: string, text: string): Promise<void> {
    this.svc.check(token, repo, "write");
    const path = this.svc.path(repo);
    await this.svc.lock(repo + "#notes", () => git(path, ["notes", "--ref=kyoei", "add", "-f", "-F", "-", commit], { input: text }));
  }

  async readNote(repo: string, token: string, commit: string): Promise<string | null> {
    this.svc.check(token, repo, "read");
    const r = await git(this.svc.path(repo), ["notes", "--ref=kyoei", "show", commit], { okCodes: [1, 128] });
    return r.code === 0 ? r.stdout.toString() : null;
  }

  async merge(target: string, writeToken: string, source: string, sourceToken: string, commit: string, expectedHead: string, note: string): Promise<MergeResult> {
    this.svc.check(writeToken, target, "write");
    this.svc.check(sourceToken, source, "read");
    const path = this.svc.path(target);
    return this.svc.lock(target, async () => {
      await git(path, ["fetch", "-q", this.svc.path(source), commit]);
      const sourceNote = await git(this.svc.path(source), ["notes", "--ref=kyoei", "show", commit], { okCodes: [1, 128] });
      const head = (await git(path, ["rev-parse", "refs/heads/main"])).stdout.toString().trim();
      if (head !== expectedHead) return { status: "stale", head };
      const merged = await git(path, ["merge-tree", "--write-tree", "--name-only", "--no-messages", head, commit], { okCodes: [1] });
      const lines = merged.stdout.toString().trim().split("\n");
      if (merged.code === 1) return { status: "conflict", head, paths: lines.slice(1).filter(Boolean) };
      const merge = (await git(path, ["commit-tree", lines[0]!, "-p", head, "-p", commit, "-m", `kyoei: ship ${commit.slice(0, 12)}`])).stdout.toString().trim();
      this.svc.beforeMergeUpdate?.(target);
      await git(path, ["update-ref", "refs/heads/main", merge, head]);
      if (sourceNote.code === 0) await git(path, ["notes", "--ref=kyoei", "add", "-f", "-F", "-", commit], { input: sourceNote.stdout });
      await git(path, ["notes", "--ref=kyoei", "add", "-f", "-F", "-", merge], { input: note });
      this.svc.afterMergeUpdate?.(target);
      return { status: "merged", head: merge };
    });
  }
}
