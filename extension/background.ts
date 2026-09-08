import { buildPayload } from './protocol';
import { Task, type Binding } from './task';
import { readCapped } from './planner-io';

const FIXTURE = 'http://localhost:8171/fixture';
const PLANNER = 'http://localhost:8171/plan';
const PLANNER_BODY_LIMIT = 4096;
// Fixed, machine-checkable outcomes. Never interpolate a caught Error's message into this
// enum or into the RESULT the popup receives — that stays the one guarantee that no
// page-derived or planner-derived string reaches the popup DOM.
type Reason = 'success' | 'observation-failed' | 'field-not-visible' | 'vision-failed' |
  'stale-observation' | 'planner-action-rejected' | 'execution-rejected' | 'timeout' |
  'cancelled' | 'navigated';
class RunError extends Error { constructor(public reason: Reason, message: string) { super(message); } }
function fail(reason: Reason, message: string): never { throw new RunError(reason, message); }
type Run = {
  port: chrome.runtime.Port; abort: AbortController; timer: ReturnType<typeof setTimeout>;
  task?: Task; tabId?: number; documentId?: string; binding?: Binding;
  stage: 'observe' | 'vision' | 'plan';
};
let active: Run | undefined;
function post(run: Run, message: unknown) { try { run.port.postMessage(message); } catch { /* Closed popup. */ } }
function live(run: Run) {
  if (active !== run || run.abort.signal.aborted) fail('cancelled', 'Cancelled');
}
function finish(run: Run, status: string, reason: Reason) {
  if (active !== run) return;
  active = undefined;
  clearTimeout(run.timer);
  run.abort.abort();
  run.task?.cancel();
  if (run.binding) {
    void chrome.tabs.sendMessage(run.binding.tabId, { type: 'CANCEL', taskId: run.binding.taskId },
      { documentId: run.documentId }).catch(() => {});
  }
  post(run, { type: 'RESULT', status, reason });
}
async function current(run: Run): Promise<Binding> {
  live(run);
  const b = run.binding!;
  const tab = await chrome.tabs.get(b.tabId);
  live(run);
  if (tab.url !== FIXTURE) fail('stale-observation', 'Navigation');
  const result = await chrome.tabs.sendMessage(b.tabId, {
    type: 'CHECK', taskId: b.taskId, observationId: b.observationId, target: b.target,
  }, { documentId: run.documentId });
  live(run);
  if (!result?.ok) fail('stale-observation', 'Stale page');
  // `version` and `documentId` are the only two fields of the returned binding that can
  // ever differ from the frozen copy in production (tabId/taskId/observationId are echoed
  // back unchanged, and `target` is already forced equal by content.ts's own check()).
  // They are the live discriminators that make this a real freshness check.
  return { ...b, documentId: result.documentId, origin: result.origin, target: result.target, version: result.version };
}
async function start(run: Run) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  live(run);
  if (!tab?.id || tab.url !== FIXTURE) fail('observation-failed', 'Open the fixture');
  run.tabId = tab.id;
  const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  live(run);
  run.documentId = injected[0]?.documentId;
  if (!run.documentId) fail('observation-failed', 'Missing document binding');
  const taskId = crypto.randomUUID(), observationId = crypto.randomUUID();
  const observed = await chrome.tabs.sendMessage(tab.id, { type: 'OBSERVE', taskId, observationId }, { documentId: run.documentId });
  live(run);
  if (!observed?.ok) fail(observed?.reason === 'field-not-visible' ? 'field-not-visible' : 'observation-failed', 'Observation failed');
  if (observed.origin !== 'http://localhost:8171') fail('observation-failed', 'Unsupported observation');
  run.binding = { taskId, observationId, target: observed.target, documentId: observed.documentId,
    tabId: tab.id, origin: observed.origin, version: observed.version };
  buildPayload(run.binding); // Validate IDs before starting any capture.
  run.task = new Task(run.binding, '991 Vault Lane, Testville 00000');
  const before = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  live(run);
  if (before[0]?.id !== tab.id) fail('observation-failed', 'Tab switched');
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const after = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  live(run);
  if (after[0]?.id !== tab.id) fail('observation-failed', 'Tab switched');
  await current(run);
  run.stage = 'vision';
  post(run, { type: 'CAPTURE', taskId, screenshot });
}
async function plan(run: Run, message: { taskId: string; ok: boolean }) {
  live(run);
  if (run.stage !== 'vision' || message.taskId !== run.binding?.taskId || message.ok !== true) {
    fail('vision-failed', 'Vision failed');
  }
  run.stage = 'plan';
  const observed = await current(run);
  if (observed.version !== run.binding!.version || observed.documentId !== run.binding!.documentId ||
      observed.target !== run.binding!.target || observed.origin !== run.binding!.origin) fail('stale-observation', 'Stale observation');
  const payload = buildPayload(run.binding!);
  post(run, { type: 'PAYLOAD', payload });
  // The only external request in the extension; redirects and credentials are forbidden.
  const response = await fetch(PLANNER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: run.abort.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  live(run);
  if (!response.ok) fail('planner-action-rejected', 'Planner unavailable');
  const text = await readCapped(response, PLANNER_BODY_LIMIT).catch(() => fail('planner-action-rejected', 'Oversized action'));
  live(run);
  const checked = await current(run);
  let value: string;
  try {
    value = run.task!.consume(JSON.parse(text), checked);
  } catch {
    fail('planner-action-rejected', 'Unauthorized action');
  }
  live(run);
  const result = await chrome.tabs.sendMessage(checked.tabId, {
    type: 'FILL', taskId: checked.taskId, observationId: checked.observationId, target: checked.target, value,
  }, { documentId: run.documentId });
  live(run);
  if (!result?.ok) fail('execution-rejected', 'Execution rejected');
  finish(run, 'Filled locally. Task cleared.', 'success');
}
/** The message text stays a fixed literal regardless of `e`; only the enum reason varies,
 * and only across a closed set of values this file itself defines. */
function reasonOf(e: unknown, fallback: Reason): Reason {
  return e instanceof RunError ? e.reason : fallback;
}
const STATUS: Record<Reason, string> = {
  success: 'Filled locally. Task cleared.',
  'observation-failed': 'Blocked: capture or observation failed. Open the fixture and retry.',
  'field-not-visible': 'Blocked: field is not fully visible. Enlarge the window and retry.',
  'vision-failed': 'Blocked: vision, planner or freshness check failed.',
  'stale-observation': 'Blocked: vision, planner or freshness check failed.',
  'planner-action-rejected': 'Blocked: vision, planner or freshness check failed.',
  'execution-rejected': 'Blocked: vision, planner or freshness check failed.',
  timeout: 'Blocked: task timed out. Nothing further executed.',
  cancelled: 'Cancelled. Task cleared.',
  navigated: 'Blocked: page navigated. Task cleared.',
};
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'privacy-popup' || port.sender?.id !== chrome.runtime.id ||
      port.sender?.url !== chrome.runtime.getURL('popup.html')) { port.disconnect(); return; }
  port.onMessage.addListener(message => {
    if (message.type === 'START') {
      if (active) finish(active, STATUS.cancelled, 'cancelled');
      const run: Run = { port, abort: new AbortController(), stage: 'observe', timer: setTimeout(() => {
        finish(run, STATUS.timeout, 'timeout');
      }, 30_000) };
      active = run;
      void start(run).catch(e => finish(run, STATUS[reasonOf(e, 'observation-failed')], reasonOf(e, 'observation-failed')));
    } else if (active?.port === port && message.type === 'VISION') {
      const run = active;
      void plan(run, message).catch(e => finish(run, STATUS[reasonOf(e, 'vision-failed')], reasonOf(e, 'vision-failed')));
    } else if (active?.port === port && message.type === 'CANCEL') {
      finish(active, STATUS.cancelled, 'cancelled');
    }
  });
  port.onDisconnect.addListener(() => {
    if (active?.port === port) finish(active, STATUS.cancelled, 'cancelled');
  });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (active?.tabId === tabId && (change.status === 'loading' || change.url)) {
    finish(active, STATUS.navigated, 'navigated');
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (active?.tabId === tabId) finish(active, STATUS.cancelled, 'cancelled');
});
