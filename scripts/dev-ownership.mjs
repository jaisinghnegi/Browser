// Safety-critical ownership predicates for scripts/dev.mjs, kept pure so they can be
// unit-tested fast (tests/dev-ownership.test.ts) without spawning processes. The launcher may
// signal a process ONLY when isOwnedByCmdline() AND verifyRecordedIdentity() both hold.

/** True iff `cmdline` is unmistakably THIS workspace's backend on `port`: it must contain the
 * exact venv python path, `uvicorn server.main:app`, and `--port <port>` as a whole token.
 * Anything else -- unrelated app, different venv, different port, empty -- is false. */
export function isOwnedByCmdline(cmdline, { py, uvicornSig = 'uvicorn server.main:app', port }) {
  if (!cmdline || typeof cmdline !== 'string' || !py || !Number.isInteger(port)) return false;
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  const c = norm(cmdline);
  return c.includes(norm(py))
    && c.includes(uvicornSig.toLowerCase())
    && new RegExp(`--port\\s+${port}(?!\\d)`).test(c);
}

/** A recorded pidfile entry authorises a signal ONLY if the LIVE process at that PID still has
 * both the matching command line AND the exact recorded OS start identity (creation time).
 * This defeats PID reuse: a new process that happens to land on the old PID has a different
 * start time. Missing/blank identity on either side => not owned. */
export function verifyRecordedIdentity(recorded, live, { py, uvicornSig, port }) {
  if (!recorded || !live) return false;
  if (!recorded.start || !live.start || String(recorded.start) !== String(live.start)) return false;
  return isOwnedByCmdline(live.cmdline, { py, uvicornSig, port });
}

/** The set of PIDs that are `root` or a descendant of it, from a process snapshot
 * (`{ [pid]: { ppid, start } }` or a Map). Cycle-safe. `root` is always included. This is the
 * lineage proof: a process the launcher may adopt/kill must trace back to the ChildProcess it
 * spawned -- a current command line is NOT sufficient. */
export function descendantsOf(root, procMap) {
  const get = procMap instanceof Map ? (k) => procMap.get(k) : (k) => procMap[k];
  const entries = procMap instanceof Map ? [...procMap.entries()] : Object.entries(procMap).map(([k, v]) => [Number(k), v]);
  const childrenByPpid = new Map();
  for (const [pid, info] of entries) {
    if (!info || !Number.isInteger(info.ppid)) continue;
    (childrenByPpid.get(info.ppid) ?? childrenByPpid.set(info.ppid, []).get(info.ppid)).push(pid);
  }
  const out = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const c of childrenByPpid.get(queue.shift()) ?? []) if (!out.has(c)) { out.add(c); queue.push(c); }
  }
  void get; // reserved for callers that also want per-pid info
  return out;
}

/** May we FORCE-kill `recorded` ({pid,start}) right now? Only if, in the FRESH process
 * snapshot `snap`, that exact PID still has the recorded start identity AND still descends
 * from `rootPid`. Defeats the "descendant exited, PID reused during the graceful wait" race --
 * the replacement has a different start time (and usually a different lineage). */
export function mayForce(recorded, snap, rootPid) {
  const get = snap instanceof Map ? (k) => snap.get(k) : (k) => snap[k];
  const live = get(recorded.pid);
  if (!live || !live.start || !recorded.start || String(live.start) !== String(recorded.start)) return false;
  return descendantsOf(rootPid, snap).has(recorded.pid);
}

/** True iff `childStart` <= `descStart` (a real descendant is created no earlier than its
 * ancestor). Both must be parseable timestamps; if either is not, returns false (conservative
 * -- an unverifiable candidate is not adopted). */
export function startedNoEarlierThan(descStart, childStart, slackMs = 2000) {
  const d = Date.parse(descStart), c = Date.parse(childStart);
  if (Number.isNaN(d) || Number.isNaN(c)) return false;
  return d >= c - slackMs;
}

/** A pidfile is trustworthy only in the current format, for this workspace and port, with a
 * pids array of {pid,start} entries. Legacy/partial/foreign metadata authorises nothing. */
export function pidfileIsUsable(meta, { cwd, port }) {
  return !!meta
    && meta.version === 2
    && meta.cwd === cwd
    && meta.port === port
    && Array.isArray(meta.pids)
    && meta.pids.every((e) => e && Number.isInteger(e.pid) && typeof e.start === 'string' && e.start.length > 0);
}
