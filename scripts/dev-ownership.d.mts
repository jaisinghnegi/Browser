type Sig = { py: string; uvicornSig?: string; port: number };
export function isOwnedByCmdline(cmdline: string | null | undefined, opts: Sig): boolean;
export function verifyRecordedIdentity(
  recorded: { start?: string } | null | undefined,
  live: { cmdline?: string | null; start?: string } | null | undefined,
  opts: Sig,
): boolean;
export function descendantsOf(
  root: number,
  procMap: Record<number, { ppid: number; start?: string }> | Map<number, { ppid: number; start?: string }>,
): Set<number>;
export function startedNoEarlierThan(descStart: string, childStart: string, slackMs?: number): boolean;
export function pidfileIsUsable(
  meta: unknown,
  opts: { cwd: string; port: number },
): boolean;
