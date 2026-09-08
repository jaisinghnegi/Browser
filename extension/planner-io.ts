/** Chrome-API-free so it can be unit tested directly against the standard fetch Response type. */

/** Reads at most `limit` bytes so a misbehaving or compromised planner cannot OOM the caller
 * by streaming an unbounded body before any size check runs. Rejects on a declared
 * Content-Length over the limit without reading any body bytes, and also rejects mid-stream
 * (cancelling the reader) if an undeclared or understated body exceeds the limit anyway. */
export async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('Content-Length');
  if (declared && Number(declared) > limit) throw new Error('Oversized action');
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('Oversized action');
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[]).text();
}
