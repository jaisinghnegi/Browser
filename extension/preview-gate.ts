// Pure interrupt decision for the local preview build -- no DOM/model, unit-testable
// (tests/preview-gate.test.ts). Called BOTH before each region AND once more after the last
// awaited recognition + cleanup, so a final inference that crosses the deadline still rejects
// instead of publishing.
//
// This is COOPERATIVE cancellation, not a hard wall-clock execution cap: a synchronous
// onnxruntime-web WASM `session.run` cannot be preempted from this thread, so the budget only
// governs whether a *result* is published, never how long a single call may run.

export type PreviewInterrupt = 'cancelled' | 'time-budget-exceeded' | null;

export function evaluatePreviewInterrupt(aborted: boolean, elapsedMs: number, deadlineMs: number): PreviewInterrupt {
  if (aborted) return 'cancelled';
  if (elapsedMs > deadlineMs) return 'time-budget-exceeded';
  return null;
}
