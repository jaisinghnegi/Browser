import { inspectScreenshot } from './vision';
import { buildLocalPreview, type TextRegion } from './preview';
const run = document.querySelector<HTMLButtonElement>('#run')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const status = document.querySelector<HTMLElement>('#status')!;
const payload = document.querySelector<HTMLElement>('#payload')!;
const metrics = document.querySelector<HTMLElement>('#metrics')!;
const previewStatus = document.querySelector<HTMLElement>('#preview-status')!;
const previewImage = document.querySelector<HTMLImageElement>('#preview-image')!;
const port = chrome.runtime.connect({ name: 'privacy-popup' });
let generation = 0;
function busy(value: boolean) { run.disabled = value; cancel.disabled = !value; }
function resetPreview() {
  previewStatus.textContent = 'Not sent. Local-only preview.';
  previewImage.style.display = 'none';
  previewImage.src = '';
}
run.addEventListener('click', () => {
  generation++;
  busy(true); status.textContent = 'Capturing locally…'; metrics.textContent = ''; payload.textContent = 'No request sent.';
  resetPreview();
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
    // Local-only, additive, best-effort: never affects the real gating/fill decision above or
    // what background.ts actually sends. A failure here only means "no local preview shown".
    if (message.textRegions?.supported) {
      previewStatus.textContent = 'Building local sanitized preview…';
      const regions = message.textRegions.regions as TextRegion[];
      void buildLocalPreview(message.screenshot, regions, message.textRegions.devicePixelRatio)
        .then(preview => {
          if (token !== generation) return;
          if (preview.outcome === 'redacted' && preview.redactedDataUrl) {
            previewImage.src = preview.redactedDataUrl;
            previewImage.style.display = '';
            previewStatus.textContent = `Not sent. ${preview.maskedRegionCount} region(s) masked locally · ` +
              `${Math.round(preview.timingMs.total)} ms.`;
          } else {
            const reasonText = preview.withheldReason === 'uncertain-region'
              ? '(a text region was below the reliable recognition threshold)'
              : preview.withheldReason === 'too-many-regions'
                ? '(too much text on this page to preview quickly)'
                : '';
            previewStatus.textContent = `Not sent. Preview withheld ${reasonText}.`;
          }
        })
        .catch(() => { if (token === generation) previewStatus.textContent = 'Not sent. Preview unavailable.'; });
    } else {
      previewStatus.textContent = 'Not sent. Preview unavailable (page contains unsupported content for local analysis).';
    }
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
