import { describe, expect, it } from 'vitest';
import { readCapped } from '../extension/planner-io';

/** A Response whose body streams `chunks` one at a time, so tests can distinguish "rejected
 * from a declared Content-Length before any read" from "rejected mid-stream". */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return new Response(body, { headers });
}
const bytes = (n: number) => new Uint8Array(n).fill(65); // 'A'

describe('readCapped', () => {
  it('reads a small body under the limit', async () => {
    const response = streamed([new TextEncoder().encode('{"ok":true}')]);
    await expect(readCapped(response, 4096)).resolves.toBe('{"ok":true}');
  });

  it('rejects a declared Content-Length over the limit', async () => {
    // A stream that would resolve fine if actually read (small body) proves the rejection is
    // driven by the declared header, not by exceeding the byte cap while reading.
    const response = streamed([bytes(10)], { 'Content-Length': '999999' });
    await expect(readCapped(response, 4096)).rejects.toThrow('Oversized action');
  });

  it('rejects and cancels a headerless stream that exceeds the limit mid-read', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytes(3000)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body); // No Content-Length: chunked/undeclared length.
    await expect(readCapped(response, 4096)).rejects.toThrow('Oversized action');
    expect(cancelled).toBe(true);
  });

  it('accepts a headerless stream that stays exactly at the limit', async () => {
    const response = streamed([bytes(4096)]);
    const text = await readCapped(response, 4096);
    expect(text).toHaveLength(4096);
  });

  it('accepts a body assembled from multiple small chunks under the limit', async () => {
    const response = streamed([bytes(10), bytes(10), bytes(10)]);
    const text = await readCapped(response, 4096);
    expect(text).toHaveLength(30);
  });
});
