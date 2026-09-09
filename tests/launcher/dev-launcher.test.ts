import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Slow integration proof for scripts/dev.mjs ownership -- spawns real `node scripts/dev.mjs`
// (and, in one case, a real uvicorn). NOT in the default `npm test`; run `npm run test:launcher`.
// The fast, pure ownership predicate is covered by tests/dev-ownership.test.ts.

const REPO = process.cwd();
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function freePort(): Promise<number> {
  return new Promise(res => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
  });
}
async function sentinel(port: number): Promise<Server> {
  const s = createServer((_r, w) => w.end('sentinel'));
  await new Promise<void>(ok => s.listen(port, '127.0.0.1', ok));
  cleanups.push(() => { try { s.close(); } catch { /* */ } });
  return s;
}
function dev(cmd: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ['scripts/dev.mjs', cmd],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 80_000 });
}
function tmpPidfile() {
  const dir = mkdtempSync(join(tmpdir(), 'devpid-'));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  return join(dir, 'backend.pid.json');
}
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };

describe('dev.mjs launcher ownership (slow)', () => {
  it('bad config aborts before touching any process', () => {
    const r = dev('up', { PORT: '99999', DEV_PIDFILE: tmpPidfile() });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/PORT must be/);
  });

  it('refuses `up` on a port held by an unrelated process; leaves it alive', async () => {
    const port = await freePort();
    const s = await sentinel(port);
    const pidfile = tmpPidfile();
    const r = dev('up', { PORT: String(port), PLANNER_MODE: 'deterministic', DEV_PIDFILE: pidfile });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/unknown process|not touching/i);
    expect(s.listening).toBe(true);
    expect(existsSync(pidfile)).toBe(false);
  }, 90_000);

  it('a forged pidfile naming an unrelated live pid cannot make `down` kill it', async () => {
    const port = await freePort();
    const s = await sentinel(port);
    const pidfile = tmpPidfile();
    writeFileSync(pidfile, JSON.stringify({ pids: [process.pid], childPid: process.pid, port, cwd: REPO,
      python: 'x', plannerMode: 'vlm', vlmBaseUrl: 'http://127.0.0.1:8973', command: 'forged', startedAt: 'x' }));
    const r = dev('down', { PORT: String(port), DEV_PIDFILE: pidfile });
    expect(r.status).toBe(0);                 // nothing WE own -> no-op success
    expect(isAlive(process.pid)).toBe(true);
    expect(s.listening).toBe(true);
    expect(existsSync(pidfile)).toBe(false);  // stale metadata removed
  }, 90_000);

  it('owned up -> status -> down starts and stops a real backend', async () => {
    const port = await freePort();
    const pidfile = tmpPidfile();
    const env = { PORT: String(port), PLANNER_MODE: 'deterministic', DEV_PIDFILE: pidfile };

    const up = dev('up', env);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(up.stdout).toMatch(/backend healthy/);
    expect(existsSync(pidfile)).toBe(true);

    const st = dev('status', env);
    expect(st.status).toBe(0);
    expect(st.stdout).toMatch(new RegExp(`backend   :${port}   up`));
    expect(st.stdout).toMatch(/launcher-owned/);

    const down = dev('down', env);
    expect(down.status, down.stdout + down.stderr).toBe(0);
    expect(existsSync(pidfile)).toBe(false);

    const free = await freePort().then(() => sentinel(port)).then(x => x.listening).catch(() => false);
    expect(free).toBe(true); // port genuinely released
  }, 120_000);
});
