import { inspectScreenshot } from './vision';
const run = document.querySelector<HTMLButtonElement>('#run')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const status = document.querySelector<HTMLElement>('#status')!;
const payload = document.querySelector<HTMLElement>('#payload')!;
const metrics = document.querySelector<HTMLElement>('#metrics')!;
const port = chrome.runtime.connect({ name: 'privacy-popup' });
let generation = 0;
function busy(value: boolean) { run.disabled = value; cancel.disabled = !value; }
run.addEventListener('click', () => {
  generation++;
  busy(true); status.textContent = 'Capturing locally…'; metrics.textContent = ''; payload.textContent = 'No request sent.';
  // A toolbar-action popup reports the browser window it's anchored to here (it has no
  // separate window of its own), which is the one activeTab was actually granted for --
  // more reliable than the background service worker guessing "current window" itself.
  void chrome.windows.getCurrent().then(w => port.postMessage({ type: 'START', windowId: w.id }));
});
cancel.addEventListener('click', () => { generation++; port.postMessage({ type: 'CANCEL' }); });
port.onMessage.addListener(message => {
  if (message.type === 'CAPTURE') {
    const token = generation;
    status.textContent = 'Running local vision…';
    void inspectScreenshot(message.screenshot).then(result => {
      if (token !== generation) return;
      metrics.textContent = `PP-OCRv4 · ${Math.round(result.milliseconds)} ms inference · ${result.textPixels} text pixels · ${result.width}×${result.height} map`;
      port.postMessage({ type: 'VISION', taskId: message.taskId, ok: true });
    }).catch(() => {
      if (token === generation) port.postMessage({ type: 'VISION', taskId: message.taskId, ok: false });
    });
  } else if (message.type === 'PAYLOAD') {
    payload.textContent = JSON.stringify(message.payload, null, 2);
    status.textContent = 'Planner receives references only…';
  } else if (message.type === 'RESULT') {
    generation++; busy(false); status.textContent = message.status;
    // Machine-checkable outcome for tests; not rendered, so it can't leak page/planner text.
    status.dataset.reason = message.reason ?? '';
  }
});
port.onDisconnect.addListener(() => { generation++; busy(false); run.disabled = true; status.textContent = 'Connection closed. Reopen the extension.'; });
