// OrgNode: one organization's Kyoei node. It keeps the organization's ledger,
// holds its signing key, pins its peers and delivers its signed events.
//
// Rules this file enforces (see docs/acceptance.md for the tests):
// - Only the owner's node changes the state of its own contributions.
// - Each node computes its own affected work from its own records.
// - Only a person releases, approves, withdraws or records dissent.
// - Async work (crypto, network, Git) runs before a transaction. Each state
//   change, its inbox receipt and the events it causes commit together.

import { canonical, digest, randomId } from "../core/canonical.ts";
import { pathBytes, type Entry } from "../core/content.ts";
import { open as openEnvelope, seal } from "../core/envelope.ts";
import { signRecord, verifyRecord, verifySnapshot } from "../core/record.ts";
import {
  Refusal, refuse,
  type Actor, type Check, type Contribution, type ContributionBody, type Envelope, type EventKind,
  type Input, type Notice, type Peer, type Receipt, type RefusalCode, type SignatureAlgorithm,
} from "../core/types.ts";
import { fingerprint as keyFingerprint, generateKey, loadKey, type KeyPair, type StoredKey } from "../crypto/signer.ts";
import type { RepoHost } from "../git/host.ts";
import type { Store } from "./store.ts";

export const ENVELOPE_TTL_MS = 10 * 60_000;
export const MAX_RELEASE_MS = 24 * 3600_000;
const CLAIM_LEASE_MS = 30_000;

export class DeliveryError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

export interface Transport {
  deliver(peer: Peer, envelope: Envelope): Promise<Receipt>;
  request(peer: Peer, envelope: Envelope): Promise<Envelope>;
}

export interface NodeConfig {
  org: string;
  deployment: string;
  collaboration: string;
  url: string;
  alg: SignatureAlgorithm;
  integrator: string;                 // org that hosts the integration repo
  integrationRepo: string;            // "<namespace>/<name>"
  actors: Actor[];
}

export interface LogEvent {
  type: string;
  [key: string]: unknown;
}

export interface Cause {
  cause: string;        // root event ID
  event: string;        // the event that carried it here
  kind: EventKind | "withdraw-local";
  org: string;          // organization that issued the root event
  target: string;       // contribution the root event names
  reason: string;
  at: number;
  evidence?: "withheld";
}

interface Status {
  rev: number;
  withdrawn?: Cause;
  replacedBy: string[];
  blocked: (Cause & { code: RefusalCode; item: string })[];
  challenges: Cause[];
}

interface Held {
  id: string;
  from: string;
  purposes: string[];
  expires: number;
  onward: { org: string; purposes: string[] }[];
  tokenId: string;
  repo: string;
  received: number;
}

interface Grant {
  id: string;
  to: string;
  purposes: string[];
  expires: number;
  onward: { org: string; purposes: string[] }[];
  tokenId: string;
  revoked: boolean;
  revokeResult?: "revoked" | "failed";
  actor: string;
  at: number;
}

interface Delegation {
  actor: string;
  agent: string;
  key: string;
  task: string;
  files: string[];
  inputs: Input[];
  purpose: "contribute";
  expires: number;
  used?: string;
}

interface Revocation {
  grantKey: string;
  tokenId: string;
  next: number;
  expires: number;
}

interface Approval {
  id: string;
  actor: string;
  binding: string;
  at: number;
}

interface QueuedEvent {
  id?: string;
  to: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  created?: number;
}

interface OutboxEntry {
  key: string;
  to: string;
  envelope: Envelope;
  attempts: number;
  next: number;
  claimed?: number;
  failed?: string;
  created: number;
}

interface Intent {
  org: string;
  agent: string;
  line: string;
  files: string[];
  task: string;
  state: "open" | "closed";
  at: number;
}

interface Overlap {
  id: string;
  a: { org: string; agent: string };
  b: { org: string; agent: string };
  files: string[];
  at: number;
}

interface ShipOp {
  id: string;
  contribution: string;
  expectedHead: string;
  state: "pending" | "merged" | "refused" | "unresolved";
  head?: string;
  code?: RefusalCode;
  at: number;
}

interface MainEntry {
  head: string;
  id: string | null;
  files: string[];
}

export interface RegisterInput {
  delegation?: string;
  agent: string;
  repo: string;
  commit: string;
  base: string;
  files: string[];
  task: string;
  rationale: string;
  inputs: Input[];
  provides: string[];
  model: string | null;
  prompt: string | null;
  line: string;
  version: number;
  writeToken: string;
}

export interface RepairPlan {
  item: string;
  line: string;
  version: number;
  inputs: Input[];
  files: string[];
  task: string;
  provides: string[];
  onto: string | null;
  from: string | null;
}

export class OrgNode {
  readonly config: NodeConfig;
  readonly store: Store;
  readonly host: RepoHost;
  readonly transport: Transport;
  readonly now: () => number;
  private readonly sink: (e: LogEvent) => void;
  private key: KeyPair | null = null;
  private flushing: Promise<void> | null = null;
  private preparing: Promise<void> | null = null;

  constructor(opts: { config: NodeConfig; store: Store; host: RepoHost; transport: Transport; now?: () => number; log?: (e: LogEvent) => void }) {
    this.config = opts.config;
    this.store = opts.store;
    this.host = opts.host;
    this.transport = opts.transport;
    this.now = opts.now ?? (() => Date.now());
    this.sink = opts.log ?? (() => {});
  }

  // ---------- setup ----------

  async init(): Promise<Peer> {
    let stored = this.store.get<StoredKey>("key");
    if (!stored) {
      const generated = await generateKey(this.config.alg);
      stored = generated.stored;
      this.store.put("key", stored);
    }
    this.key = await loadKey(stored);
    if (!this.store.get("main")) this.store.put("main", [] as MainEntry[]);
    this.recoverClaims();
    return this.identity();
  }

  identity(): Peer {
    const key = this.requireKey();
    return { org: this.config.org, url: this.config.url, alg: key.alg, publicKey: key.publicKey, fingerprint: key.fingerprint };
  }

  // Pins a peer. The fingerprint must match the one exchanged out of band.
  async pin(peer: Peer, expectedFingerprint: string): Promise<void> {
    if ((await keyFingerprint(peer.publicKey)) !== expectedFingerprint || peer.fingerprint !== expectedFingerprint) {
      refuse("not-authorized", "fingerprint mismatch");
    }
    const url = new URL(peer.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      refuse("not-authorized", "peer URL requires HTTPS except on loopback");
    }
    if (peer.org === this.config.org) refuse("invalid-request", "cannot pin self");
    this.store.put(`peer:${peer.org}`, peer);
    this.log({ type: "peer.pinned", peer: peer.org, fingerprint: peer.fingerprint.slice(0, 16) });
  }

  peers(): Map<string, Peer> {
    return new Map(this.store.list<Peer>("peer:").map(([, p]) => [p.org, p]));
  }

  actor(name: string): Actor {
    const a = this.config.actors.find(x => x.name === name);
    if (!a) refuse("not-authorized", `unknown actor ${name}`);
    return a;
  }

  person(name: string): Actor {
    const a = this.actor(name);
    if (a.kind !== "person") refuse("human-required", `${name} is an agent`);
    return a;
  }

  people(): string[] {
    return this.config.actors.filter(a => a.kind === "person").map(a => a.name);
  }

  delegateTask(actorName: string, task: { agent: string; key: string; task: string; files: string[]; inputs: Input[] }, ttlMs = 3600_000): void {
    this.person(actorName);
    const agent = this.actor(task.agent);
    if (agent.kind !== "agent" || agent.delegate !== actorName) refuse("not-authorized", "agent has another delegator");
    if (typeof task.key !== "string" || !task.key.length || task.key.length > 128 || typeof task.task !== "string" || !task.task.length || task.task.length > 4000) refuse("invalid-request", "delegation task");
    if (!Array.isArray(task.files) || !task.files.length || task.files.length > 256 || !Array.isArray(task.inputs) || task.inputs.length > 256) refuse("invalid-request", "delegation scope");
    for (const file of task.files) pathBytes(file);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3600_000) refuse("invalid-request", "delegation expiry");
    if (this.store.get(`delegation:${task.key}`)) refuse("conflict", "run already delegated");
    const delegation: Delegation = { actor: actorName, agent: task.agent, key: task.key, task: task.task, files: task.files, inputs: task.inputs, purpose: "contribute", expires: this.now() + ttlMs };
    this.store.put(`delegation:${task.key}`, delegation);
  }

  requireDelegation(agent: string, key: string | undefined, task: string, files: string[], inputs: Input[], purpose = "contribute"): void {
    const actor = this.actor(agent);
    if (actor.kind !== "agent") refuse("not-authorized", "delegation requires an agent");
    const delegation = key ? this.store.get<Delegation>(`delegation:${key}`) : undefined;
    if (!delegation || delegation.agent !== agent || delegation.actor !== actor.delegate || delegation.used) refuse("not-authorized", "no active task delegation");
    this.person(delegation.actor);
    if (delegation.expires <= this.now()) refuse("lease-expired", "task delegation expired");
    if (delegation.purpose !== purpose || delegation.task !== task || !files.every(f => delegation.files.includes(f)) || canonical(inputs) !== canonical(delegation.inputs)) refuse("not-authorized", "outside task delegation");
  }

  // ---------- records ----------

  record(id: string): { c: Contribution; own: boolean; verified: boolean } | undefined {
    return this.store.get(`c:${id}`);
  }

  requireRecord(id: string): Contribution {
    const r = this.record(id);
    if (!r) refuse("not-authorized", `unknown contribution ${id.slice(0, 12)}`);
    return r.c;
  }

  status(id: string): Status {
    return this.store.get<Status>(`status:${id}`) ?? { rev: 0, replacedBy: [], blocked: [], challenges: [] };
  }

  ownRecords(): Contribution[] {
    return this.store.list<{ c: Contribution; own: boolean }>("c:").filter(([, r]) => r.own).map(([, r]) => r.c);
  }

  // The effective state of a contribution, from this node's own knowledge.
  effective(id: string, seen = new Set<string>()): { code: RefusalCode | null; cause?: Cause; via?: string } {
    if (seen.has(id)) return { code: null };
    seen.add(id);
    const st = this.status(id);
    if (st.withdrawn) return { code: "withdrawn", cause: st.withdrawn };
    const w = st.blocked.find(b => b.code === "withdrawn");
    if (w) return { code: "withdrawn", cause: w };
    let replacement: { code: RefusalCode; cause?: Cause; via?: string } | null = null;
    if (st.blocked.length) replacement = { code: st.blocked[0]!.code, cause: st.blocked[0] };
    if (!replacement && st.replacedBy.length) replacement = { code: "replacement-required" };
    const r = this.record(id);
    if (r) {
      for (const input of r.c.body.inputs) {
        if (input.relation !== "builds-on") continue;
        const e = this.effective(input.id, seen);
        if (e.code === "withdrawn") return { code: "withdrawn", cause: e.cause, via: input.id };
        if (e.code && !replacement) replacement = { code: e.code, cause: e.cause, via: input.id };
      }
    }
    return replacement ?? { code: null };
  }

  // Does `x` reach `target` through builds-on relations in records we hold?
  reaches(x: string, target: string, seen = new Set<string>()): boolean {
    if (seen.has(x)) return false;
    seen.add(x);
    const r = this.record(x);
    if (!r) return false;
    return r.c.body.inputs.some(i => i.relation === "builds-on" && (i.id === target || this.reaches(i.id, target, seen)));
  }

  // ---------- registration ----------

  async register(input: RegisterInput): Promise<Contribution> {
    const actor = this.actor(input.agent);
    if (actor.kind === "agent") this.requireDelegation(input.agent, input.delegation, input.task, input.files, input.inputs);
    for (const i of input.inputs) {
      const target = this.record(i.id);
      if (!target) refuse("not-authorized", `input ${i.id.slice(0, 12)} is not held`);
      if (i.relation === "supersedes" && target.c.body.org !== this.config.org) refuse("not-authorized", "only the owner supersedes");
      if (!target.own && i.relation !== "supersedes") this.requireUsable(i.id, "contribute");
    }
    const entries = await this.host.snapshot(input.repo, input.commit, input.writeToken);
    const { contentRoot } = await import("../core/content.ts");
    const body: ContributionBody = {
      v: 1,
      deployment: this.config.deployment,
      collaboration: this.config.collaboration,
      org: this.config.org,
      actor: input.agent,
      repo: input.repo,
      commit: input.commit,
      base: input.base,
      content: contentRoot(entries),
      task: input.task,
      rationale: input.rationale,
      files: [...input.files].sort(),
      inputs: input.inputs,
      provides: input.provides,
      model: input.model,
      prompt: input.prompt,
      version: input.version,
      line: input.line,
      created: this.now(),
    };
    const c = await signRecord(this.requireKey(), body);
    const supersedes = input.inputs.filter(i => i.relation === "supersedes").map(i => i.id);
    const cause = await digest("kyoei-cause-v1", { kind: "correct", record: c.id });
    const events = this.eventTransaction(() => {
      if (actor.kind === "agent") {
        this.requireDelegation(input.agent, input.delegation, input.task, input.files, input.inputs);
        const delegation = this.store.get<Delegation>(`delegation:${input.delegation}`)!;
        this.store.put(`delegation:${input.delegation}`, { ...delegation, used: c.id });
      }
      this.store.put(`c:${c.id}`, { c, own: true, verified: true });
      this.store.put(`status:${c.id}`, this.status(c.id));
      const queued: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
      for (const old of supersedes) {
        const st = this.status(old);
        st.replacedBy = [...new Set([...st.replacedBy, c.id])];
        st.rev += 1;
        this.store.put(`status:${old}`, st);
        for (const to of this.audience(old)) {
          queued.push({ to, kind: "correct", payload: { old, replacement: c.id, cause, reason: `superseded by ${input.line} v${input.version}`, rev: st.rev } });
        }
        this.applyChange({ cause, event: cause, kind: "correct", org: this.config.org, target: old, reason: `superseded by ${input.line} v${input.version}`, at: this.now() }, old, true, queued);
      }
      this.closeIntent(input.agent);
      const intent = this.store.get<Intent>(`intent:${this.config.org}:${input.agent}`);
      if (intent && this.config.org !== this.config.integrator) queued.push({ to: this.config.integrator, kind: "intent", payload: { ...intent, state: "closed" } });
      this.closeResolvedNotices();
      return queued;
    });
    await this.host.note(input.repo, input.writeToken, input.commit, noteText(c));
    await this.enqueue(events);
    this.log({ type: "contribution.registered", id: c.id, line: body.line, version: body.version, agent: body.actor, commit: body.commit, root: body.content.root, inputs: body.inputs });
    for (const i of input.inputs) {
      const target = this.record(i.id)!;
      if (!target.own && i.relation !== "supersedes") await this.rely(i.id, i.relation, "contribute");
    }
    void this.flush();
    return c;
  }

  // Integrator only: create the integration repository with seed files and
  // register the baseline contribution that other organizations fork from.
  async seed(actorName: string, files: { path: string; text: string }[]): Promise<Contribution> {
    this.person(actorName);
    if (this.config.org !== this.config.integrator) refuse("not-authorized", "only the integrator seeds");
    const name = this.config.integrationRepo.split("/")[1]!;
    const { repo } = await this.host.create(name);
    const w = await this.host.mint(repo, "write", 120_000);
    const head = await this.host.commit(repo, w.secret, { base: "", author: actorName, message: "seed", write: files });
    this.setMainBase(head);
    const c = await this.register({ agent: actorName, repo, commit: head, base: head, files: files.map(f => f.path), task: "seed the integration repository", rationale: "baseline for every agent fork", inputs: [], provides: [], model: null, prompt: null, line: "seed", version: 1, writeToken: w.secret });
    await this.host.revoke(w.id);
    return c;
  }

  // ---------- intents and overlap ----------

  async declareIntent(agent: string, line: string, files: string[], task: string): Promise<void> {
    if (this.actor(agent).kind !== "agent") refuse("invalid-request", "intents come from agents");
    const intent: Intent = { org: this.config.org, agent, line, files: [...files].sort(), task, state: "open", at: this.now() };
    this.log({ type: "intent.declared", agent, files: intent.files });
    if (this.config.org === this.config.integrator) {
      const events = this.eventTransaction(() => this.acceptIntent(intent));
      await this.enqueue(events);
    } else {
      const events = this.eventTransaction(() => {
        this.store.put(`intent:${this.config.org}:${agent}`, intent);
        return [{ to: this.config.integrator, kind: "intent" as const, payload: { ...intent } }];
      });
      await this.enqueue(events);
    }
    void this.flush();
  }

  private closeIntent(agent: string): void {
    const key = `intent:${this.config.org}:${agent}`;
    const intent = this.store.get<Intent>(key);
    if (intent) this.store.put(key, { ...intent, state: "closed" });
  }

  // Integrator only. Runs inside a transaction.
  private acceptIntent(intent: Intent): { to: string; kind: EventKind; payload: Record<string, unknown> }[] {
    const key = `intent:${intent.org}:${intent.agent}`;
    this.store.put(key, intent);
    const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
    if (intent.state !== "open") return out;
    for (const [, other] of this.store.list<Intent>("intent:")) {
      if (other.state !== "open" || (other.org === intent.org && other.agent === intent.agent)) continue;
      const files = intent.files.filter(f => other.files.includes(f));
      if (!files.length) continue;
      const pair = [`${intent.org}/${intent.agent}`, `${other.org}/${other.agent}`].sort();
      const id = `${pair[0]}+${pair[1]}`;
      if (this.store.get(`overlap:${id}`)) continue;
      const overlap: Overlap = { id, a: { org: other.org, agent: other.agent }, b: { org: intent.org, agent: intent.agent }, files, at: this.now() };
      this.store.put(`overlap:${id}`, overlap);
      this.log({ type: "overlap.flagged", id, files, agents: pair });
      for (const org of new Set([intent.org, other.org])) {
        if (org !== this.config.org) out.push({ to: org, kind: "overlap", payload: { ...overlap } });
      }
    }
    return out;
  }

  // ---------- releases ----------

  async release(actorName: string, id: string, to: string[], purposes: string[], ttlMs: number, onward: { org: string; purposes: string[] }[] = []): Promise<Grant[]> {
    this.person(actorName);
    const r = this.record(id);
    if (!r || !r.own) refuse("not-authorized", "only the owner releases");
    const e = this.effective(id);
    if (e.code) refuse(e.code, "cannot release blocked work");
    if (!to.length || !purposes.length) refuse("invalid-request", "recipients and purposes");
    for (const org of to) if (!this.store.get(`peer:${org}`)) refuse("not-authorized", `unknown recipient ${org}`);
    let expires = this.now() + Math.min(ttlMs, MAX_RELEASE_MS);
    // Onward release: every foreign input this work builds on needs an
    // explicit grant from its owner for each recipient and purpose.
    for (const input of this.foreignBuildsOn(id)) {
      const held = this.store.get<Held>(`held:${input}`);
      const owner = this.requireRecord(input).body.org;
      if (!held) refuse("new-grant-required", `no grant for input ${input.slice(0, 12)}`);
      if (held.expires <= this.now()) refuse("lease-expired", `grant for input ${input.slice(0, 12)} expired`);
      for (const org of to) {
        if (org === owner) continue;
        const allowed = held.onward.find(o => o.org === org);
        if (!allowed || !purposes.every(p => allowed.purposes.includes(p))) {
          refuse("new-grant-required", `${owner} did not allow onward release of ${input.slice(0, 12)} to ${org}`);
        }
      }
      expires = Math.min(expires, held.expires);
    }
    const tokens: { org: string; token: Awaited<ReturnType<RepoHost["mint"]>> }[] = [];
    for (const org of to) tokens.push({ org, token: await this.host.mint(r.c.body.repo, "read", expires - this.now()) });
    const st = this.status(id);
    const grants: Grant[] = tokens.map(({ org, token }) => ({
      id, to: org, purposes, expires, onward: onward.filter(o => o.org !== org), tokenId: token.id, revoked: false, actor: actorName, at: this.now(),
    }));
    const events = this.eventTransaction(() => {
      const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
      for (const [i, g] of grants.entries()) {
        this.store.put(`grant:${id}:${g.to}:${g.tokenId}`, g);
        const t = tokens[i]!.token;
        out.push({ to: g.to, kind: "release", payload: { contribution: r.c, purposes, expires, onward: g.onward, token: { id: t.id, secret: t.secret, repo: t.repo, expires: t.expires, remote: t.remote }, rev: st.rev } });
      }
      return out;
    });
    await this.enqueue(events);
    this.log({ type: "release.sent", id, line: r.c.body.line, to, purposes, actor: actorName, tokens: grants.map(g => g.tokenId), expires });
    void this.flush();
    return grants;
  }

  private foreignBuildsOn(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const out: string[] = [];
    for (const i of this.requireRecord(id).body.inputs) {
      if (i.relation !== "builds-on") continue;
      const r = this.record(i.id);
      if (!r) continue;
      if (r.own) out.push(...this.foreignBuildsOn(i.id, seen));
      else out.push(i.id);
    }
    return [...new Set(out)];
  }

  grants(id: string): Grant[] {
    return this.store.list<Grant>(`grant:${id}:`).map(([, g]) => g);
  }

  // Organizations that must hear about a change to one of our contributions.
  private audience(id: string): string[] {
    const orgs = new Set<string>();
    for (const g of this.grants(id)) orgs.add(g.to);
    for (const s of this.store.get<string[]>(`subs:${id}`) ?? []) orgs.add(s);
    orgs.delete(this.config.org);
    return [...orgs].sort();
  }

  // A held release, in force, for the purpose, with a verified snapshot.
  requireUsable(id: string, purpose: string): Held {
    const r = this.record(id);
    if (!r) refuse("not-authorized", "unknown contribution");
    const e = this.effective(id);
    if (e.code) refuse(e.code, `${r.c.body.line} is ${e.code}`);
    if (r.own) return { id, from: this.config.org, purposes: [purpose], expires: Infinity, onward: [], tokenId: "", repo: r.c.body.repo, received: 0 };
    const held = this.store.get<Held>(`held:${id}`);
    if (!held) refuse("new-grant-required", `${r.c.body.line} was not released to ${this.config.org}`);
    if (held.expires <= this.now()) refuse("lease-expired", `release of ${r.c.body.line} expired`);
    if (!held.purposes.includes(purpose)) refuse("new-grant-required", `release of ${r.c.body.line} does not cover ${purpose}`);
    if (!r.verified) refuse("not-authorized", "snapshot not verified");
    return held;
  }

  // The read token for a held contribution. Internal use only.
  heldToken(id: string): string {
    const held = this.store.get<Held>(`held:${id}`);
    const secret = held ? this.store.get<string>(`secret:held:${held.tokenId}`) : undefined;
    if (!secret) refuse("new-grant-required", "no token");
    return secret;
  }

  async readInput(id: string, purpose: string): Promise<{ c: Contribution; entries: Entry[] }> {
    const c = this.requireRecord(id);
    const own = this.record(id)!.own;
    this.requireUsable(id, purpose);
    const token = own ? (await this.host.mint(c.body.repo, "read", 60_000)).secret : this.heldToken(id);
    const entries = await this.host.snapshot(c.body.repo, c.body.commit, token);
    verifySnapshot(c, entries);
    return { c, entries };
  }

  // ---------- reliance ----------

  // Registers reliance with the owner and reads its current state in one
  // owner-side step. Unknown state leaves the reliance pending.
  async rely(id: string, relation: Input["relation"], purpose: string): Promise<"current" | "pending"> {
    const c = this.requireRecord(id);
    const owner = this.peers().get(c.body.org);
    if (!owner) refuse("not-authorized", "owner not pinned");
    this.store.put(`rely:${id}`, { state: "pending", owner: owner.org, at: this.now() });
    const eventId = randomId();
    const env = await this.sealEvent({ id: eventId, kind: "rely", to: owner.org, payload: { target: id, relation, purpose, rev: this.status(id).rev } });
    let reply: Envelope;
    try {
      reply = await this.transport.request(owner, env);
      reply = await this.openEnvelope(reply);
    } catch (e) {
      this.store.put(`rely:${id}`, { state: "pending", owner: owner.org, at: this.now(), error: String((e as Error).message ?? e) });
      this.log({ type: "rely.pending", id, owner: owner.org });
      return "pending";
    }
    const p = reply.payload as { request: string; target: string; rev: number; withdrawn: Cause | null; replacedBy: string[] };
    if (reply.kind !== "rely" || reply.issuer !== owner.org || p.request !== eventId || p.target !== id || !Number.isSafeInteger(p.rev)) {
      this.store.put(`rely:${id}`, { state: "pending", owner: owner.org, at: this.now(), error: "bad reply" });
      return "pending";
    }
    const events = this.eventTransaction(() => {
      const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
      this.store.put(`rely:${id}`, { state: "current", owner: owner.org, at: this.now(), rev: p.rev });
      const st = this.status(id);
      if (p.rev <= st.rev && st.rev > 0) return out;   // keep the newer state we already hold
      st.rev = Math.max(st.rev, p.rev);
      if (p.withdrawn && !st.withdrawn) {
        st.withdrawn = { ...p.withdrawn, event: reply.id };
        this.store.put(`status:${id}`, st);
        this.applyChange(st.withdrawn, id, true, out);
      }
      for (const rep of p.replacedBy ?? []) if (!st.replacedBy.includes(rep)) st.replacedBy.push(rep);
      this.store.put(`status:${id}`, st);
      return out;
    });
    await this.enqueue(events);
    this.log({ type: "rely.registered", id, owner: owner.org, rev: p.rev, relation, purpose });
    return "current";
  }

  // ---------- approval and the ship gate ----------

  private binding(c: Contribution): string {
    return canonical({ id: c.id, commit: c.body.commit, root: c.body.content.root, inputs: c.body.inputs, base: c.body.base });
  }

  async approve(actorName: string, id: string): Promise<Approval> {
    this.person(actorName);
    const r = this.record(id);
    if (!r) refuse("not-authorized", "unknown contribution");
    if (!r.verified) refuse("not-authorized", "snapshot not verified");
    const approval: Approval = { id, actor: actorName, binding: this.binding(r.c), at: this.now() };
    const reliance = [...new Set([...this.inputClosure(id), id])].filter(input => !this.record(input)?.own);
    const events = this.eventTransaction(() => {
      this.store.put(`approval:${id}`, approval);
      for (const input of reliance) this.store.put(`rely:${input}`, { state: "pending", owner: this.requireRecord(input).body.org, at: this.now() });
      return r.own ? [] : [{ to: r.c.body.org, kind: "signoff" as const, payload: { id, actor: actorName } }];
    });
    this.log({ type: "approval.recorded", id, line: r.c.body.line, version: r.c.body.version, actor: actorName });
    for (const input of reliance) await this.rely(input, "builds-on", "integrate");
    await this.enqueue(events);
    void this.flush();
    return approval;
  }

  mainLog(): MainEntry[] {
    return this.store.get<MainEntry[]>("main") ?? [];
  }

  setMainBase(head: string): void {
    if (this.mainLog().length) refuse("invalid-request", "main already set");
    this.store.put("main", [{ head, id: null, files: [] }]);
  }

  gate(id: string): Check[] {
    const checks: Check[] = [];
    const r = this.record(id);
    if (!r) return [{ name: "signature", ok: false, code: "not-authorized", reason: "unknown contribution" }];
    const c = r.c;
    checks.push({ name: "signature", ok: true, reason: `record signed by ${c.body.org}` });
    checks.push(r.verified
      ? { name: "content", ok: true, reason: `BLAKE3 root ${c.body.content.root.slice(0, 12)} verified` }
      : { name: "content", ok: false, code: "not-authorized", reason: "snapshot not verified" });
    if (r.own) checks.push({ name: "release", ok: true, reason: "own contribution" });
    else {
      const held = this.store.get<Held>(`held:${id}`);
      if (!held) checks.push({ name: "release", ok: false, code: "new-grant-required", reason: "not released to the integrator" });
      else if (held.expires <= this.now()) checks.push({ name: "release", ok: false, code: "lease-expired", reason: "release expired" });
      else if (!held.purposes.includes("integrate")) checks.push({ name: "release", ok: false, code: "new-grant-required", reason: "release does not cover integrate" });
      else checks.push({ name: "release", ok: true, reason: `released by ${held.from} for ${held.purposes.join(", ")}` });
    }
    if (!r.own) {
      const reliance = this.store.get<{ state: string }>(`rely:${id}`);
      checks.push(reliance?.state === "current"
        ? { name: "reliance", ok: true, reason: "candidate owner state confirmed" }
        : { name: "reliance", ok: false, code: "not-authorized", reason: "candidate owner state unknown" });
    }
    const e = this.effective(id);
    const missing = c.body.inputs.filter(i => i.relation === "builds-on" && !this.record(i.id));
    const pending = c.body.inputs.filter(i => i.relation === "builds-on" && !this.record(i.id)?.own && this.store.get<{ state: string }>(`rely:${i.id}`)?.state === "pending");
    if (e.code) checks.push({ name: "inputs", ok: false, code: e.code, reason: e.via ? `input ${this.label(e.via)} is ${e.code}: ${e.cause?.reason ?? ""}` : `${e.code}: ${e.cause?.reason ?? ""}` });
    else if (missing.length) checks.push({ name: "inputs", ok: false, code: "not-authorized", reason: `input record unknown: ${missing.map(i => i.id.slice(0, 12)).join(", ")}` });
    else if (pending.length) checks.push({ name: "inputs", ok: false, code: "not-authorized", reason: `owner state unknown for ${pending.map(i => this.label(i.id)).join(", ")}` });
    else {
      try {
        this.requireInputGrants(id, new Set());
        checks.push({ name: "inputs", ok: true, reason: `${c.body.inputs.length} declared inputs in force` });
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        checks.push({ name: "inputs", ok: false, code: error.code as RefusalCode, reason: error.detail });
      }
    }
    const approval = this.store.get<Approval>(`approval:${id}`);
    if (!approval) checks.push({ name: "approval", ok: false, code: "human-required", reason: "no sign-off" });
    else if (approval.binding !== this.binding(c)) checks.push({ name: "approval", ok: false, code: "human-required", reason: "sign-off covers another version" });
    else checks.push({ name: "approval", ok: true, reason: `signed off by ${approval.actor}` });
    checks.push(this.baseCheck(c));
    return checks;
  }

  private inputClosure(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    seen.add(id);
    return (this.record(id)?.c.body.inputs ?? []).filter(i => i.relation === "builds-on").flatMap(i => [i.id, ...this.inputClosure(i.id, seen)]);
  }

  private requireInputGrants(id: string, seen: Set<string>): void {
    if (seen.has(id)) return;
    seen.add(id);
    const c = this.requireRecord(id);
    for (const input of c.body.inputs) {
      if (input.relation !== "builds-on") continue;
      const r = this.record(input.id);
      if (!r) refuse("not-authorized", `input record unknown: ${input.id.slice(0, 12)}`);
      this.requireUsable(input.id, "integrate");
      if (!r.own && this.store.get<{ state: string }>(`rely:${input.id}`)?.state !== "current") {
        refuse("not-authorized", `owner state unknown for ${this.label(input.id)}`);
      }
      this.requireInputGrants(input.id, seen);
    }
  }

  // stale-base: main changed a file that this candidate also changes, after
  // the candidate's base. This holds even when Git could merge the text.
  private baseCheck(c: Contribution): Check {
    const log = this.mainLog();
    const at = log.findIndex(m => m.head === c.body.base);
    if (at < 0) return { name: "base", ok: false, code: "stale-base", reason: "base is not on main" };
    const later = log.slice(at + 1);
    const touched = new Set(later.flatMap(m => m.files));
    const clash = c.body.files.filter(f => touched.has(f));
    if (clash.length) return { name: "base", ok: false, code: "stale-base", reason: `main changed ${clash.join(", ")} after this base` };
    return { name: "base", ok: true, reason: later.length ? `${later.length} later merges touch other files` : "based on the current head" };
  }

  label(id: string): string {
    const r = this.record(id);
    return r ? `${r.c.body.line}${r.c.body.version > 1 ? ` v${r.c.body.version}` : ""}` : id.slice(0, 12);
  }

  async ship(actorName: string, id: string): Promise<ShipOp> {
    this.person(actorName);
    if (this.config.org !== this.config.integrator) refuse("not-authorized", "only the integrator ships");
    const c = this.requireRecord(id);
    const opId = randomId();
    const decided = this.store.transaction(() => {
      if (this.store.get(`shipped:${id}`)) refuse("invalid-request", "already shipped");
      const checks = this.gate(id);
      const failed = checks.find(x => !x.ok);
      const log = this.mainLog();
      const op: ShipOp = { id: opId, contribution: id, expectedHead: log.at(-1)!.head, state: failed ? "refused" : "pending", code: failed?.code, at: this.now() };
      this.store.put(`op:${opId}`, op);
      return { op, checks };
    });
    this.log({ type: "gate.decided", id, line: c.body.line, version: c.body.version, op: opId, ok: decided.op.state === "pending", checks: decided.checks });
    if (decided.op.state === "refused") return decided.op;
    const op = decided.op;
    const writeToken = await this.host.mint(this.config.integrationRepo, "write", 120_000);
    const sourceToken = this.record(id)!.own ? (await this.host.mint(c.body.repo, "read", 120_000)).secret : this.heldToken(id);
    const note = canonical({ kyoei: "ship/1", op: opId, contribution: id, line: c.body.line, version: c.body.version, approvedBy: this.store.get<Approval>(`approval:${id}`)?.actor, checks: decided.checks.map(x => `${x.name}:${x.ok ? "ok" : x.code}`) });
    let result;
    try {
      result = await this.host.merge(this.config.integrationRepo, writeToken.secret, c.body.repo, sourceToken, c.body.commit, op.expectedHead, note);
    } catch (e) {
      // The Git outcome is unknown. Keep the operation unresolved.
      const unresolved = { ...op, state: "unresolved" as const };
      this.store.put(`op:${opId}`, unresolved);
      this.log({ type: "ship.unresolved", id, op: opId, error: String((e as Error).message) });
      return unresolved;
    } finally {
      await this.host.revoke(writeToken.id);
    }
    return this.finishShip(op, c, result);
  }

  private finishShip(op: ShipOp, c: Contribution, result: Awaited<ReturnType<RepoHost["merge"]>>): ShipOp {
    return this.store.transaction(() => {
      if (result.status === "merged") {
        const done: ShipOp = { ...op, state: "merged", head: result.head };
        this.store.put(`op:${op.id}`, done);
        this.store.put(`shipped:${op.contribution}`, { head: result.head, at: this.now(), op: op.id });
        this.store.put("main", [...this.mainLog(), { head: result.head, id: op.contribution, files: c.body.files }]);
        this.closeResolvedNotices();
        this.log({ type: "ship.merged", id: op.contribution, line: c.body.line, version: c.body.version, org: c.body.org, head: result.head });
        return done;
      }
      const refused: ShipOp = { ...op, state: "refused", code: "stale-base", head: result.head };
      this.store.put(`op:${op.id}`, refused);
      this.log({ type: "ship.refused", id: op.contribution, line: c.body.line, code: "stale-base", git: result.status });
      return refused;
    });
  }

  // Reconciles an unresolved ship operation with the actual ref state.
  async reconcile(opId: string): Promise<ShipOp> {
    const op = this.store.get<ShipOp>(`op:${opId}`);
    if (!op) refuse("invalid-request", "unknown operation");
    if (op.state !== "unresolved") return op;
    const token = await this.host.mint(this.config.integrationRepo, "read", 60_000);
    try {
      const head = await this.host.head(this.config.integrationRepo, token.secret);
      if (head === op.expectedHead) {
        const refused = { ...op, state: "refused" as const, code: "stale-base" as const };
        this.store.put(`op:${opId}`, { ...refused, code: undefined, state: "refused" });
        this.log({ type: "ship.reconciled", op: opId, result: "not-merged" });
        return { ...op, state: "refused" };
      }
      const note = await this.host.readNote(this.config.integrationRepo, token.secret, head);
      if (note && note.includes(`"op":"${opId}"`)) {
        const c = this.requireRecord(op.contribution);
        this.log({ type: "ship.reconciled", op: opId, result: "merged" });
        return this.finishShip(op, c, { status: "merged", head });
      }
      return op;   // Still unknown: another change moved the head.
    } finally {
      await this.host.revoke(token.id);
    }
  }

  // ---------- withdrawal, challenge, dissent ----------

  async withdraw(actorName: string, id: string, reason: string): Promise<{ revoked: number; failed: number }> {
    this.person(actorName);
    const r = this.record(id);
    if (!r || !r.own) refuse("not-authorized", "only the owner withdraws");
    const cause = await digest("kyoei-cause-v1", { kind: "withdraw", record: id, at: this.now(), nonce: randomId(8) });
    const grants = this.grants(id).filter(g => !g.revoked);
    const events = this.eventTransaction(() => {
      const st = this.status(id);
      if (st.withdrawn) refuse("withdrawn", "already withdrawn");
      st.rev += 1;
      st.withdrawn = { cause, event: cause, kind: "withdraw", org: this.config.org, target: id, reason, at: this.now() };
      this.store.put(`status:${id}`, st);
      for (const g of grants) {
        const grantKey = `grant:${id}:${g.to}:${g.tokenId}`;
        this.store.put(grantKey, { ...g, revoked: true });
        this.store.put(`revoke:${g.tokenId}`, { grantKey, tokenId: g.tokenId, next: this.now(), expires: Math.max(g.expires, this.now() + 60_000) } satisfies Revocation);
      }
      const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
      for (const to of this.audience(id)) out.push({ to, kind: "withdraw", payload: { target: id, cause, reason, rev: st.rev } });
      this.applyChange(st.withdrawn, id, true, out);
      return out;
    });
    let revoked = 0;
    let failed = 0;
    for (const g of grants) {
      const ok = await this.host.revoke(g.tokenId).catch(() => false);
      if (ok) revoked += 1; else failed += 1;
      this.store.transaction(() => {
        this.store.put(`grant:${id}:${g.to}:${g.tokenId}`, { ...g, revoked: true, revokeResult: ok ? "revoked" : "failed" });
        if (ok) this.store.delete(`revoke:${g.tokenId}`);
        else {
          const retry = this.store.get<Revocation>(`revoke:${g.tokenId}`);
          if (retry) this.store.put(`revoke:${g.tokenId}`, { ...retry, next: this.now() + 30_000 });
        }
      });
    }
    await this.enqueue(events);
    this.log({ type: "withdraw.issued", id, line: r.c.body.line, actor: actorName, reason, cause, tokens_revoked: revoked, tokens_failed: failed, to: this.audience(id) });
    await this.flush();
    return { revoked, failed };
  }

  async challenge(actorName: string, id: string, reason: string): Promise<string> {
    this.person(actorName);
    const c = this.requireRecord(id);
    const cause = await digest("kyoei-cause-v1", { kind: "challenge", record: id, by: this.config.org, at: this.now(), nonce: randomId(8) });
    const root: Cause = { cause, event: cause, kind: "challenge", org: this.config.org, target: id, reason, at: this.now() };
    if (c.body.org === this.config.org) {
      const events = this.eventTransaction(() => this.ownerChallenge(root));
      await this.enqueue(events);
    } else {
      const events = this.eventTransaction(() => {
        const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
        this.applyChange(root, id, false, out);
        out.push({ to: c.body.org, kind: "challenge", payload: { target: id, cause, challenger: this.config.org, reason } });
        return out;
      });
      await this.enqueue(events);
    }
    this.log({ type: "challenge.issued", id, line: c.body.line, actor: actorName, cause, reason });
    void this.flush();
    return cause;
  }

  private ownerChallenge(root: Cause): { to: string; kind: EventKind; payload: Record<string, unknown> }[] {
    const st = this.status(root.target);
    if (st.challenges.some(x => x.cause === root.cause)) return [];
    st.rev += 1;
    st.challenges.push(root);
    this.store.put(`status:${root.target}`, st);
    const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
    for (const to of this.audience(root.target)) {
      if (to === root.org) continue;
      out.push({ to, kind: "challenge", payload: { target: root.target, cause: root.cause, challenger: root.org, reason: root.reason } });
    }
    this.applyChange(root, root.target, false, out);
    return out;
  }

  async dissent(actorName: string, cause: string, text: string): Promise<void> {
    this.person(actorName);
    const notices = this.notices().filter(n => n.source.event === cause);
    if (!notices.length) refuse("invalid-request", "no notice for that cause");
    const entry = { org: this.config.org, actor: actorName, text };
    const events = this.eventTransaction(() => {
      for (const n of notices) this.store.put(`notice:${n.id}`, { ...n, dissent: [...n.dissent, entry] });
      const orgs = new Set(notices.map(n => n.source.org).filter(org => org !== this.config.org && this.peers().has(org)));
      return [...orgs].map(to => ({ to, kind: "dissent" as const, payload: { cause, actor: actorName, text } }));
    });
    await this.enqueue(events);
    this.log({ type: "dissent.recorded", cause, actor: actorName });
    void this.flush();
  }

  // Computes this node's affected and notice-only sets for a change to
  // `target`, writes notices and queues forwarding events. Runs inside a
  // transaction.
  private applyChange(cause: Cause, target: string, blocking: boolean, out: { to: string; kind: EventKind; payload: Record<string, unknown> }[]): void {
    const own = this.ownRecords();
    const affected: Contribution[] = [];
    const noticeOnly: Contribution[] = [];
    for (const x of own) {
      if (x.id === target) { if (cause.org !== this.config.org) affected.push(x); continue; }
      if (this.reaches(x.id, target)) affected.push(x);
      else if (x.body.inputs.some(i => i.id === target && (i.relation === "cites" || i.relation === "challenges"))) noticeOnly.push(x);
    }
    for (const x of affected) this.openNotice(cause, x.id, x, blocking);
    for (const x of noticeOnly) this.openNotice(cause, x.id, x, false);
    if (this.config.org === this.config.integrator) {
      for (const [key] of this.store.list("shipped:")) {
        const sid = key.slice("shipped:".length);
        if (sid === target || this.reaches(sid, target)) this.openNotice(cause, `main:${sid}`, this.requireRecord(sid), blocking);
      }
    }
    for (const x of affected) {
      if (x.id === target) continue;
      const fwd = `fwd:${cause.cause}:${x.id}`;
      if (this.store.get(fwd)) continue;
      this.store.put(fwd, true);
      const code: RefusalCode = cause.kind === "withdraw" || cause.kind === "withdraw-local" || (cause.kind === "blocked" && this.effective(x.id).code === "withdrawn") ? "withdrawn" : "replacement-required";
      for (const to of this.audience(x.id)) {
        if (blocking) out.push({ to, kind: "blocked", payload: { item: x.id, cause: cause.cause, code: this.effective(x.id).code ?? code, reason: cause.reason, origin: cause.org } });
        else out.push({ to, kind: "affected", payload: { item: x.id, cause: cause.cause, reason: cause.reason, origin: cause.org, evidence: "withheld" } });
      }
    }
    this.closeResolvedNotices();
    this.log({ type: "affected.computed", cause: cause.cause, kind: cause.kind, target, blocking, affected: affected.map(x => x.id), notice_only: noticeOnly.map(x => x.id) });
  }

  private openNotice(cause: Cause, item: string, c: Contribution, blocking: boolean): void {
    const id = `${cause.cause.slice(0, 16)}:${item}`;
    if (this.store.get(`notice:${id}`)) return;
    const notice: Notice = {
      id,
      item,
      evidence: { commit: c.body.commit, record: c.id, content: c.body.content.root },
      source: { event: cause.cause, kind: cause.kind, org: cause.org, target: cause.target, reason: cause.reason, ...(cause.evidence ? { evidence: cause.evidence } : {}) },
      act: this.people(),
      dissent: [],
      repairs: blocking ? ["rebase", "withdraw", "dissent"] : ["dissent"],
      blocking,
      state: "open",
      opened: this.now(),
    };
    this.store.put(`notice:${id}`, notice);
    this.log({ type: "notice.opened", notice: id, item, line: c.body.line, version: c.body.version, blocking, cause: cause.cause, kind: cause.kind });
  }

  notices(): Notice[] {
    return this.store.list<Notice>("notice:").map(([, n]) => n);
  }

  // A blocking notice closes when a newer version of the same line is in
  // force (and, at the integrator, shipped). The old version stays blocked.
  private closeResolvedNotices(): void {
    for (const n of this.notices()) {
      if (n.state !== "open" || !n.blocking) continue;
      const main = n.item.startsWith("main:");
      const old = this.record(main ? n.item.slice(5) : n.item);
      if (!old) continue;
      const successors = this.store.list<{ c: Contribution }>("c:").map(([, r]) => r.c).filter(x =>
        x.body.org === old.c.body.org && x.body.line === old.c.body.line && x.body.version > old.c.body.version && !this.effective(x.id).code);
      const resolved = main ? successors.some(x => this.store.get(`shipped:${x.id}`)) : successors.length > 0;
      if (resolved) {
        this.store.put(`notice:${n.id}`, { ...n, state: "closed", closed: this.now() });
        this.log({ type: "notice.closed", notice: n.id, item: n.item });
      }
    }
  }

  // ---------- repairs and alternatives ----------

  alternatives(item: string): { id: string; org: string; line: string; version: number; provides: string[]; kind: "replacement" | "alternative" }[] {
    const c = this.requireRecord(item);
    const blockedInputs = c.body.inputs.filter(i => i.relation === "builds-on" && this.effective(i.id).code);
    const out = [];
    for (const input of blockedInputs) {
      const target = this.record(input.id);
      const provides = target?.c.body.provides ?? [];
      const st = this.status(input.id);
      for (const [, r] of this.store.list<{ c: Contribution; own: boolean; verified: boolean }>("c:")) {
        if (r.c.id === input.id || r.c.id === item || this.effective(r.c.id).code || !r.verified) continue;
        if (!r.own) {
          const held = this.store.get<Held>(`held:${r.c.id}`);
          if (!held || held.expires <= this.now() || !held.purposes.includes("contribute")) continue;
        }
        const replacement = st.replacedBy.includes(r.c.id);
        const shared = r.c.body.provides.filter(p => provides.includes(p));
        if (!replacement && !shared.length) continue;
        out.push({ id: r.c.id, org: r.c.body.org, line: r.c.body.line, version: r.c.body.version, provides: r.c.body.provides, kind: replacement ? "replacement" as const : "alternative" as const });
      }
    }
    return out;
  }

  // Plans a rebase repair. The repair is a new version of the same line with
  // revised inputs on the current base. It needs fresh approval to ship.
  planRepair(actorName: string, item: string, onto: string | null, from: string | null): RepairPlan {
    this.person(actorName);
    const r = this.record(item);
    if (!r || !r.own) refuse("not-authorized", "only the owner repairs its work");
    let inputs = r.c.body.inputs.filter(i => i.relation !== "supersedes");
    if (onto) {
      this.requireUsable(onto, "contribute");
      const replaced = from ?? inputs.find(i => i.relation === "builds-on" && this.effective(i.id).code)?.id ?? null;
      if (!replaced || !inputs.some(i => i.id === replaced)) refuse("invalid-request", "nothing to replace");
      inputs = inputs.map(i => (i.id === replaced ? { id: onto, relation: "builds-on" } : i));
      from = replaced;
    } else {
      const blocked = inputs.filter(i => i.relation === "builds-on" && this.effective(i.id).code);
      if (blocked.length) refuse("replacement-required", `choose a replacement for ${blocked.map(i => this.label(i.id)).join(", ")}`);
    }
    for (const i of inputs) if (i.relation === "builds-on" && this.effective(i.id).code) refuse(this.effective(i.id).code!, `input ${this.label(i.id)} still blocked`);
    const versions = this.ownRecords().filter(x => x.body.line === r.c.body.line).map(x => x.body.version);
    this.log({ type: "repair.planned", item, line: r.c.body.line, onto, from, actor: actorName });
    return { item, line: r.c.body.line, version: Math.max(...versions) + 1, inputs, files: r.c.body.files, task: r.c.body.task, provides: r.c.body.provides, onto, from };
  }

  // ---------- inbound events ----------

  async openEnvelope(raw: unknown): Promise<Envelope> {
    return openEnvelope(raw, {
      self: this.config.org,
      deployment: this.config.deployment,
      collaborations: new Set([this.config.collaboration]),
      peers: this.peers(),
      now: this.now(),
    });
  }

  async receive(raw: unknown): Promise<Receipt> {
    const e = await this.openEnvelope(raw);
    if (e.kind === "rely") refuse("invalid-request", "rely uses the request path");
    const payloadDigest = await digest("kyoei-event-v1", { kind: e.kind, issuer: e.issuer, payload: e.payload });
    const prior = this.store.get<{ digest: string; receipt: Receipt }>(`inbox:${e.issuer}:${e.id}`);
    if (prior) {
      if (prior.digest !== payloadDigest) refuse("conflict", "event ID reused with another payload");
      return { ...prior.receipt, status: "duplicate" };
    }
    const prepared = await this.prepare(e);
    const events = this.eventTransaction(() => {
      const again = this.store.get<{ digest: string; receipt: Receipt }>(`inbox:${e.issuer}:${e.id}`);
      if (again) return null;
      const out: { to: string; kind: EventKind; payload: Record<string, unknown> }[] = [];
      this.apply(e, prepared, out);
      const receipt: Receipt = { event: e.id, org: this.config.org, status: "applied" };
      this.store.put(`inbox:${e.issuer}:${e.id}`, { digest: payloadDigest, receipt, at: this.now() });
      return out;
    });
    if (events === null) return { event: e.id, org: this.config.org, status: "duplicate" };
    await this.enqueue(events);
    this.log({ type: "event.received", kind: e.kind, from: e.issuer, event: e.id });
    void this.flush();
    return { event: e.id, org: this.config.org, status: "applied" };
  }

  // Async checks before the transaction: record signatures and snapshots.
  private async prepare(e: Envelope): Promise<{ contribution?: Contribution; verified?: boolean }> {
    if (e.kind !== "release") return {};
    const p = e.payload as { contribution: unknown; token: { secret: string; remote?: unknown } };
    const peer = this.peers().get(e.issuer)!;
    const c = await verifyRecord(p.contribution, peer, { deployment: this.config.deployment, collaboration: this.config.collaboration, org: e.issuer });
    if (typeof p.token?.secret !== "string") refuse("invalid-request", "release token");
    if (typeof p.token?.remote === "string" && this.host.learnRemote) this.host.learnRemote(c.body.repo, p.token.remote);
    // Already withdrawn by its owner: record it, fetch nothing.
    if (this.status(c.id).withdrawn?.org === e.issuer) return { contribution: c, verified: false };
    const entries = await this.host.snapshot(c.body.repo, c.body.commit, p.token.secret);
    verifySnapshot(c, entries);
    return { contribution: c, verified: true };
  }

  // Applies an opened event. Runs inside a transaction.
  private apply(e: Envelope, prepared: { contribution?: Contribution; verified?: boolean }, out: { to: string; kind: EventKind; payload: Record<string, unknown> }[]): void {
    const p = e.payload as Record<string, any>;
    const ownedBy = (id: unknown, org: string): Contribution => {
      if (typeof id !== "string") refuse("invalid-request", "contribution id");
      const r = this.record(id);
      if (!r) refuse("not-authorized", "unknown contribution");
      if (r.c.body.org !== org) refuse("not-authorized", `${org} does not own ${id.slice(0, 12)}`);
      return r.c;
    };
    switch (e.kind) {
      case "release": {
        const c = prepared.contribution!;
        const purposes = Array.isArray(p.purposes) ? p.purposes.filter((x: unknown) => typeof x === "string") : [];
        const expires = Number.isSafeInteger(p.expires) ? Math.min(p.expires, this.now() + MAX_RELEASE_MS) : this.now();
        const onward = Array.isArray(p.onward) ? p.onward.filter((o: any) => typeof o?.org === "string" && Array.isArray(o.purposes)) : [];
        this.store.put(`c:${c.id}`, { c, own: false, verified: prepared.verified === true });
        const held: Held = { id: c.id, from: e.issuer, purposes, expires, onward, tokenId: String(p.token.id), repo: c.body.repo, received: this.now() };
        this.store.put(`held:${c.id}`, held);
        this.store.put(`secret:held:${held.tokenId}`, String(p.token.secret));
        const st = this.status(c.id);
        // A delayed release never clears an observed withdrawal. A tombstone
        // from another issuer than the owner does not count.
        if (st.withdrawn && st.withdrawn.org !== c.body.org) delete st.withdrawn;
        st.rev = Math.max(st.rev, Number.isSafeInteger(p.rev) ? p.rev : 0);
        this.store.put(`status:${c.id}`, st);
        this.log({ type: "release.received", id: c.id, line: c.body.line, version: c.body.version, from: e.issuer, purposes, expires, content_verified: prepared.verified === true, withdrawn_before: Boolean(st.withdrawn) });
        return;
      }
      case "withdraw": {
        if (typeof p.target === "string" && !this.record(p.target)) {
          // Withdrawal before the release: keep a tombstone. A later release
          // of that record from the same owner arrives already withdrawn.
          const st = this.status(p.target);
          if (!st.withdrawn) {
            st.withdrawn = { cause: String(p.cause), event: e.id, kind: "withdraw", org: e.issuer, target: p.target, reason: String(p.reason ?? ""), at: this.now() };
            st.rev = Math.max(st.rev, Number(p.rev) || 0);
            this.store.put(`status:${p.target}`, st);
          }
          return;
        }
        const c = ownedBy(p.target, e.issuer);
        const st = this.status(c.id);
        if (st.withdrawn) return;
        st.rev = Math.max(st.rev, Number(p.rev) || 0);
        st.withdrawn = { cause: String(p.cause), event: e.id, kind: "withdraw", org: e.issuer, target: c.id, reason: String(p.reason ?? ""), at: this.now() };
        this.store.put(`status:${c.id}`, st);
        const held = this.store.get<Held>(`held:${c.id}`);
        if (held) this.store.delete(`secret:held:${held.tokenId}`);
        this.applyChange(st.withdrawn, c.id, true, out);
        return;
      }
      case "correct": {
        const c = ownedBy(p.old, e.issuer);
        const st = this.status(c.id);
        if (typeof p.replacement !== "string") refuse("invalid-request", "replacement");
        if (!st.replacedBy.includes(p.replacement)) st.replacedBy.push(p.replacement);
        st.rev = Math.max(st.rev, Number(p.rev) || 0);
        this.store.put(`status:${c.id}`, st);
        this.applyChange({ cause: String(p.cause), event: e.id, kind: "correct", org: e.issuer, target: c.id, reason: String(p.reason ?? ""), at: this.now() }, c.id, true, out);
        return;
      }
      case "blocked": {
        const c = ownedBy(p.item, e.issuer);
        const st = this.status(c.id);
        if (st.blocked.some(b => b.cause === p.cause)) return;
        const code: RefusalCode = p.code === "withdrawn" ? "withdrawn" : "replacement-required";
        const cause = { cause: String(p.cause), event: e.id, kind: "blocked" as const, org: String(p.origin ?? e.issuer), target: c.id, reason: String(p.reason ?? ""), at: this.now(), code, item: c.id };
        st.blocked.push(cause);
        this.store.put(`status:${c.id}`, st);
        this.applyChange(cause, c.id, true, out);
        return;
      }
      case "affected": {
        if (p.evidence !== "withheld") refuse("invalid-request", "affected evidence must be marked withheld");
        const c = ownedBy(p.item, e.issuer);
        this.applyChange({ cause: String(p.cause), event: e.id, kind: "affected", org: String(p.origin ?? e.issuer), target: c.id, reason: String(p.reason ?? ""), at: this.now(), evidence: "withheld" }, c.id, false, out);
        return;
      }
      case "challenge": {
        if (typeof p.target !== "string") refuse("invalid-request", "target");
        const r = this.record(p.target);
        if (!r) refuse("not-authorized", "unknown contribution");
        const root: Cause = { cause: String(p.cause), event: e.id, kind: "challenge", org: String(p.challenger ?? e.issuer), target: p.target, reason: String(p.reason ?? ""), at: this.now() };
        if (r.own) {
          if (root.org !== e.issuer) refuse("not-authorized", "challenger must send its own challenge");
          out.push(...this.ownerChallenge(root));
        } else {
          if (r.c.body.org !== e.issuer) refuse("not-authorized", "only the owner forwards a challenge");
          this.applyChange(root, p.target, false, out);
        }
        return;
      }
      case "dissent": {
        const entry = { org: e.issuer, actor: String(p.actor ?? ""), text: String(p.text ?? "").slice(0, 2000) };
        for (const n of this.notices()) if (n.source.event === p.cause) this.store.put(`notice:${n.id}`, { ...n, dissent: [...n.dissent, entry] });
        this.store.put(`dissent:${e.issuer}:${e.id}`, { ...entry, cause: p.cause });
        return;
      }
      case "intent": {
        if (this.config.org !== this.config.integrator) refuse("not-authorized", "intents go to the integrator");
        if (p.org !== e.issuer) refuse("not-authorized", "intent from another organization");
        const intent: Intent = { org: e.issuer, agent: String(p.agent), line: String(p.line), files: Array.isArray(p.files) ? p.files.map(String) : [], task: String(p.task ?? ""), state: p.state === "closed" ? "closed" : "open", at: this.now() };
        out.push(...this.acceptIntent(intent));
        return;
      }
      case "overlap": {
        if (e.issuer !== this.config.integrator) refuse("not-authorized", "overlaps come from the integrator");
        this.store.put(`overlap:${String(p.id)}`, p);
        this.log({ type: "overlap.received", id: p.id, files: p.files });
        return;
      }
      case "signoff": {
        const c = ownedBy(p.id, this.config.org);
        this.store.put(`signoff:${c.id}:${e.issuer}`, { org: e.issuer, actor: String(p.actor), at: this.now() });
        return;
      }
      default:
        refuse("invalid-request", "kind");
    }
  }

  // Owner side of reliance: register the subscriber and read the state in one
  // transaction, then sign the reply.
  async answerRely(raw: unknown): Promise<Envelope> {
    const e = await this.openEnvelope(raw);
    if (e.kind !== "rely") refuse("invalid-request", "kind");
    const p = e.payload as { target: string; relation: string; purpose: string };
    const state = this.store.transaction(() => {
      const r = this.record(p.target);
      if (!r || !r.own) refuse("not-authorized", "not the owner");
      const st = this.status(p.target);
      const granted = this.grants(p.target).some(g => g.to === e.issuer && g.purposes.includes(p.purpose) && ((!g.revoked && g.expires > this.now()) || (g.revoked && Boolean(st.withdrawn))));
      if (!granted) refuse("new-grant-required", "not released");
      const subs = new Set(this.store.get<string[]>(`subs:${p.target}`) ?? []);
      subs.add(e.issuer);
      this.store.put(`subs:${p.target}`, [...subs].sort());
      return { rev: st.rev, withdrawn: st.withdrawn ?? null, replacedBy: st.replacedBy };
    });
    this.log({ type: "rely.answered", id: p.target, from: e.issuer, rev: state.rev, relation: p.relation });
    return this.sealEvent({ id: randomId(), kind: "rely", to: e.issuer, payload: { request: e.id, target: p.target, ...state } });
  }

  // ---------- outbox ----------

  private async sealEvent(input: { id: string; kind: EventKind; to: string; payload: Record<string, unknown> }): Promise<Envelope> {
    return seal(this.requireKey(), {
      deployment: this.config.deployment,
      collaboration: this.config.collaboration,
      id: input.id,
      kind: input.kind,
      issuer: this.config.org,
      audience: input.to,
      payload: input.payload,
      now: this.now(),
      ttlMs: ENVELOPE_TTL_MS,
    });
  }

  private persistEvents(events: QueuedEvent[]): void {
    for (const event of events) {
      if (!this.store.get(`peer:${event.to}`)) continue;
      event.id ??= randomId();
      event.created ??= this.now();
      if (!this.store.get(`outbox:${event.id}`)) this.store.put(`pending-event:${event.id}`, event);
    }
  }

  private eventTransaction<T extends QueuedEvent[] | null>(fn: () => T): T {
    return this.store.transaction(() => {
      const events = fn();
      if (events) this.persistEvents(events);
      return events;
    });
  }

  private async enqueue(events: QueuedEvent[]): Promise<void> {
    this.store.transaction(() => this.persistEvents(events));
    await this.prepareOutbox();
  }

  private async prepareOutbox(): Promise<void> {
    if (this.preparing) return this.preparing;
    const run = async () => {
      await Promise.resolve();
      try {
        for (const [key, ev] of this.store.list<QueuedEvent & { id: string }>("pending-event:")) {
          const envelope = await this.sealEvent({ id: ev.id, kind: ev.kind, to: ev.to, payload: ev.payload });
          this.store.transaction(() => {
            if (!this.store.get(key)) return;
            const entry: OutboxEntry = { key: `outbox:${ev.id}`, to: ev.to, envelope, attempts: 0, next: this.now(), created: ev.created ?? this.now() };
            if (!this.store.get(entry.key)) this.store.put(entry.key, entry);
            this.store.delete(key);
          });
          this.log({ type: "event.queued", kind: ev.kind, to: ev.to, event: ev.id });
        }
      } finally {
        this.preparing = null;
      }
    };
    this.preparing = run();
    return this.preparing;
  }

  nextDelivery(): number | null {
    if (this.store.list("pending-event:").length) return this.now();
    const next = [...this.outbox().filter(e => !e.failed).map(e => e.next), ...this.store.list<Revocation>("revoke:").map(([, r]) => r.next)];
    return next.length ? Math.min(...next) : null;
  }

  private recoverClaims(): void {
    for (const [key, entry] of this.store.list<OutboxEntry>("outbox:")) {
      if (entry.claimed && entry.claimed < this.now() - CLAIM_LEASE_MS) this.store.put(key, { ...entry, claimed: undefined });
    }
  }

  outbox(): OutboxEntry[] {
    return this.store.list<OutboxEntry>("outbox:").map(([, e]) => e);
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = async () => {
      await Promise.resolve();
      try {
        for (let round = 0; round < 8; round++) {
          await this.prepareOutbox();
          this.recoverClaims();
          const due = this.outbox().filter(e => !e.failed && !e.claimed && e.next <= this.now());
          if (!due.length) { await this.retryRevocations(); return; }
          await Promise.all(due.map(entry => this.deliverOne(entry)));
        }
        await this.retryRevocations();
      } finally {
        this.flushing = null;
      }
    };
    this.flushing = run();
    return this.flushing;
  }

  private async retryRevocations(): Promise<void> {
    for (const [key, retry] of this.store.list<Revocation>("revoke:")) {
      if (retry.expires <= this.now()) { this.store.delete(key); continue; }
      if (retry.next > this.now()) continue;
      const ok = await this.host.revoke(retry.tokenId).catch(() => false);
      this.store.transaction(() => {
        if (!this.store.get(key)) return;
        if (ok) {
          this.store.delete(key);
          const grant = this.store.get<Grant>(retry.grantKey);
          if (grant) this.store.put(retry.grantKey, { ...grant, revokeResult: "revoked" });
        } else this.store.put(key, { ...retry, next: this.now() + 30_000 });
      });
    }
  }

  private async deliverOne(entry: OutboxEntry): Promise<void> {
    const peer = this.peers().get(entry.to);
    if (!peer) return;
    let envelope = entry.envelope;
    if (envelope.exp < this.now() + 5_000) {
      // Re-seal with the same event ID and payload.
      envelope = await this.sealEvent({ id: envelope.id, kind: envelope.kind, to: entry.to, payload: envelope.payload });
    }
    this.store.put(entry.key, { ...entry, envelope, claimed: this.now() });
    const started = this.now();
    try {
      const receipt = await this.transport.deliver(peer, envelope);
      if (receipt.event !== envelope.id || receipt.org !== entry.to) throw new DeliveryError("receipt mismatch", false);
      this.store.delete(entry.key);
      this.log({ type: "event.delivered", kind: envelope.kind, to: entry.to, event: envelope.id, status: receipt.status, ms: this.now() - entry.created, attempt: entry.attempts + 1, rtt_ms: this.now() - started });
    } catch (e) {
      const permanent = e instanceof DeliveryError && e.permanent;
      const attempts = entry.attempts + 1;
      const next = this.now() + Math.min(30_000, 250 * 2 ** attempts);
      this.store.put(entry.key, { ...entry, envelope, attempts, next, claimed: undefined, failed: permanent ? String((e as Error).message) : undefined });
      this.log({ type: permanent ? "event.refused" : "event.retry", kind: envelope.kind, to: entry.to, event: envelope.id, attempt: attempts, error: String((e as Error).message).slice(0, 200) });
    }
  }

  // ---------- console state (never contains token secrets) ----------

  state(): Record<string, unknown> {
    const contributions = this.store.list<{ c: Contribution; own: boolean; verified: boolean }>("c:").map(([, r]) => {
      const e = this.effective(r.c.id);
      return {
        id: r.c.id, org: r.c.body.org, line: r.c.body.line, version: r.c.body.version, agent: r.c.body.actor, own: r.own,
        commit: r.c.body.commit, root: r.c.body.content.root, files: r.c.body.files, provides: r.c.body.provides,
        inputs: r.c.body.inputs.map(i => ({ ...i, label: this.label(i.id) })), task: r.c.body.task, rationale: r.c.body.rationale,
        verified: r.verified, state: e.code ?? (this.store.get<{ state: string }>(`rely:${r.c.id}`)?.state === "pending" ? "pending" : "usable"), cause: e.cause?.reason ?? null,
        shipped: Boolean(this.store.get(`shipped:${r.c.id}`)), approved: Boolean(this.store.get(`approval:${r.c.id}`)),
        released: this.grants(r.c.id).map(g => ({ to: g.to, purposes: g.purposes, expires: g.expires, revoked: g.revoked, token: g.tokenId })),
        held: this.store.get<Held>(`held:${r.c.id}`) ? { from: this.store.get<Held>(`held:${r.c.id}`)!.from, purposes: this.store.get<Held>(`held:${r.c.id}`)!.purposes } : null,
        challenges: this.status(r.c.id).challenges.length,
      };
    });
    return {
      org: this.config.org,
      integrator: this.config.integrator,
      fingerprint: this.key?.fingerprint ?? null,
      contributions,
      notices: this.notices(),
      intents: this.store.list<Intent>("intent:").map(([, i]) => i),
      overlaps: this.store.list<Overlap>("overlap:").map(([, o]) => o),
      main: this.mainLog(),
      ops: this.store.list<ShipOp>("op:").map(([, o]) => o),
      outbox: this.outbox().map(e => ({ to: e.to, kind: e.envelope.kind, attempts: e.attempts, failed: e.failed ?? null })),
    };
  }

  // ---------- internals ----------

  private requireKey(): KeyPair {
    if (!this.key) throw new Error("node not initialized");
    return this.key;
  }

  private log(e: LogEvent): void {
    this.sink({ t: this.now(), org: this.config.org, ...e });
  }
}

export function noteText(c: Contribution): string {
  const b = c.body;
  const lines = [
    `kyoei-record: ${c.id}`,
    `org: ${b.org}  agent: ${b.actor}  line: ${b.line} v${b.version}`,
    `task: ${b.task}`,
    `why: ${b.rationale}`,
    ...b.inputs.map(i => `input: ${i.relation} ${i.id.slice(0, 16)}`),
    `content: ${b.content.alg} ${b.content.root}`,
    `model: ${b.model ?? "scripted"}${b.prompt ? `  prompt: ${b.prompt.slice(0, 16)}` : ""}`,
    `signed-record: ${JSON.stringify(c)}`,
  ];
  return lines.join("\n");
}

export function isRefusal(e: unknown): e is Refusal {
  return e instanceof Refusal;
}
