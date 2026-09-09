// One launcher/status/stop for the local demo backend. It signals ONLY a process it started
// AND recorded: a PID must be in the current-format pidfile for this workspace+port, and the
// live process at that PID must still carry BOTH the recorded OS start identity (defeats PID
// reuse) AND our exact command-line signature. A matching-but-unrecorded listener -- e.g. a
// `uvicorn server.main:app` a developer started by hand -- is an UNKNOWN COLLISION: reported,
// left alive, and `up` aborts. Legacy/malformed metadata authorises nothing.
//
//   node scripts/dev.mjs up        start the backend (stop only our recorded one first)
//   node scripts/dev.mjs status    report the backend and the model server
//   node scripts/dev.mjs down      stop our recorded backend (nonzero if it won't die)
//
// The llama.cpp model server on :8973 is a large personal artifact with its own launch;
// `up`/`status` check it and print guidance, but never start or stop it. Not an OS service.
//
// Env for `up`: PLANNER_MODE (default vlm), VLM_BASE_URL (default http://127.0.0.1:8973),
// PORT (default 8171). All three are validated BEFORE any process is inspected or signalled.
import { spawn, execFileSync } from 'node:child_process';
import { openSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isOwnedByCmdline, verifyRecordedIdentity, pidfileIsUsable, descendantsOf, startedNoEarlierThan } from './dev-ownership.mjs';

const PIDFILE_VERSION = 2;

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

/** { cmdline, start, ppid } for a live pid, or null. `start` is the OS process creation time --
 * an immutable identity a PID-reusing new process cannot forge. */
function procInfo(pid) {
  try {
    if (isWin) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | ` +
        `Select-Object -First 1 | ForEach-Object { $_.CreationDate.ToString('o') + '|' + $_.ParentProcessId + '|' + $_.CommandLine }`],
        { encoding: 'utf8', timeout: SH_TIMEOUT });
      const line = out.trim();
      if (!line) return null;
      const a = line.indexOf('|'), b = line.indexOf('|', a + 1);
      if (a < 0 || b < 0) return null;
      return { start: line.slice(0, a), ppid: Number(line.slice(a + 1, b)), cmdline: line.slice(b + 1).trim() || null };
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,lstart=,args='], { encoding: 'utf8', timeout: SH_TIMEOUT }).trim();
    if (!out) return null;
    const m = out.match(/^\s*(\d+)\s+(.{24})\s(.*)$/);
    return m ? { ppid: Number(m[1]), start: m[2], cmdline: m[3].trim() || null } : null;
  } catch { return null; }
}

/** Snapshot of every process: Map<pid, { ppid, start }>. One shell call. Used for lineage. */
function procList() {
  const map = new Map();
  try {
    if (isWin) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToString('o'))" }`],
        { encoding: 'utf8', timeout: SH_TIMEOUT });
      for (const line of out.split(/\r?\n/)) {
        const p = line.split('|');
        if (p.length >= 3 && p[0]) map.set(Number(p[0]), { ppid: Number(p[1]), start: p[2].trim() });
      }
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: SH_TIMEOUT });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})/);
        if (m) map.set(Number(m[1]), { ppid: Number(m[2]), start: m[3] });
      }
    }
  } catch { /* empty map -> nothing is provable as a descendant -> conservative */ }
  return map;
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
const removePidfile = () => { if (existsSync(PIDFILE)) rmSync(PIDFILE, { force: true }); };

/** The ONLY processes this launcher may ever signal: PIDs RECORDED in a usable, current-format
 * pidfile for this workspace+port whose LIVE process still matches BOTH the recorded start
 * identity AND our command-line signature. A matching-but-unrecorded listener is NOT here --
 * it is treated as an unknown collision. Returns [{ pid, start }]. */
function ownedTargets(port) {
  const m = readPidfile();
  if (!pidfileIsUsable(m, { cwd: CWD, port })) return [];
  const sig = { py: PY, uvicornSig: UVICORN_SIG, port };
  return m.pids.filter(e => alive(e.pid) && verifyRecordedIdentity(e, procInfo(e.pid), sig));
}

/** Drop the pidfile only when nothing it records is still a verified-live owned process
 * (covers both "all owned PIDs exited" and legacy/malformed metadata that can't be trusted). */
function dropPidfileIfStale(port) {
  if (existsSync(PIDFILE) && !ownedTargets(port).length) removePidfile();
}

const graceful = (pid) => { try { isWin ? execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGTERM'); } catch { /* windowless detached child ignores it */ } };
const force = (pid) => { try { isWin ? execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGKILL'); } catch { /* */ } };

/** Stop a RECORDED-owned entry: graceful first, force only after RE-verifying the same start
 * identity + signature. Returns true once the pid is no longer alive. */
async function stopRecorded(entry, port, { label }) {
  const sig = { py: PY, uvicornSig: UVICORN_SIG, port };
  if (!alive(entry.pid) || !verifyRecordedIdentity(entry, procInfo(entry.pid), sig)) return true; // gone / no longer ours
  graceful(entry.pid);
  for (let i = 0; i < 20 && alive(entry.pid); i++) await sleep(150);
  if (alive(entry.pid)) {
    if (!verifyRecordedIdentity(entry, procInfo(entry.pid), sig)) {
      console.error(`${label}: pid ${entry.pid} no longer matches the recorded backend identity; refusing to force-kill`);
      return false;
    }
    force(entry.pid);
    for (let i = 0; i < 20 && alive(entry.pid); i++) await sleep(150);
  }
  return !alive(entry.pid);
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
  const owned = ownedTargets(port); // recorded + identity-verified only
  console.log(`backend   :${port}   ${backend.ok ? 'up' : 'DOWN'}` +
    (backend.ok ? `   planner=${backend.body?.plannerMode ?? '?'}   model-ready=${ready}` : '') +
    (listener.length ? `   pid=${listener.join(',')} ${owned.length ? '(launcher-owned)' : '(not launcher-owned)'}` : ''));
  console.log(`model     ${vlmBaseUrl}   ${model.ok ? 'up' : 'DOWN'}`);
  if (!model.ok) console.log(`          -> start your llama-server on :8973 (see scripts/vlm-eval/README.md); ` +
    `backend still runs, chat/plan will report "unavailable" until it is up`);
  console.log(`chat UI   http://localhost:${port}/        browser demo   http://localhost:${port}/fixture`);
  console.log(`note      reload the extension in chrome://extensions after a rebuild (manual, by design)`);
  return backend.ok;
}

const sig = (port) => ({ py: PY, uvicornSig: UVICORN_SIG, port });
const startOf = (pid) => procInfo(pid)?.start ?? null;

async function up() {
  const { port, plannerMode, vlmBaseUrl } = config(); // validates, may exit(1), no process touched

  // 1) Stop ONLY our recorded, identity-verified backend(s).
  for (const e of ownedTargets(port)) {
    console.log(`stopping our recorded backend pid ${e.pid}`);
    if (!await stopRecorded(e, port, { label: 'up' })) fail(`could not stop our recorded backend pid ${e.pid}`);
  }
  dropPidfileIfStale(port);

  // 2) Anything still on the port -- including a workspace uvicorn a developer started by hand
  //    (matching command line, but NOT recorded by this launcher) -- is an unknown collision.
  const others = pidsOnPort(port);
  if (others.length) fail(`:${port} is held by a process this launcher did not start (pid ${others.join(', ')}); ` +
    `not touching it. Stop it yourself or use PORT=<free port>.`);

  mkdirSync(resolve('test-results'), { recursive: true });
  const log = openSync(resolve('test-results/backend.log'), 'a');
  const args = ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'];
  // Test-only seam: a delay here lets a regression race a matching process onto the port
  // between preflight and our spawn. 0 in real use.
  const spawnDelay = Number(process.env.DEV_SPAWN_DELAY_MS || 0);
  if (spawnDelay > 0) await sleep(spawnDelay);
  const child = spawn(PY, args, {
    env: { ...process.env, PLANNER_MODE: plannerMode, VLM_BASE_URL: vlmBaseUrl },
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  });
  child.unref();
  let childStart = null;
  for (let i = 0; i < 10 && childStart == null && alive(child.pid); i++) { childStart = startOf(child.pid); if (childStart == null) await sleep(200); }
  const base = { version: PIDFILE_VERSION, port, cwd: CWD, python: PY, plannerMode, vlmBaseUrl,
    command: `${PY} ${args.join(' ')}`, startedAt: new Date().toISOString() };
  writePidfile({ ...base, pids: childStart ? [{ pid: child.pid, start: childStart }] : [], childPid: child.pid });
  console.log(`started backend (child pid ${child.pid}) (PLANNER_MODE=${plannerMode}, VLM_BASE_URL=${vlmBaseUrl}) -> test-results/backend.log`);

  /** PIDs we are ALLOWED to signal/persist: the ChildProcess we spawned, plus processes proven
   * to descend from it (ppid lineage) AND created no earlier than it. A matching command line
   * alone never qualifies -- that is how a race-winning manual uvicorn would sneak in. */
  const ownedByLineage = () => {
    const procs = procList();
    const line = descendantsOf(child.pid, procs);
    const ok = new Set([child.pid]);
    for (const pid of line) {
      if (pid === child.pid) continue;
      const info = procs.get(pid);
      if (info && (!childStart || startedNoEarlierThan(info.start, childStart))) ok.add(pid);
    }
    return ok;
  };

  const stopEverythingWeStarted = async () => {
    // The direct child first (we hold its handle -- unambiguously ours), then proven descendants.
    try { child.kill(); } catch { /* */ }
    for (const pid of ownedByLineage()) {
      graceful(pid);
      for (let i = 0; i < 15 && alive(pid); i++) await sleep(150);
      if (alive(pid)) force(pid);
    }
    removePidfile();
  };

  for (let i = 0; i < 40; i++) {
    const listeners = pidsOnPort(port);
    if (!alive(child.pid) && !listeners.length) { await stopEverythingWeStarted(); fail('backend process exited during startup; see test-results/backend.log'); }
    const h = await httpJson(`http://127.0.0.1:${port}/health`, 1000);
    if (h.ok) {
      const ours = ownedByLineage();
      const foreign = listeners.filter(p => !ours.has(p));
      if (foreign.length) {
        // Something won the bind race and it did NOT come from our child -> collision. Kill
        // only what we started; leave the foreign process running.
        await stopEverythingWeStarted();
        fail(`:${port} was bound by a process this run did not spawn (pid ${foreign.join(', ')}); aborting, it was left alive`);
      }
      if (!listeners.length) { await sleep(500); continue; } // health up but nothing LISTENING yet
      if (h.body?.status !== 'ok' || h.body?.plannerMode !== plannerMode) {
        await stopEverythingWeStarted();
        fail(`/health did not report the expected mode (${plannerMode}); got ${JSON.stringify(h.body)}`);
      }
      // Persist ONLY proven-owned pids that are alive (the child + its listening descendants).
      const procs = procList();
      const pids = [];
      for (const pid of ours) {
        if (!alive(pid)) continue;
        const s = procs.get(pid)?.start ?? startOf(pid);
        if (s) pids.push({ pid, start: s });
      }
      writePidfile({ ...base, pids, childPid: child.pid });
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
  const targets = ownedTargets(port); // recorded + identity-verified ONLY
  if (!targets.length) {
    dropPidfileIfStale(port); // clears legacy/malformed/all-exited metadata
    const others = pidsOnPort(port);
    console.log(others.length
      ? `no launcher-owned backend; :${port} held by pid ${others.join(', ')} (this launcher did not start it -- left alone)`
      : 'no launcher-owned backend running');
    process.exit(0);
  }
  let allStopped = true;
  for (const e of targets) {
    console.log(`stopping our backend pid ${e.pid}`);
    if (!await stopRecorded(e, port, { label: 'down' })) allStopped = false;
  }
  dropPidfileIfStale(port);
  if (!allStopped) { console.error('down: a verified-owned backend process did not stop'); process.exit(1); }
  console.log(`:${port} released`);
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'status') { await status(); }
else if (cmd === 'down') await down();
else { console.error('usage: node scripts/dev.mjs <up|status|down>'); process.exit(2); }
