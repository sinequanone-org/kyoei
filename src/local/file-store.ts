// A MemoryStore that writes one JSON file after each committed change, with
// an atomic rename, so a restarted node process resumes from its last state.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../node/store.ts";

export class FileStore extends MemoryStore {
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
    if (existsSync(path)) this.load(JSON.parse(readFileSync(path, "utf8")) as Record<string, string>);
  }

  protected override committed(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.dump()), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
