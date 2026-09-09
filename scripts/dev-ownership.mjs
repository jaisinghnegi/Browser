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
