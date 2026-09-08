// Runs only in Chrome's isolated content-script world, never in the page world.
import { FIXTURE_URL } from './config';
(() => {
  const world = globalThis as typeof globalThis & { privacyAgentInstalled?: boolean };
  if (world.privacyAgentInstalled) return;
  world.privacyAgentInstalled = true;
  const documentId = crypto.randomUUID();
  let version = 0;
  let observation: {
    taskId: string; observationId: string; target: string; node: HTMLInputElement;
    version: number; rect: string; expiresAt: number;
  } | undefined;
  const changed = () => { version++; };
  const observer = new MutationObserver(changed);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const event of ['input', 'change', 'scroll', 'resize', 'pagehide']) addEventListener(event, changed, true);
  const rectKey = (node: Element) => {
    const r = node.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height, innerWidth, innerHeight, devicePixelRatio].join(',');
  };
  // Distinguished from other observation failures so the popup can tell "wrong/invalid
  // page state" apart from "the field exists but captureVisibleTab can't see all of it" —
  // the latter is expected on a short window, not a sign the agent is broken.
  class VisibilityError extends Error {}
  // A prior successful run already filled the field (or the demo page was reloaded with a
  // preset value): distinguished so the user is told to refresh, not left with a generic
  // "something's wrong" message.
  class NonEmptyFieldError extends Error {}
  // Tolerates a trailing slash or an accidental ?query/#hash on the URL the user actually
  // navigated to -- still exactly one allowed path, just not fragile against how it got
  // typed/bookmarked/pasted. Matches background.ts's normalizeFixtureUrl.
  const normalizedHref = () => location.href.replace(/[?#].*$/, '').replace(/\/$/, '');
  function getField(): HTMLInputElement {
    if (normalizedHref() !== FIXTURE_URL) throw new Error('Unsupported page');
    const nodes = document.querySelectorAll('#shipping-address');
    const node = nodes[0];
    if (nodes.length !== 1 || !(node instanceof HTMLInputElement) || node.type !== 'text' ||
        node.disabled || node.readOnly) throw new Error('Invalid field');
    if (node.value !== '') throw new NonEmptyFieldError('Field already has a value');
    const r = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    // captureVisibleTab only captures the viewport: a partially-offscreen field means the
    // pixels the vision model scores don't cover the target. Keep this strict rather than
    // relaxing it — see README for the minimum window size this requires.
    if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth ||
        style.visibility !== 'visible' || Number(style.opacity) === 0 ||
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== node) throw new VisibilityError('Field not visible');
    return node;
  }
  function check(message: { taskId: string; observationId: string; target: string }) {
    if (observer.takeRecords().length) changed();
    const node = getField();
    const saved = observation;
    if (!saved || saved.expiresAt <= Date.now() || saved.taskId !== message.taskId ||
        saved.observationId !== message.observationId || saved.target !== message.target ||
        saved.node !== node || !node.isConnected || saved.version !== version || saved.rect !== rectKey(node)) {
      throw new Error('Stale observation');
    }
    return { node, saved };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    try {
      if (message.type === 'OBSERVE') {
        if (observer.takeRecords().length) changed();
        const node = getField();
        observation = { taskId: message.taskId, observationId: message.observationId,
          target: crypto.randomUUID(), node, version, rect: rectKey(node), expiresAt: Date.now() + 30_000 };
        respond({ ok: true, target: observation.target, documentId, version, origin: location.origin });
      } else if (message.type === 'CHECK') {
        check(message);
        respond({ ok: true, documentId, version, origin: location.origin, target: observation!.target });
      } else if (message.type === 'FILL') {
        const { node } = check(message);
        if (typeof message.value !== 'string' || message.value.length > 200) throw new Error('Invalid value');
        // No await between validation and write: node identity cannot change in this JS turn.
        observation = undefined;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(node, message.value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        respond({ ok: true });
      } else if (message.type === 'CANCEL') {
        if (observation?.taskId === message.taskId) observation = undefined;
        respond({ ok: true });
      }
    } catch (e) {
      observation = undefined;
      // Only ever a fixed literal from this file's own classes, never the caught message.
      respond({
        ok: false,
        reason: e instanceof VisibilityError ? 'field-not-visible'
          : e instanceof NonEmptyFieldError ? 'field-not-empty'
          : undefined,
      });
    }
  });
})();
