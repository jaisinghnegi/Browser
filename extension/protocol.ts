import { requestValid, actionValid } from './generated/validators.js';
import type { Binding } from './task';

export interface PlannerRequest {
  protocol: 1; taskId: string; observationId: string; target: string;
  fieldKind: 'shipping-address'; valueRef: 'ADDRESS_1';
}
export interface FillAction {
  action: 'fill'; actionId: string; taskId: string; observationId: string;
  target: string; valueRef: 'ADDRESS_1';
}

/** The only constructor for planner payloads. No page-controlled strings. */
export function buildPayload(binding: Binding): PlannerRequest {
  const result = {
    protocol: 1, taskId: binding.taskId, observationId: binding.observationId,
    target: binding.target, fieldKind: 'shipping-address', valueRef: 'ADDRESS_1',
  };
  if (!requestValid(result)) throw new Error('Invalid observation');
  return result;
}
export function parseAction(value: unknown): FillAction {
  if (!actionValid(value)) throw new Error('Invalid planner action');
  return value;
}
