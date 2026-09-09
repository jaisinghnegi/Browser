// One launcher/status/stop for the local demo backend. It owns EXACTLY the one FastAPI
// process it started -- identified by a PID-metadata file plus a live command-line check --
// and never touches anything else on the port.
//
//   node scripts/dev.mjs up        start the backend (stop only our own stale one first)
//   node scripts/dev.mjs status    report the backend and the model server
//   node scripts/dev.mjs down      stop our backend (nonzero if a verified-owned one won't die)
//
// The llama.cpp model server on :8973 is a large personal artifact with its own launch;
// `up`/`status` check it and print guidance, but never start or stop it. Not an OS service.
//
// Env for `up`: PLANNER_MODE (default vlm), VLM_BASE_URL (default http://127.0.0.1:8973),
// PORT (default 8171). All three are validated BEFORE any process is inspected or signalled.
import { spawn, execFileSync } from 'node:child_process';
import { openSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isOwnedByCmdline } from './dev-ownership.mjs';

const isWin = process.platform === 'win32';
const CWD = process.cwd();
const PY = resolve(isWin ? '.venv/Scripts/python.exe' : '.venv/bin/python');
// No probe may hang the launcher. Generous because a cold Windows PowerShell (used only for
// the command-line lookup) can take several seconds to start; `netstat`/`ps` return in ms.
const SH_TIMEOUT = 15000;
// DEV_PIDFILE lets the launcher's regression tests point the metadata file at a temp path so
// they never disturb a real running backend. Production/manual use always defaults.
const PIDFILE = resolve(process.env.DEV_PIDFILE || 'test-results/backend.pid.json');
const UVICORN_SIG = 'uvicorn server.main:app'; // must appear in an owned process's command line

// ---------- config validation (no side effects) ----------
function fail(msg) { console.error(`dev.mjs: ${msg}`); process.exit(1); }

function config() {
  const portRaw = process.env.PORT || '8171';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be 1..65535, got ${JSON.stringify(portRaw)}`);
  const plannerMode = process.env.PLANNER_MODE || 'vlm';
  if (!['deterministic', 'vlm'].includes(plannerMode)) fail(`PLANNER_MODE must be deterministic|vlm, got ${plannerMode}`);
  const vlmBaseUrl = (process.env.VLM_BASE_URL || 'http://127.0.0.1:8973').replace(/\/+$/, '');
  let u;
  try { u = new URL(vlmBaseUrl); } catch { fail(`VLM_BASE_URL is not a URL: ${vlmBaseUrl}`); }
  if (u.protocol !== 'http:') fail('VLM_BASE_URL must be http:// (local loopback)');
  if (u.username || u.password) fail('VLM_BASE_URL must not contain userinfo');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) fail('VLM_BASE_URL must be scheme://host:port only');
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) fail(`VLM_BASE_URL host must be loopback, got ${u.hostname}`);
  if (!u.port) fail('VLM_BASE_URL must include a port');
  return { port, plannerMode, vlmBaseUrl };
}

// ---------- process helpers ----------
function pidsOnPort(port) {
  try {
    if (isWin) {
      // netstat is a fast native exe; PowerShell's Get-NetTCPConnection cold-starts too slowly.
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: SH_TIMEOUT });
      const pids = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
        if (m && Number(m[1]) === port) pids.push(Number(m[2]));
      }
      return [...new Set(pids)];
    }
    const out = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: SH_TIMEOUT });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch { return []; }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function cmdlineOf(pid) {
  try {
    if (isWin) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`],
        { encoding: 'utf8', timeout: SH_TIMEOUT });
      return out.trim() || null;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: SH_TIMEOUT }).trim() || null;
  } catch { return null; }
}

/** True only if `pid` is live AND its command line is unmistakably THIS workspace's backend on
 * `port` -- see dev-ownership.mjs for the pure predicate. */
function isOwnedProcess(pid, port) {
  if (!pid || !alive(pid)) return false;
  return isOwnedByCmdline(cmdlineOf(pid), { py: PY, uvicornSig: UVICORN_SIG, port });
}

function readPidfile() {
  try { return JSON.parse(readFileSync(PIDFILE, 'utf8')); } catch { return null; }
}
function writePidfile(meta) {
  mkdirSync(resolve('test-results'), { recursive: true });
  const tmp = PIDFILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, PIDFILE); // atomic replace
}

/** PIDs (from the pidfile) that are still a live, signature-matching backend for THIS
 * workspace on THEIR recorded port. Removes the pidfile if none survive. */
function ownedBackendPids() {
  const m = readPidfile();
  if (!m || m.cwd !== CWD) { if (existsSync(PIDFILE)) rmSync(PIDFILE, { force: true }); return []; }
  const live = (m.pids || []).filter(p => isOwnedProcess(p, m.port));
  if (!live.length && existsSync(PIDFILE)) rmSync(PIDFILE, { force: true });
  return live;
}

const graceful = (pid) => { try { isWin ? execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGTERM'); } catch { /* expected for a windowless detached child */ } };
const force = (pid) => { try { isWin ? execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGKILL'); } catch { /* */ } };

/** Stop `pid` ONLY while it still matches this backend's signature on `port`: graceful first,
 * force only after re-verifying ownership. Returns true when it is no longer alive. */
async function stopOwned(pid, port, { label }) {
  if (!isOwnedProcess(pid, port)) return true; // already gone / not ours
  graceful(pid);
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(150);
  if (alive(pid)) {
    if (!isOwnedProcess(pid, port)) { console.error(`${label}: pid ${pid} no longer matches this backend; refusing to force-kill`); return false; }
    force(pid);
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(150);
  }
  return !alive(pid);
}

/** Every signature-matching backend currently on `port` (pidfile PIDs + the live listener
 * tree), de-duplicated. */
function matchingBackendsOn(port) {
  const fromFile = (readPidfile()?.pids || []);
  return [...new Set([...fromFile, ...pidsOnPort(port)])].filter(p => isOwnedProcess(p, port));
}

// ---------- http ----------
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

// ---------- commands ----------
async function status() {
  const { port, vlmBaseUrl } = config();
  const backend = await httpJson(`http://127.0.0.1:${port}/health`);
  const models = await httpJson(`http://127.0.0.1:${port}/api/models`);
  const model = await httpJson(`${vlmBaseUrl}/health`);
  const ready = models.body?.models?.[0]?.ready;
  const listener = pidsOnPort(port);
  const ownedHere = matchingBackendsOn(port);
  const trackedHere = ownedBackendPids().length > 0;
  console.log(`backend   :${port}   ${backend.ok ? 'up' : 'DOWN'}` +
    (backend.ok ? `   planner=${backend.body?.plannerMode ?? '?'}   model-ready=${ready}` : '') +
    (listener.length ? `   pid=${listener.join(',')} ${
      trackedHere ? '(launcher-owned)' : ownedHere.length ? '(matches this backend, no pidfile)' : '(not launcher-owned)'}` : ''));
  console.log(`model     ${vlmBaseUrl}   ${model.ok ? 'up' : 'DOWN'}`);
  if (!model.ok) console.log(`          -> start your llama-server on :8973 (see scripts/vlm-eval/README.md); ` +
    `backend still runs, chat/plan will report "unavailable" until it is up`);
  console.log(`chat UI   http://localhost:${port}/        browser demo   http://localhost:${port}/fixture`);
  console.log(`note      reload the extension in chrome://extensions after a rebuild (manual, by design)`);
  return backend.ok;
}

async function up() {
  const { port, plannerMode, vlmBaseUrl } = config(); // validates, may exit(1), no process touched

  // Stop only processes that are unmistakably THIS workspace's backend on THIS port: our venv
  // python + `uvicorn server.main:app` + `--port <port>` (pidfile PIDs and/or the live
  // listener tree). isOwnedProcess() can never match an unrelated app, even on an overridden
  // port -- so an unknown listener is left alive and `up` aborts.
  for (const p of matchingBackendsOn(port)) {
    console.log(`stopping a matching backend on :${port} (pid ${p})`);
    if (!await stopOwned(p, port, { label: 'up' })) fail(`could not stop matching backend pid ${p}`);
  }
  if (existsSync(PIDFILE)) rmSync(PIDFILE, { force: true });

  const others = pidsOnPort(port);
  if (others.length) fail(`:${port} is held by an unknown process (pid ${others.join(', ')}); not touching it. ` +
    `Use PORT=<free port> or free it yourself.`);

  mkdirSync(resolve('test-results'), { recursive: true });
  const log = openSync(resolve('test-results/backend.log'), 'a');
  const args = ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'];
  const child = spawn(PY, args, {
    env: { ...process.env, PLANNER_MODE: plannerMode, VLM_BASE_URL: vlmBaseUrl },
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  });
  child.unref();
  // Record everything up front so a crash mid-startup still leaves a cleanable trail.
  const meta = { pids: [child.pid], childPid: child.pid, port, cwd: CWD, python: PY,
    plannerMode, vlmBaseUrl, command: `${PY} ${args.join(' ')}`, startedAt: new Date().toISOString() };
  writePidfile(meta);
  console.log(`started backend (child pid ${child.pid}) (PLANNER_MODE=${plannerMode}, VLM_BASE_URL=${vlmBaseUrl}) -> test-results/backend.log`);

  const stopEverythingWeStarted = async () => {
    for (const p of [...new Set([child.pid, ...(readPidfile()?.pids || []), ...pidsOnPort(port)])]) {
      if (isOwnedProcess(p, port)) await stopOwned(p, port, { label: 'up' });
    }
    if (existsSync(PIDFILE)) rmSync(PIDFILE, { force: true });
  };

  for (let i = 0; i < 40; i++) {
    // `python -m uvicorn` may hand the listening socket to a child, so the process that binds
    // isn't always child.pid. Treat "our child gone AND nothing matching on the port" as a
    // real startup failure; otherwise keep waiting for /health.
    const owned = matchingBackendsOn(port);
    if (!alive(child.pid) && !owned.length) { await stopEverythingWeStarted(); fail('backend process exited during startup; see test-results/backend.log'); }
    const h = await httpJson(`http://127.0.0.1:${port}/health`, 1000);
    if (h.ok) {
      // The 200 must be a process WE recognise as this backend -- not an unrelated one that
      // won a port race -- and it must report exactly the mode we asked for.
      if (!owned.length) { await stopEverythingWeStarted(); fail('a process answered /health on this port but it is not our backend; aborting'); }
      if (h.body?.status !== 'ok' || h.body?.plannerMode !== plannerMode) {
        await stopEverythingWeStarted();
        fail(`/health did not report the expected mode (${plannerMode}); got ${JSON.stringify(h.body)}`);
      }
      writePidfile({ ...meta, pids: [...new Set([child.pid, ...owned])] });
      console.log('backend healthy.\n');
      await status();
      process.exit(0);
    }
    await sleep(500);
  }
  await stopEverythingWeStarted();
  fail('backend did not become healthy in 20s; see test-results/backend.log');
}

async function down() {
  const { port } = config();
  const targets = matchingBackendsOn(port); // pidfile PIDs + live listener tree, signature-checked
  if (!targets.length) {
    if (existsSync(PIDFILE) && !ownedBackendPids().length) rmSync(PIDFILE, { force: true }); // stale metadata only
    const others = pidsOnPort(port);
    console.log(others.length
      ? `no launcher-owned backend; :${port} held by pid ${others.join(', ')} (not ours, left alone)`
      : 'no launcher-owned backend running');
    process.exit(0);
  }
  let allStopped = true;
  for (const pid of targets) {
    console.log(`stopping our backend pid ${pid}`);
    if (!await stopOwned(pid, port, { label: 'down' })) allStopped = false;
  }
  if (existsSync(PIDFILE) && !ownedBackendPids().length) rmSync(PIDFILE, { force: true });
  if (!allStopped) { console.error(`down: a verified-owned backend process did not stop`); process.exit(1); }
  console.log(`:${port} released`);
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'status') { await status(); }
else if (cmd === 'down') await down();
else { console.error('usage: node scripts/dev.mjs <up|status|down>'); process.exit(2); }
