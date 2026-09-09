// The safety-critical predicate for scripts/dev.mjs, kept pure so it can be unit-tested fast
// (tests/dev-ownership.test.ts) without spawning processes. A launcher may only stop a process
// this returns true for.

/** True iff `cmdline` is unmistakably THIS workspace's backend on `port`: it must contain the
 * exact venv python path, `uvicorn server.main:app`, and `--port <port>` as a whole token.
 * Anything else -- an unrelated app, a different venv, a different port, or no cmdline at all
 * -- is false. Path separators and case are normalised so Windows/POSIX both work. */
export function isOwnedByCmdline(cmdline, { py, uvicornSig = 'uvicorn server.main:app', port }) {
  if (!cmdline || typeof cmdline !== 'string' || !py || !Number.isInteger(port)) return false;
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  const c = norm(cmdline);
  return c.includes(norm(py))
    && c.includes(uvicornSig.toLowerCase())
    && new RegExp(`--port\\s+${port}(?!\\d)`).test(c);
}
