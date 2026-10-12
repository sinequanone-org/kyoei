// One agent run: prepare a repository, declare the intent, read the verified
// inputs, generate an edit, commit it, register the contribution. Each run
// has its own repository and its own write token. Model output is untrusted:
// it must stay inside the task's file list and the size limits.

import { digest } from "../core/canonical.ts";
import { decodeText } from "./text.ts";
import type { Input } from "../core/types.ts";
import type { OrgNode } from "../node/node.ts";

export interface AgentTask {
  key: string;            // run key, unique per run
  agent: string;          // agent actor name
  line: string;
  version: number;
  task: string;
  files: string[];
  inputs: Input[];
  provides: string[];
  edit: string;           // scripted edit key, or a hint for the model
}

export interface InputContext {
  line: string;
  org: string;
  relation: string;
  files: { path: string; text: string }[];
}

export interface Generation {
  files: { path: string; text: string }[];
  rationale: string;
  prompt: string | null;  // the prompt text; only its digest is recorded
}

export interface Model {
  name: string | null;    // null for scripted edits
  generate(task: AgentTask, base: { path: string; text: string }[], inputs: InputContext[]): Promise<Generation>;
}

export const MAX_FILE_BYTES = 64 * 1024;

export async function runAgent(node: OrgNode, task: AgentTask, model: Model, opts: { sharedToken: () => Promise<string> }): Promise<string> {
  node.requireDelegation(task.agent, task.key, task.task, task.files, task.inputs);
  const started = node.now();
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    node.store.put(`runlog:${task.key}:${type}`, { t: node.now(), ...extra });
  node.store.put(`run:${task.key}`, { task, state: "running", started });
  emit(node, { type: "run.started", run: task.key, agent: task.agent, line: task.line, version: task.version });
  try {
    const shared = node.config.integrationRepo;
    const sharedToken = await opts.sharedToken();
    const base = await node.host.head(shared, sharedToken);
    const repoName = `${task.agent}-${task.line}-v${task.version}-${task.key.slice(-6)}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const { repo } = await node.host.create(repoName, { repo: shared, commit: base, token: sharedToken });
    const write = await node.host.mint(repo, "write", 3600_000);
    log("prepared", { repo, base });
    await node.declareIntent(task.agent, task.line, task.files, task.task);
    const inputs: InputContext[] = [];
    for (const input of task.inputs) {
      if (input.relation === "supersedes") continue;
      const { c, entries } = await node.readInput(input.id, "contribute");
      inputs.push({ line: c.body.line, org: c.body.org, relation: input.relation, files: entries.filter(e => c.body.files.includes(e.path)).map(e => ({ path: e.path, text: decodeText(e.bytes) })) });
    }
    const baseEntries = await node.host.snapshot(repo, base, write.secret);
    const baseFiles = baseEntries.filter(e => task.files.includes(e.path)).map(e => ({ path: e.path, text: decodeText(e.bytes) }));
    node.requireDelegation(task.agent, task.key, task.task, task.files, task.inputs);
    const out = await model.generate(task, baseFiles, inputs);
    for (const f of out.files) {
      if (!task.files.includes(f.path)) throw new Error(`model wrote outside the task files: ${f.path}`);
      if (new TextEncoder().encode(f.text).length > MAX_FILE_BYTES) throw new Error(`model output too large: ${f.path}`);
    }
    if (!out.files.length) throw new Error("model produced no edit");
    if (out.rationale.length > 2000) throw new Error("rationale too long");
    const commit = await node.host.commit(repo, write.secret, {
      base, write: out.files, message: `${task.line}: ${task.task}`, author: task.agent,
    });
    const c = await node.register({
      delegation: task.key, agent: task.agent, repo, commit, base, files: out.files.map(f => f.path), task: task.task, rationale: out.rationale,
      inputs: task.inputs, provides: task.provides, model: model.name, prompt: out.prompt ? await digest("kyoei-prompt-v1", out.prompt) : null,
      line: task.line, version: task.version, writeToken: write.secret,
    });
    await node.host.revoke(write.id);
    node.store.put(`run:${task.key}`, { task, state: "done", started, ended: node.now(), contribution: c.id });
    emit(node, { type: "run.finished", run: task.key, agent: task.agent, line: task.line, version: task.version, contribution: c.id, started, model: model.name ?? "scripted" });
    return c.id;
  } catch (e) {
    node.store.put(`run:${task.key}`, { task, state: "failed", started, ended: node.now(), error: String((e as Error).message) });
    emit(node, { type: "run.failed", run: task.key, agent: task.agent, error: String((e as Error).message).slice(0, 300) });
    throw e;
  }
}

function emit(node: OrgNode, e: Record<string, unknown>): void {
  (node as unknown as { log(e: Record<string, unknown>): void }).log(e as { type: string });
}
