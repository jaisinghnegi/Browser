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
  consume(rawAction: unknown, current: Binding): string {
    try {
      const action = parseAction(rawAction);
      if (this.secret === undefined || Date.now() >= this.expiresAt) throw new Error('Expired task');
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
import { parseAction } from './protocol';
