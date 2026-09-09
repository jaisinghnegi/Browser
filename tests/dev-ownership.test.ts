import { describe, expect, it } from 'vitest';
import { isOwnedByCmdline } from '../scripts/dev-ownership.mjs';

const PY = 'C:\\Users\\dev\\proj\\.venv\\Scripts\\python.exe';
const ours = (port: number) =>
  `"${PY}" -m uvicorn server.main:app --host 127.0.0.1 --port ${port} --no-access-log`;

describe('isOwnedByCmdline — the launcher may only stop a process this matches', () => {
  it('matches our exact venv + uvicorn + port', () => {
    expect(isOwnedByCmdline(ours(8171), { py: PY, port: 8171 })).toBe(true);
    // path-separator / case differences are normalised
    expect(isOwnedByCmdline(ours(8171).replace(/\\/g, '/').toUpperCase(), { py: PY, port: 8171 })).toBe(true);
  });

  it('rejects a different port (a substring-y one too)', () => {
    expect(isOwnedByCmdline(ours(8171), { py: PY, port: 817 })).toBe(false);
    expect(isOwnedByCmdline(ours(8171), { py: PY, port: 81710 })).toBe(false);
    expect(isOwnedByCmdline(ours(9000), { py: PY, port: 8171 })).toBe(false);
  });

  it('rejects a different python / venv', () => {
    const other = `"C:\\Python312\\python.exe" -m uvicorn server.main:app --port 8171`;
    expect(isOwnedByCmdline(other, { py: PY, port: 8171 })).toBe(false);
  });

  it('rejects an unrelated app that merely holds the port', () => {
    for (const cl of [
      'node C:/tools/devserver.js --port 8171',
      '"C:/Program Files/nginx/nginx.exe"',
      `"${PY}" -m http.server 8171`,               // our python, but not our app
      `"${PY}" -m uvicorn other.app:app --port 8171`, // our python + uvicorn, wrong app
    ]) {
      expect(isOwnedByCmdline(cl, { py: PY, port: 8171 })).toBe(false);
    }
  });

  it('rejects missing/garbage input safely', () => {
    for (const bad of [null, undefined, '', 42 as unknown as string]) {
      expect(isOwnedByCmdline(bad as string, { py: PY, port: 8171 })).toBe(false);
    }
    expect(isOwnedByCmdline(ours(8171), { py: '', port: 8171 })).toBe(false);
    expect(isOwnedByCmdline(ours(8171), { py: PY, port: NaN })).toBe(false);
  });
});
