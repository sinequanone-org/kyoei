// Scripted edits: fixed file contents and rationale per edit key, with a
// fixed delay that stands in for model time. Runs that use them record the
// model as "scripted"; the console and the run log show that label.

import type { AgentTask, Generation, InputContext, Model } from "./run.ts";

export interface ScriptedEdit {
  files: { path: string; text: string }[];
  rationale: string;
  delayMs?: number;
}

export class ScriptedModel implements Model {
  readonly name: string | null = null;
  private readonly edits: Record<string, ScriptedEdit>;
  private readonly speed: number;

  constructor(edits: Record<string, ScriptedEdit>, speed = 1) {
    this.edits = edits;
    this.speed = speed;
  }

  async generate(task: AgentTask, _base: { path: string; text: string }[], inputs: InputContext[]): Promise<Generation> {
    const edit = this.edits[task.edit];
    if (!edit) throw new Error(`no scripted edit ${task.edit}`);
    if (edit.delayMs) await new Promise(r => setTimeout(r, edit.delayMs! * this.speed));
    const context = inputs.map(i => `${i.relation} ${i.org}/${i.line}`).join(", ");
    return { files: edit.files, rationale: edit.rationale + (context ? ` Inputs read: ${context}.` : ""), prompt: null };
  }
}
