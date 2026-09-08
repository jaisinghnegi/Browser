import type { PlannerRequest, FillAction } from '../protocol';
export function requestValid(value: unknown): value is PlannerRequest;
export function actionValid(value: unknown): value is FillAction;
