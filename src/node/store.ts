// A synchronous key-value store with transactions. The node does all async
// work (crypto, network) before it opens a transaction, so each state change
// is atomic: a Durable Object runs it in `transactionSync`, the local node in
// one synchronous call followed by one atomic file write.

export interface Store {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  list<T>(prefix: string): [string, T][];
  transaction<T>(fn: () => T): T;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export class MemoryStore implements Store {
  protected data = new Map<string, string>();
  private pending: Map<string, string | null> | null = null;

  get<T>(key: string): T | undefined {
    if (this.pending?.has(key)) {
      const v = this.pending.get(key);
      return v == null ? undefined : (JSON.parse(v) as T);
    }
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  put(key: string, value: unknown): void {
    const text = JSON.stringify(clone(value));
    if (this.pending) this.pending.set(key, text);
    else { this.data.set(key, text); this.committed(); }
  }

  delete(key: string): void {
    if (this.pending) this.pending.set(key, null);
    else { this.data.delete(key); this.committed(); }
  }

  list<T>(prefix: string): [string, T][] {
    const keys = new Set<string>();
    for (const k of this.data.keys()) if (k.startsWith(prefix)) keys.add(k);
    if (this.pending) for (const k of this.pending.keys()) if (k.startsWith(prefix)) keys.add(k);
    const out: [string, T][] = [];
    for (const k of [...keys].sort()) {
      const v = this.get<T>(k);
      if (v !== undefined) out.push([k, v]);
    }
    return out;
  }

  transaction<T>(fn: () => T): T {
    if (this.pending) return fn();
    this.pending = new Map();
    try {
      const result = fn();
      for (const [k, v] of this.pending) {
        if (v === null) this.data.delete(k);
        else this.data.set(k, v);
      }
      this.pending = null;
      this.committed();
      return result;
    } catch (e) {
      this.pending = null;
      throw e;
    }
  }

  // Hook for persistent subclasses. Called after every committed change.
  protected committed(): void {}

  dump(): Record<string, string> {
    return Object.fromEntries(this.data);
  }

  load(entries: Record<string, string>): void {
    this.data = new Map(Object.entries(entries));
  }
}
