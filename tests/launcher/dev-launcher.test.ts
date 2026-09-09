import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Slow integration proof for scripts/dev.mjs ownership -- spawns real `node scripts/dev.mjs`
// and, in some cases, a real uvicorn. NOT in the default `npm test`; run `npm run test:launcher`.
// The pure ownership predicates are covered fast by tests/dev-ownership.test.ts.

const REPO = process.cwd();
const PY = resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const freePort = (): Promise<number> => new Promise(res => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
});
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
const httpUp = async (port: number) => {
  try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
};

describe('dev.mjs launcher ownership (slow)', () => {
  it('bad config aborts before touching any process', () => {
    const r = dev('up', { PORT: '99999', DEV_PIDFILE: tmpPidfile() });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/PORT must be/);
  });

  it('refuses `up` on a port held by an UNRELATED process; leaves it alive', async () => {
    const port = await freePort();
    const s = await sentinel(port);
    const pidfile = tmpPidfile();
    const r = dev('up', { PORT: String(port), PLANNER_MODE: 'deterministic', DEV_PIDFILE: pidfile });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/did not start it|not touching/i);
    expect(s.listening).toBe(true);
    expect(existsSync(pidfile)).toBe(false);
  }, 90_000);

  it('refuses `up` when a MATCHING workspace uvicorn is on the port but was started manually (unrecorded)', async () => {
    const port = await freePort();
    const pidfile = tmpPidfile();
    // The exact command dev.mjs would run -- but started by hand, so there is no pidfile.
    const manual = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
      { cwd: REPO, env: { ...process.env, PLANNER_MODE: 'deterministic' }, stdio: 'ignore', detached: false });
    cleanups.push(() => { try { process.kill(manual.pid!); } catch { /* */ } });
    for (let i = 0; i < 40 && !(await httpUp(port)); i++) await new Promise(r => setTimeout(r, 500));
    expect(await httpUp(port)).toBe(true);

    const r = dev('up', { PORT: String(port), PLANNER_MODE: 'deterministic', DEV_PIDFILE: pidfile });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/did not start|not touching/i);
    expect(isAlive(manual.pid!)).toBe(true);       // the manual backend must survive
    expect(await httpUp(port)).toBe(true);
    expect(existsSync(pidfile)).toBe(false);
  }, 120_000);

  it('a forged pidfile naming an unrelated live pid cannot make `down` kill it', async () => {
    const port = await freePort();
    const s = await sentinel(port);
    const pidfile = tmpPidfile();
    writeFileSync(pidfile, JSON.stringify({ version: 2, port, cwd: REPO, python: 'x',
      plannerMode: 'vlm', vlmBaseUrl: 'http://127.0.0.1:8973', command: 'forged', startedAt: 'x',
      pids: [{ pid: process.pid, start: 'not-the-real-start' }] }));
    const r = dev('down', { PORT: String(port), DEV_PIDFILE: pidfile });
    expect(r.status).toBe(0);
    expect(isAlive(process.pid)).toBe(true);
    expect(s.listening).toBe(true);
    expect(existsSync(pidfile)).toBe(false); // untrusted metadata dropped
  }, 90_000);

  it('legacy (v1) metadata authorises nothing: `down` is a no-op and drops the file', async () => {
    const port = await freePort();
    const s = await sentinel(port);
    const pidfile = tmpPidfile();
    writeFileSync(pidfile, JSON.stringify({ pids: [process.pid], port, cwd: REPO })); // no version:2, plain pids
    const r = dev('down', { PORT: String(port), DEV_PIDFILE: pidfile });
    expect(r.status).toBe(0);
    expect(isAlive(process.pid)).toBe(true);
    expect(s.listening).toBe(true);
    expect(existsSync(pidfile)).toBe(false);
  }, 90_000);

  it('a matching process that WINS the post-preflight bind race is not killed or persisted', async () => {
    const port = await freePort();
    const pidfile = tmpPidfile();

    // dev.mjs `up`: preflight (port free) -> sleep 3s (DEV_SPAWN_DELAY_MS) -> spawn its child.
    const up = spawn(process.execPath, ['scripts/dev.mjs', 'up'], {
      cwd: REPO, env: { ...process.env, PORT: String(port), PLANNER_MODE: 'deterministic',
        DEV_PIDFILE: pidfile, DEV_SPAWN_DELAY_MS: '3000' },
    });
    let out = '';
    up.stdout.on('data', d => (out += d));
    up.stderr.on('data', d => (out += d));

    // Race a matching manual uvicorn onto the port during the delay window (it is NOT a child
    // of dev.mjs's spawned process).
    await new Promise(r => setTimeout(r, 600));
    const manual = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
      { cwd: REPO, env: { ...process.env, PLANNER_MODE: 'deterministic' }, stdio: 'ignore', detached: false });
    cleanups.push(() => { try { process.kill(manual.pid!); } catch { /* */ } });
    for (let i = 0; i < 40 && !(await httpUp(port)); i++) await new Promise(r => setTimeout(r, 250));

    const code: number = await new Promise(res => up.on('exit', c => res(c ?? -1)));
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/did not spawn/i);
    expect(isAlive(manual.pid!)).toBe(true);         // the race winner survives
    expect(await httpUp(port)).toBe(true);
    expect(existsSync(pidfile)).toBe(false);         // and was never persisted as owned
  }, 120_000);

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
    expect(await httpUp(port)).toBe(false); // port released
  }, 120_000);
});
