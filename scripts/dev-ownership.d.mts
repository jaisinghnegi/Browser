export function isOwnedByCmdline(
  cmdline: string | null | undefined,
  opts: { py: string; uvicornSig?: string; port: number },
): boolean;
