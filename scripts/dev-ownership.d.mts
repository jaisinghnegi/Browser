type Sig = { py: string; uvicornSig?: string; port: number };
export function isOwnedByCmdline(cmdline: string | null | undefined, opts: Sig): boolean;
export function verifyRecordedIdentity(
  recorded: { start?: string } | null | undefined,
  live: { cmdline?: string | null; start?: string } | null | undefined,
  opts: Sig,
): boolean;
export function pidfileIsUsable(
  meta: unknown,
  opts: { cwd: string; port: number },
): boolean;
