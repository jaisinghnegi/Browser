// One launcher/status command for the local demo, so the FastAPI backend is started exactly
// once (no double-spawn) and both services can be inspected at a glance.
//
//   node scripts/dev.mjs up        start the backend on :8171 (kills any stale listener first)
//   node scripts/dev.mjs status    report the backend (:8171) and the model server (:8973)
//   node scripts/dev.mjs down      stop the backend on :8171
//
// It OWNS the FastAPI backend only. The llama.cpp model server on :8973 is a large personal
// artifact with its own launch; `up`/`status` check it and print guidance if it is down, but
// never start or stop it. Not an OS service -- processes stop when you run `down` or reboot.
//
// Env for `up`: PLANNER_MODE (default vlm), VLM_BASE_URL (default http://127.0.0.1:8973),
// PORT (default 8171).
import { spawn, execFileSync } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const isWin = process.platform === 'win32';
const PORT = Number(process.env.PORT || 8171);
const MODEL_URL = process.env.VLM_BASE_URL || 'http://127.0.0.1:8973';
const PLANNER_MODE = process.env.PLANNER_MODE || 'vlm';
const PY = resolve(isWin ? '.venv/Scripts/python.exe' : '.venv/bin/python');

function pidsOnPort(port) {
  try {
    if (isWin) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
        `Select-Object -ExpandProperty OwningProcess -Unique`], { encoding: 'utf8' });
      return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
    }
    const out = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch { return []; }
}

function kill(pid) {
  try {
    if (isWin) execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

async function httpJson(url, ms = 2500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: 'error' });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
  } catch { return { ok: false, status: 0, body: null }; }
  finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function status() {
  const backend = await httpJson(`http://127.0.0.1:${PORT}/health`);
  const models = await httpJson(`http://127.0.0.1:${PORT}/api/models`);
  const model = await httpJson(`${MODEL_URL}/health`);
  const ready = models.body?.models?.[0]?.ready;
  console.log(`backend   :${PORT}   ${backend.ok ? 'up' : 'DOWN'}` +
    (backend.ok ? `   planner=${backend.body?.plannerMode ?? '?'}   model-ready=${ready}` : ''));
  console.log(`model     ${MODEL_URL}   ${model.ok ? 'up' : 'DOWN'}`);
  if (!model.ok) console.log(`          -> start your llama-server on :8973 (see scripts/vlm-eval/README.md); ` +
    `backend still runs, chat/plan will report "unavailable" until it is up`);
  console.log(`chat UI   http://localhost:${PORT}/        browser demo   http://localhost:${PORT}/fixture`);
  console.log(`note      reload the extension in chrome://extensions after a rebuild (manual, by design)`);
  return backend.ok;
}

async function up() {
  const stale = pidsOnPort(PORT);
  if (stale.length) { console.log(`stopping stale listener(s) on :${PORT}: ${stale.join(', ')}`); stale.forEach(kill); await sleep(800); }
  if (pidsOnPort(PORT).length) { console.error(`:${PORT} is still held after kill; aborting`); process.exit(1); }

  mkdirSync('test-results', { recursive: true });
  const log = openSync('test-results/backend.log', 'a');
  const child = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(PORT), '--no-access-log'], {
    env: { ...process.env, PLANNER_MODE, VLM_BASE_URL: MODEL_URL },
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  });
  child.unref(); // survives this launcher process
  console.log(`started backend pid ${child.pid} (PLANNER_MODE=${PLANNER_MODE}, VLM_BASE_URL=${MODEL_URL}) -> test-results/backend.log`);

  for (let i = 0; i < 40; i++) {
    const h = await httpJson(`http://127.0.0.1:${PORT}/health`, 1000);
    if (h.ok) { console.log('backend healthy.\n'); return status().then(() => process.exit(0)); }
    await sleep(500);
  }
  console.error('backend did not become healthy in 20s; see test-results/backend.log');
  process.exit(1);
}

async function down() {
  const pids = pidsOnPort(PORT);
  if (!pids.length) { console.log(`nothing listening on :${PORT}`); return; }
  console.log(`stopping :${PORT} pid(s) ${pids.join(', ')}`);
  pids.forEach(kill);
  await sleep(500);
  console.log(pidsOnPort(PORT).length ? `still held on :${PORT}` : `:${PORT} free`);
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'status') { await status(); }
else if (cmd === 'down') await down();
else { console.error('usage: node scripts/dev.mjs <up|status|down>'); process.exit(2); }
