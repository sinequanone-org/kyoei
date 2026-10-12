// Event transports. HTTP is the real one: Workers use it between
// organizations, and the local processes use it on loopback. The in-memory
// transport serializes every envelope to JSON, so a node never shares objects
// with another node.

import type { Envelope, Peer, Receipt } from "../core/types.ts";
import { DeliveryError, type OrgNode, type Transport } from "./node.ts";

export class HttpTransport implements Transport {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(fetcher: typeof fetch = fetch, timeoutMs = 10_000) {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  private async post(peer: Peer, path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetcher(new URL(path, peer.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new DeliveryError(`network: ${(e as Error).message}`, false);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) throw new DeliveryError(`http ${res.status}`, false);
    if (!res.ok) throw new DeliveryError(`refused ${res.status}: ${text.slice(0, 200)}`, true);
    return JSON.parse(text);
  }

  async deliver(peer: Peer, envelope: Envelope): Promise<Receipt> {
    return (await this.post(peer, "/kyoei/inbox", envelope)) as Receipt;
  }

  async request(peer: Peer, envelope: Envelope): Promise<Envelope> {
    return (await this.post(peer, "/kyoei/rely", envelope)) as Envelope;
  }
}

export class MemoryTransport implements Transport {
  readonly nodes = new Map<string, OrgNode>();
  // Test hooks.
  down = new Set<string>();
  dropReceipts = new Set<string>();

  async deliver(peer: Peer, envelope: Envelope): Promise<Receipt> {
    const node = this.nodes.get(peer.org);
    if (!node || this.down.has(peer.org)) throw new DeliveryError("unreachable", false);
    try {
      const receipt = await node.receive(JSON.parse(JSON.stringify(envelope)));
      if (this.dropReceipts.has(peer.org)) throw new DeliveryError("receipt lost", false);
      return JSON.parse(JSON.stringify(receipt)) as Receipt;
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      const code = (e as { code?: string }).code;
      throw new DeliveryError(String((e as Error).message), Boolean(code && code !== "unknown"));
    }
  }

  async request(peer: Peer, envelope: Envelope): Promise<Envelope> {
    const node = this.nodes.get(peer.org);
    if (!node || this.down.has(peer.org)) throw new DeliveryError("unreachable", false);
    return JSON.parse(JSON.stringify(await node.answerRely(JSON.parse(JSON.stringify(envelope))))) as Envelope;
  }
}
