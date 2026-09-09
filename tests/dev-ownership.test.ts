import { describe, expect, it } from 'vitest';
import { isOwnedByCmdline, verifyRecordedIdentity, pidfileIsUsable, descendantsOf, startedNoEarlierThan, mayForce } from '../scripts/dev-ownership.mjs';

const PY = 'C:\\Users\\dev\\proj\\.venv\\Scripts\\python.exe';
const CWD = 'C:\\Users\\dev\\proj';
const cmd = (port: number) => `"${PY}" -m uvicorn server.main:app --host 127.0.0.1 --port ${port} --no-access-log`;
const sig = (port: number) => ({ py: PY, port });

describe('isOwnedByCmdline', () => {
  it('matches our exact venv + uvicorn + port (separator/case-insensitive)', () => {
    expect(isOwnedByCmdline(cmd(8171), sig(8171))).toBe(true);
    expect(isOwnedByCmdline(cmd(8171).replace(/\\/g, '/').toUpperCase(), sig(8171))).toBe(true);
  });
  it('rejects a different / substring-y port', () => {
    for (const p of [817, 81710, 9000]) expect(isOwnedByCmdline(cmd(8171), sig(p))).toBe(false);
  });
  it('rejects a different python, our-python-wrong-app, and unrelated apps', () => {
    for (const cl of [
      `"C:\\Python312\\python.exe" -m uvicorn server.main:app --port 8171`,
      `"${PY}" -m uvicorn other.app:app --port 8171`,
      `"${PY}" -m http.server 8171`,
      'node C:/tools/devserver.js --port 8171',
    ]) expect(isOwnedByCmdline(cl, sig(8171))).toBe(false);
  });
  it('rejects null/garbage/empty py safely', () => {
    for (const bad of [null, undefined, '', 42 as unknown as string]) expect(isOwnedByCmdline(bad as string, sig(8171))).toBe(false);
    expect(isOwnedByCmdline(cmd(8171), { py: '', port: 8171 })).toBe(false);
  });
});

describe('verifyRecordedIdentity — a signal needs BOTH matching cmdline AND recorded start identity', () => {
  const live = (port: number, start: string) => ({ cmdline: cmd(port), start });
  it('true only when cmdline matches AND start identities are equal', () => {
    expect(verifyRecordedIdentity({ start: 'S1' }, live(8171, 'S1'), sig(8171))).toBe(true);
  });
  it('false on start mismatch — a new process that reused the PID cannot inherit ownership', () => {
    expect(verifyRecordedIdentity({ start: 'S1' }, live(8171, 'S2'), sig(8171))).toBe(false);
  });
  it('false when the live cmdline no longer matches (PID now belongs to something else)', () => {
    expect(verifyRecordedIdentity({ start: 'S1' }, { cmdline: 'node other.js', start: 'S1' }, sig(8171))).toBe(false);
  });
  it('false when either start identity is missing/blank', () => {
    expect(verifyRecordedIdentity({ start: '' }, live(8171, 'S1'), sig(8171))).toBe(false);
    expect(verifyRecordedIdentity({ start: 'S1' }, { cmdline: cmd(8171), start: '' }, sig(8171))).toBe(false);
    expect(verifyRecordedIdentity(null, live(8171, 'S1'), sig(8171))).toBe(false);
    expect(verifyRecordedIdentity({ start: 'S1' }, null, sig(8171))).toBe(false);
  });
});

describe('descendantsOf — lineage proof (a matching cmdline alone must NOT qualify)', () => {
  const procs = new Map<number, { ppid: number }>([
    [100, { ppid: 1 }], [200, { ppid: 100 }], [300, { ppid: 200 }], [400, { ppid: 1 }], [500, { ppid: 100 }],
  ]);
  it('collects the whole subtree of root', () => {
    expect([...descendantsOf(100, procs)].sort((a, b) => a - b)).toEqual([100, 200, 300, 500]);
  });
  it('an unrelated sibling is NOT a descendant', () => {
    expect(descendantsOf(100, procs).has(400)).toBe(false);
  });
  it('root always included even if absent from the snapshot; cycles are safe', () => {
    expect([...descendantsOf(7, procs)]).toEqual([7]);
    expect([...descendantsOf(1, { 1: { ppid: 2 }, 2: { ppid: 1 } } as any)].sort()).toEqual([1, 2]);
  });
  it('works with a plain object snapshot too', () => {
    expect(descendantsOf(100, { 200: { ppid: 100 }, 300: { ppid: 200 } } as any).has(300)).toBe(true);
  });
});

describe('startedNoEarlierThan — a real descendant is not created before its ancestor', () => {
  it('true when descendant start >= child start (with slack)', () => {
    expect(startedNoEarlierThan('2026-01-01T00:00:05Z', '2026-01-01T00:00:00Z')).toBe(true);
    expect(startedNoEarlierThan('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')).toBe(true); // within 2s slack
  });
  it('false when the candidate clearly predates the child (PID reuse guard)', () => {
    expect(startedNoEarlierThan('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')).toBe(false);
  });
  it('false when either timestamp is unparseable (conservative)', () => {
    expect(startedNoEarlierThan('nope', '2026-01-01T00:00:00Z')).toBe(false);
    expect(startedNoEarlierThan('2026-01-01T00:00:00Z', '')).toBe(false);
  });
});

describe('mayForce — re-verify identity + lineage in the fresh snapshot before a force-kill', () => {
  const ROOT = 100;
  const snap = (childPidStart: string, extra: Record<number, { ppid: number; start: string }> = {}) => ({
    100: { ppid: 1, start: 'C0' },
    200: { ppid: 100, start: childPidStart }, // the descendant we might force
    ...extra,
  });

  it('allows force when the PID still has the recorded start AND still descends from root', () => {
    expect(mayForce({ pid: 200, start: 'D0' }, snap('D0'), ROOT)).toBe(true);
  });

  it('REFUSES force when the start identity changed between graceful and force (PID reuse)', () => {
    // recorded D0, but the live process at pid 200 in the fresh snapshot is D9 -> a different
    // process took the PID during the wait.
    expect(mayForce({ pid: 200, start: 'D0' }, snap('D9'), ROOT)).toBe(false);
  });

  it('REFUSES force when the PID is no longer in our lineage', () => {
    const s: any = snap('D0');
    s[200].ppid = 999; // reparented / different process entirely
    expect(mayForce({ pid: 200, start: 'D0' }, s, ROOT)).toBe(false);
  });

  it('REFUSES force when the PID is gone from the snapshot', () => {
    const s: any = snap('D0');
    delete s[200];
    expect(mayForce({ pid: 200, start: 'D0' }, s, ROOT)).toBe(false);
  });

  it('REFUSES force on blank/missing start identity', () => {
    expect(mayForce({ pid: 200, start: '' }, snap('D0'), ROOT)).toBe(false);
    expect(mayForce({ pid: 200, start: 'D0' }, snap(''), ROOT)).toBe(false);
  });
});

describe('pidfileIsUsable — legacy/malformed metadata authorises nothing', () => {
  const good = { version: 2, cwd: CWD, port: 8171, pids: [{ pid: 10, start: 'S' }] };
  it('accepts a current-format file for this workspace+port', () => {
    expect(pidfileIsUsable(good, { cwd: CWD, port: 8171 })).toBe(true);
  });
  it('rejects legacy (no version / plain-number pids), wrong cwd, wrong port, missing start', () => {
    expect(pidfileIsUsable({ cwd: CWD, port: 8171, pids: [10, 11] }, { cwd: CWD, port: 8171 })).toBe(false);
    expect(pidfileIsUsable({ ...good, cwd: 'C:\\elsewhere' }, { cwd: CWD, port: 8171 })).toBe(false);
    expect(pidfileIsUsable({ ...good, port: 9999 }, { cwd: CWD, port: 8171 })).toBe(false);
    expect(pidfileIsUsable({ ...good, pids: [{ pid: 10 }] }, { cwd: CWD, port: 8171 })).toBe(false);
    expect(pidfileIsUsable(null, { cwd: CWD, port: 8171 })).toBe(false);
  });
});
