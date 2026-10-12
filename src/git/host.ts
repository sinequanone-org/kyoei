// RepoHost: the repository operations Kyoei needs. Two implementations:
// - the Artifacts host for Workers (src/worker/artifacts-host.ts);
// - a local host that runs the same contract over plain Git
//   (src/local/repo-service.ts), for tests and the offline demo.
// Tokens are bearer secrets. They never enter logs, API responses or notes.

import type { Entry } from "../core/content.ts";

export interface Token {
  id: string;            // public handle, safe to log
  secret: string;        // bearer secret, never logged
  repo: string;          // "<namespace>/<name>"
  scope: "read" | "write";
  expires: number;       // unix milliseconds
  remote?: string;       // Git URL, when the host has one (Artifacts)
}

export interface CommitInput {
  base: string;                       // parent commit
  write: { path: string; text: string; mode?: "100644" | "100755" }[];
  message: string;
  author: string;
}

export type MergeResult =
  | { status: "merged"; head: string }
  | { status: "conflict"; head: string; paths: string[] }
  | { status: "stale"; head: string };

export interface RepoHost {
  // Records the Git URL of a repository in another namespace (from a release).
  learnRemote?(repo: string, url: string): void;
  create(name: string, from?: { repo: string; commit: string; token?: string }): Promise<{ repo: string; head: string }>;
  mint(repo: string, scope: "read" | "write", ttlMs: number): Promise<Token>;
  revoke(tokenId: string): Promise<boolean>;
  head(repo: string, token: string): Promise<string>;
  snapshot(repo: string, commit: string, token: string): Promise<Entry[]>;
  commit(repo: string, token: string, input: CommitInput): Promise<string>;
  // Adds or replaces the git note of `commit` under refs/notes/kyoei.
  note(repo: string, token: string, commit: string, text: string): Promise<void>;
  readNote(repo: string, token: string, commit: string): Promise<string | null>;
  // Merge `source@commit` into `target` main only if main is still `expectedHead`.
  merge(target: string, writeToken: string, source: string, sourceToken: string, commit: string, expectedHead: string, note: string): Promise<MergeResult>;
}
