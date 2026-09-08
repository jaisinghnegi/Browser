import { parseAction } from './protocol';

export interface Binding {
  taskId: string; observationId: string; target: string; documentId: string;
  tabId: number; origin: string; version: number;
}
export class Task {
  readonly binding: Readonly<Binding>;
  private secret: string | undefined;
  private expiresAt: number;
  constructor(binding: Binding, secret: string, ttl = 30_000) {
    this.binding = Object.freeze({ ...binding });
    this.secret = secret;
    this.expiresAt = Date.now() + ttl;
  }
  /** The trust boundary: the only place a planner-supplied value is parsed. Callers must
   * pass the raw, unparsed response body — parsing it themselves first would run
   * `parseAction` twice on the same untrusted value for no benefit. */
  consume(rawAction: unknown, current: Binding): string {
    try {
      const action = parseAction(rawAction);
      if (this.secret === undefined || Date.now() >= this.expiresAt) throw new Error('Expired task');
      // Of these seven keys, only `version` and `documentId` can differ from the frozen
      // binding in production — tabId/taskId/observationId/target are already forced equal
      // upstream (see background.ts's current()). Kept as a full comparison anyway as
      // defense in depth: do not "simplify" this into comparing only those two fields, and
      // do not let `current` silently become `this.binding` unchanged, or freshness
      // enforcement disappears without any test failing.
      const keys = Object.keys(this.binding) as (keyof Binding)[];
      if (keys.some(key => this.binding[key] !== current[key])) throw new Error('Stale observation');
      if (action.taskId !== this.binding.taskId || action.observationId !== this.binding.observationId ||
          action.target !== this.binding.target) throw new Error('Unauthorized action');
      return this.secret;
    } finally {
      // A task permits one attempt, including failed attempts. Replays cannot resolve a value.
      this.cancel();
    }
  }
  cancel(): void { this.secret = undefined; }
}
