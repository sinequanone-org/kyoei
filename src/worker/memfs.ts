type Dir = { kind: "dir"; children: Set<string>; mtimeMs: number };
type File = { kind: "file"; data: Uint8Array; mtimeMs: number };
type Entry = Dir | File;

function fsError(code: string, path: string): Error {
  const error = new Error(`${code}: ${path}`) as Error & { code: string };
  error.code = code;
  return error;
}

class Stats {
  private readonly entry: Entry;
  constructor(entry: Entry) { this.entry = entry; }
  get size(): number { return this.entry.kind === "file" ? this.entry.data.byteLength : 0; }
  get mtimeMs(): number { return this.entry.mtimeMs; }
  get ctimeMs(): number { return this.entry.mtimeMs; }
  get mode(): number { return this.entry.kind === "file" ? 0o100644 : 0o040000; }
  get uid(): number { return 1; }
  get gid(): number { return 1; }
  get ino(): number { return 0; }
  get dev(): number { return 1; }
  isFile(): boolean { return this.entry.kind === "file"; }
  isDirectory(): boolean { return this.entry.kind === "dir"; }
  isSymbolicLink(): boolean { return false; }
}

/** A small in-memory file system for isomorphic-git inside a Worker. */
export class MemoryFS {
  private readonly entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.stat.bind(this),
    readlink: async (path: string): Promise<never> => { throw fsError("ENOENT", path); },
    symlink: async (_target: string, path: string): Promise<never> => { throw fsError("ENOTSUP", path); },
  };

  static normalize(input: string): string {
    const parts: string[] = [];
    for (const part of input.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  private parentOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
  }

  private nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  private get(path: string): Entry {
    const entry = this.entries.get(MemoryFS.normalize(path));
    if (!entry) throw fsError("ENOENT", path);
    return entry;
  }

  private dir(path: string): Dir {
    const entry = this.get(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
    return entry;
  }

  async mkdir(path: string): Promise<void> {
    const target = MemoryFS.normalize(path);
    if (this.entries.has(target)) throw fsError("EEXIST", path);
    const parent = this.dir(this.parentOf(target));
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    parent.children.add(this.nameOf(target));
  }

  private async ensureDir(path: string): Promise<void> {
    const target = MemoryFS.normalize(path);
    if (this.entries.has(target)) {
      this.dir(target);
      return;
    }
    await this.ensureDir(this.parentOf(target));
    await this.mkdir(target);
  }

  async writeFile(path: string, data: string | Uint8Array, _options?: unknown): Promise<void> {
    const target = MemoryFS.normalize(path);
    await this.ensureDir(this.parentOf(target));
    if (this.entries.get(target)?.kind === "dir") throw fsError("EISDIR", path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.dir(this.parentOf(target)).children.add(this.nameOf(target));
  }

  async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
    const entry = this.get(path);
    if (entry.kind !== "file") throw fsError("EISDIR", path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? new TextDecoder().decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.dir(path).children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = MemoryFS.normalize(path);
    if (this.get(target).kind !== "file") throw fsError("EISDIR", path);
    this.entries.delete(target);
    this.dir(this.parentOf(target)).children.delete(this.nameOf(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = MemoryFS.normalize(path);
    if (target === "/") throw fsError("EBUSY", path);
    if (this.dir(target).children.size > 0) throw fsError("ENOTEMPTY", path);
    this.entries.delete(target);
    this.dir(this.parentOf(target)).children.delete(this.nameOf(target));
  }

  async stat(path: string): Promise<Stats> {
    return new Stats(this.get(path));
  }

  /** Every file path under a prefix, sorted. Used to copy repos in tests. */
  files(prefix: string): string[] {
    const root = MemoryFS.normalize(prefix);
    return [...this.entries.entries()]
      .filter(([path, entry]) => entry.kind === "file" && (path === root || path.startsWith(`${root}/`)))
      .map(([path]) => path)
      .sort();
  }
}
