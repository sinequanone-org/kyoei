// RepoHost on Cloudflare Artifacts. The binding creates repositories, forks
// them and mints or revokes repo-scoped tokens. Commits, notes and merges go
// through Git over HTTPS with isomorphic-git in memory.
//
// Status: checked against a live account on 11 October 2026 with
// tools/probe (create, fork, tokens, push, notes, merge refusal, revocation).

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { Entry, Mode } from "../core/content.ts";
import { sha256 } from "../core/canonical.ts";
import type { CommitInput, MergeResult, RepoHost, Token } from "../git/host.ts";
import type { Store } from "../node/store.ts";
import { MemoryFS } from "./memfs.ts";

export interface ArtifactsRepo {
  remote?: string;
  fork(name: string, opts: { defaultBranchOnly: boolean; readOnly: boolean }): Promise<{ remote: string }>;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<{ plaintext: string }>;
  revokeToken(token: string): Promise<unknown>;
}

export interface ArtifactsBinding {
  create(name: string, opts: { setDefaultBranch: string }): Promise<{ remote: string }>;
  get(name: string): Promise<ArtifactsRepo>;
}

const AUTHOR = { name: "kyoei", email: "kyoei@invalid" };
const secretOf = (token: string) => token.split("?expires=")[0] ?? "";
const auth = (token: string) => () => ({ username: "x", password: secretOf(token) });

export class ArtifactsHost implements RepoHost {
  private readonly ns: string;
  private readonly artifacts: ArtifactsBinding;
  private readonly store: Store;

  constructor(ns: string, artifacts: ArtifactsBinding, store: Store) {
    this.ns = ns;
    this.artifacts = artifacts;
    this.store = store;
  }

  private name(repo: string): string {
    const [ns, name] = repo.split("/");
    if (ns !== this.ns || !name) throw new Error("not-authorized: namespace");
    return name;
  }

  // Remote URLs of repositories in other namespaces arrive inside releases.
  remote(repo: string): string {
    const url = this.store.get<string>(`remote:${repo}`);
    if (!url) throw new Error(`unknown remote for ${repo}`);
    return url;
  }

  learnRemote(repo: string, url: string): void {
    if (!/^https:\/\//.test(url)) throw new Error("remote must be https");
    this.store.put(`remote:${repo}`, url);
  }

  async create(name: string, from?: { repo: string; commit: string; token?: string }): Promise<{ repo: string; head: string }> {
    const repo = `${this.ns}/${name}`;
    if (from && from.repo.startsWith(this.ns + "/")) {
      const forked = await (await this.artifacts.get(this.name(from.repo))).fork(name, { defaultBranchOnly: true, readOnly: false });
      this.store.put(`remote:${repo}`, forked.remote);
      return { repo, head: from.commit };
    }
    const created = await this.artifacts.create(name, { setDefaultBranch: "main" });
    this.store.put(`remote:${repo}`, created.remote);
    if (!from) return { repo, head: "" };
    // Cross-namespace fork: fetch with the released read token, push to ours.
    const fs = new MemoryFS();
    await git.clone({ fs, http, dir: "/w", url: this.remote(from.repo), ref: "main", singleBranch: true, onAuth: auth(from.token ?? "") });
    const write = await this.mint(repo, "write", 600_000);
    try {
      await git.push({ fs, http, dir: "/w", url: created.remote, ref: from.commit, remoteRef: "refs/heads/main", onAuth: auth(write.secret) });
    } finally {
      await this.revoke(write.id);
    }
    return { repo, head: from.commit };
  }

  async mint(repo: string, scope: "read" | "write", ttlMs: number): Promise<Token> {
    const handle = await this.artifacts.get(this.name(repo));
    const ttl = Math.max(60, Math.min(Math.floor(ttlMs / 1000), 24 * 3600));
    const { plaintext } = await handle.createToken(scope, ttl);
    const id = "tok_" + (await sha256(plaintext)).slice(0, 16);
    this.store.put(`artifacts-token:${id}`, { repo, plaintext });
    return { id, secret: plaintext, repo, scope, expires: Date.now() + ttl * 1000, remote: this.store.get<string>(`remote:${repo}`) };
  }

  async revoke(tokenId: string): Promise<boolean> {
    const t = this.store.get<{ repo: string; plaintext: string }>(`artifacts-token:${tokenId}`);
    if (!t) return false;
    await (await this.artifacts.get(this.name(t.repo))).revokeToken(t.plaintext);
    this.store.delete(`artifacts-token:${tokenId}`);
    return true;
  }

  private async clone(repo: string, token: string, notes = false): Promise<MemoryFS> {
    const fs = new MemoryFS();
    const url = this.remote(repo);
    await git.clone({ fs, http, dir: "/w", url, ref: "main", singleBranch: true, onAuth: auth(token) });
    if (notes) {
      try {
        // The default refspec does not map refs/notes/*, so write the ref from fetchHead.
        const fetched = await git.fetch({ fs, http, dir: "/w", url, ref: "refs/notes/kyoei", remoteRef: "refs/notes/kyoei", singleBranch: true, tags: false, onAuth: auth(token) });
        if (fetched.fetchHead) await git.writeRef({ fs, dir: "/w", ref: "refs/notes/kyoei", value: fetched.fetchHead, force: true });
      } catch { /* no notes yet */ }
    }
    return fs;
  }

  async head(repo: string, token: string): Promise<string> {
    const refs = await git.listServerRefs({ http, url: this.remote(repo), prefix: "refs/heads/main", onAuth: auth(token) });
    return refs.find(r => r.ref === "refs/heads/main")?.oid ?? "";
  }

  async snapshot(repo: string, commit: string, token: string): Promise<Entry[]> {
    const fs = await this.clone(repo, token);
    const entries: Entry[] = [];
    const walk = async (tree: string, prefix: string) => {
      const { tree: rows } = await git.readTree({ fs, dir: "/w", oid: tree });
      for (const row of rows) {
        const path = prefix + row.path;
        if (row.type === "tree") { await walk(row.oid, path + "/"); continue; }
        if (row.type !== "blob" || !["100644", "100755", "120000"].includes(row.mode)) throw new Error("unsupported entry: submodule or mode");
        const { blob } = await git.readBlob({ fs, dir: "/w", oid: row.oid });
        entries.push({ path, mode: row.mode as Mode, bytes: new Uint8Array(blob) });
      }
    };
    const { commit: c } = await git.readCommit({ fs, dir: "/w", oid: commit });
    await walk(c.tree, "");
    return entries;
  }

  async commit(repo: string, token: string, input: CommitInput): Promise<string> {
    const fs = await this.clone(repo, token);
    if (input.base) await git.checkout({ fs, dir: "/w", ref: input.base, force: true });
    for (const w of input.write) {
      await fs.promises.writeFile(`/w/${w.path}`, w.text);
      await git.add({ fs, dir: "/w", filepath: w.path });
    }
    const oid = await git.commit({ fs, dir: "/w", message: input.message, author: { ...AUTHOR, name: input.author }, parent: input.base ? [input.base] : [] });
    const pushed = await git.push({ fs, http, dir: "/w", url: this.remote(repo), ref: oid, remoteRef: "refs/heads/main", onAuth: auth(token) });
    if (!pushed.ok) throw new Error("push rejected");
    return oid;
  }

  async note(repo: string, token: string, commit: string, text: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fs = await this.clone(repo, token, true);
      await git.addNote({ fs, dir: "/w", ref: "refs/notes/kyoei", oid: commit, note: text, author: AUTHOR, force: true });
      const pushed = await git.push({ fs, http, dir: "/w", url: this.remote(repo), ref: "refs/notes/kyoei", remoteRef: "refs/notes/kyoei", onAuth: auth(token) }).catch(() => ({ ok: false }));
      if (pushed.ok) return;
    }
    throw new Error("notes push rejected three times");
  }

  async readNote(repo: string, token: string, commit: string): Promise<string | null> {
    const fs = await this.clone(repo, token, true);
    try {
      return new TextDecoder().decode(await git.readNote({ fs, dir: "/w", ref: "refs/notes/kyoei", oid: commit }));
    } catch {
      return null;
    }
  }

  async merge(target: string, writeToken: string, source: string, sourceToken: string, commit: string, expectedHead: string, note: string): Promise<MergeResult> {
    const fs = await this.clone(target, writeToken, true);
    const head = await git.resolveRef({ fs, dir: "/w", ref: "main" });
    if (head !== expectedHead) return { status: "stale", head };
    await git.addRemote({ fs, dir: "/w", remote: "source", url: this.remote(source), force: true });
    await git.fetch({ fs, http, dir: "/w", remote: "source", ref: "main", singleBranch: true, tags: false, onAuth: auth(sourceToken) });
    let merged: string;
    try {
      const result = await git.merge({ fs, dir: "/w", ours: "main", theirs: commit, fastForward: false, author: AUTHOR, message: `kyoei: ship ${commit.slice(0, 12)}` });
      if (!result.oid) throw new Error("merge produced no commit");
      merged = result.oid;
    } catch (e) {
      if ((e as { code?: string }).code === "MergeConflictError") return { status: "conflict", head, paths: ((e as { data?: { filepaths?: string[] } }).data?.filepaths) ?? [] };
      throw e;
    }
    await this.note(target, writeToken, merged, note);
    // Conditional update: a non-fast-forward push fails if main moved.
    const pushed = await git.push({ fs, http, dir: "/w", url: this.remote(target), ref: merged, remoteRef: "refs/heads/main", onAuth: auth(writeToken) });
    if (!pushed.ok) return { status: "stale", head: await this.head(target, writeToken) };
    return { status: "merged", head: merged };
  }
}
