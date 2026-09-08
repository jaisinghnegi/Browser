import { buildPayload, parseAction } from './protocol';
import { Task, type Binding } from './task';

const FIXTURE = 'http://localhost:8171/fixture';
const PLANNER = 'http://localhost:8171/plan';
type Run = {
  port: chrome.runtime.Port; abort: AbortController; timer: ReturnType<typeof setTimeout>;
  task?: Task; tabId?: number; documentId?: string; binding?: Binding;
  stage: 'observe' | 'vision' | 'plan';
};
let active: Run | undefined;
function post(run: Run, message: unknown) { try { run.port.postMessage(message); } catch { /* Closed popup. */ } }
function live(run: Run) {
  if (active !== run || run.abort.signal.aborted) throw new Error('Cancelled');
}
function finish(run: Run, status: string) {
  if (active !== run) return;
  active = undefined;
  clearTimeout(run.timer);
  run.abort.abort();
  run.task?.cancel();
  if (run.binding) {
    void chrome.tabs.sendMessage(run.binding.tabId, { type: 'CANCEL', taskId: run.binding.taskId },
      { documentId: run.documentId }).catch(() => {});
  }
  post(run, { type: 'RESULT', status });
}
async function current(run: Run): Promise<Binding> {
  live(run);
  const b = run.binding!;
  const tab = await chrome.tabs.get(b.tabId);
  live(run);
  if (tab.url !== FIXTURE) throw new Error('Navigation');
  const result = await chrome.tabs.sendMessage(b.tabId, {
    type: 'CHECK', taskId: b.taskId, observationId: b.observationId, target: b.target,
  }, { documentId: run.documentId });
  live(run);
  if (!result?.ok) throw new Error('Stale page');
  return { ...b, documentId: result.documentId, origin: result.origin, target: result.target, version: result.version };
}
async function start(run: Run) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  live(run);
  if (!tab?.id || tab.url !== FIXTURE) throw new Error('Open the fixture');
  run.tabId = tab.id;
  const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  live(run);
  run.documentId = injected[0]?.documentId;
  if (!run.documentId) throw new Error('Missing document binding');
  const taskId = crypto.randomUUID(), observationId = crypto.randomUUID();
  const observed = await chrome.tabs.sendMessage(tab.id, { type: 'OBSERVE', taskId, observationId }, { documentId: run.documentId });
  live(run);
  if (!observed?.ok || observed.origin !== 'http://localhost:8171') throw new Error('Unsupported observation');
  run.binding = { taskId, observationId, target: observed.target, documentId: observed.documentId,
    tabId: tab.id, origin: observed.origin, version: observed.version };
  buildPayload(run.binding); // Validate IDs before starting any capture.
  run.task = new Task(run.binding, '991 Vault Lane, Testville 00000');
  const before = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  live(run);
  if (before[0]?.id !== tab.id) throw new Error('Tab switched');
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const after = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  live(run);
  if (after[0]?.id !== tab.id) throw new Error('Tab switched');
  await current(run);
  run.stage = 'vision';
  post(run, { type: 'CAPTURE', taskId, screenshot });
}
async function plan(run: Run, message: { taskId: string; ok: boolean }) {
  live(run);
  if (run.stage !== 'vision' || message.taskId !== run.binding?.taskId || message.ok !== true) {
    throw new Error('Vision failed');
  }
  run.stage = 'plan';
  const observed = await current(run);
  if (observed.version !== run.binding!.version || observed.documentId !== run.binding!.documentId ||
      observed.target !== run.binding!.target || observed.origin !== run.binding!.origin) throw new Error('Stale observation');
  const payload = buildPayload(run.binding!);
  post(run, { type: 'PAYLOAD', payload });
  // The only external request in the extension; redirects and credentials are forbidden.
  const response = await fetch(PLANNER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: run.abort.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  live(run);
  if (!response.ok) throw new Error('Planner unavailable');
  const text = await response.text();
  if (text.length > 4096) throw new Error('Oversized action');
  const action = parseAction(JSON.parse(text));
  const checked = await current(run);
  const value = run.task!.consume(action, checked);
  live(run);
  const result = await chrome.tabs.sendMessage(checked.tabId, {
    type: 'FILL', taskId: checked.taskId, observationId: checked.observationId, target: checked.target, value,
  }, { documentId: run.documentId });
  live(run);
  if (!result?.ok) throw new Error('Execution rejected');
  finish(run, 'Filled locally. Task cleared.');
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'privacy-popup' || port.sender?.id !== chrome.runtime.id ||
      port.sender?.url !== chrome.runtime.getURL('popup.html')) { port.disconnect(); return; }
  port.onMessage.addListener(message => {
    if (message.type === 'START') {
      if (active) finish(active, 'Cancelled. Task cleared.');
      const run: Run = { port, abort: new AbortController(), stage: 'observe', timer: setTimeout(() => {
        finish(run, 'Blocked: task timed out. Nothing further executed.');
      }, 30_000) };
      active = run;
      void start(run).catch(() => finish(run, 'Blocked: capture or observation failed. Open the fixture and retry.'));
    } else if (active?.port === port && message.type === 'VISION') {
      const run = active;
      void plan(run, message).catch(() => finish(run, 'Blocked: vision, planner or freshness check failed.'));
    } else if (active?.port === port && message.type === 'CANCEL') {
      finish(active, 'Cancelled. Task cleared.');
    }
  });
  port.onDisconnect.addListener(() => {
    if (active?.port === port) finish(active, 'Cancelled. Task cleared.');
  });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (active?.tabId === tabId && (change.status === 'loading' || change.url)) {
    finish(active, 'Blocked: page navigated. Task cleared.');
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (active?.tabId === tabId) finish(active, 'Cancelled. Task cleared.');
});
