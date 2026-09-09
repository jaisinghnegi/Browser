"""Bounded HTTP client shared by the local planner and text chat. Every failure
mode (unreachable, timeout, non-200, oversized, unparseable) raises VlmUnavailable; callers
must never invent a fill action when this raises. No redirects, no environment-derived proxy
(``trust_env=False``), a single total deadline, and the response body is capped while
streaming, not after buffering the whole thing.
"""
from __future__ import annotations

import asyncio
import json

import httpx

DEFAULT_MAX_RESPONSE_BYTES = 1_000_000  # generous but bounded; a real action is a tiny JSON object
DEFAULT_MAX_IMAGE_DATA_URL_BYTES = 5_000_000  # ~5MB of base64; well above any expected screenshot
DEFAULT_MAX_PROMPT_CHARS = 4_000

# Module-level bound on concurrent in-flight requests to the local model -- a single small GPU
# can't usefully serve many requests at once, and an unbounded caller could otherwise queue
# unboundedly many multi-second inference calls. Callers share this semaphore by default;
# pass a different one explicitly to isolate tests from each other.
_DEFAULT_CONCURRENCY_LIMIT = 1
_default_semaphore = asyncio.Semaphore(_DEFAULT_CONCURRENCY_LIMIT)

# Admission cap: the semaphore bounds ACTIVE calls, not the number of coroutines queued waiting
# for it. This counter bounds active + queued together, so a burst can't pile up an unbounded
# backlog of multi-second waiters. The check-and-increment below has no await between its two
# statements, so it is atomic under asyncio's single-threaded scheduling.
_DEFAULT_ADMISSION_LIMIT = 4
_in_system = 0


class VlmUnavailable(Exception):
    """Raised for any failure talking to the local VLM server. Signals 'unavailable', not
    'error to propagate raw' -- callers must return an explicit unavailable/invalid outcome,
    never a silently-invented deterministic fallback while claiming AI mode."""


async def plan_with_vlm(
    *,
    base_url: str,
    system_prompt: str,
    user_prompt: str,
    image_data_url: str | None = None,
    timeout_s: float = 30.0,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    max_image_data_url_bytes: int = DEFAULT_MAX_IMAGE_DATA_URL_BYTES,
    max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS,
    semaphore: asyncio.Semaphore | None = None,
    conversation: list[dict[str, str]] | None = None,
    max_output_tokens: int = 200,
) -> str:
    """Returns the raw model message content string, or raises VlmUnavailable.

    ``image_data_url`` is optional: omit it for a text-only call (the reference-only /plan
    path, which carries no screenshot -- protocol-2 image upload is separately gated). When
    given it must be a bounded ``data:image/`` URL.

    Caller's responsibility: base_url must already be a trusted, loopback-only endpoint --
    this function does not itself restrict which host it's pointed at.
    """
    # Input caps, not just output caps: an oversized/malformed image or a runaway prompt
    # should never even reach the model process.
    if image_data_url is not None:
        if not isinstance(image_data_url, str) or not image_data_url.startswith('data:image/'):
            raise VlmUnavailable('image_data_url is not a data: image URL')
        if len(image_data_url) > max_image_data_url_bytes:
            raise VlmUnavailable('image_data_url exceeds the size cap')
    if len(system_prompt) > max_prompt_chars or len(user_prompt) > max_prompt_chars:
        raise VlmUnavailable('prompt exceeds the length cap')
    if conversation is not None:
        if image_data_url is not None or not 1 <= len(conversation) <= 12:
            raise VlmUnavailable('invalid conversation')
        if any(m.get('role') not in ('user', 'assistant') or not isinstance(m.get('content'), str)
               or set(m) != {'role', 'content'} for m in conversation):
            raise VlmUnavailable('invalid conversation')
        if sum(len(m['content']) for m in conversation) > max_prompt_chars:
            raise VlmUnavailable('conversation exceeds the length cap')
    if not 1 <= max_output_tokens <= 512:
        raise VlmUnavailable('invalid output budget')

    user_content: list[dict] = []
    if image_data_url is not None:
        user_content.append({'type': 'image_url', 'image_url': {'url': image_data_url}})
    user_content.append({'type': 'text', 'text': user_prompt})
    body = {
        'model': 'qwen3-vl-4b',
        'temperature': 0,
        'max_tokens': max_output_tokens,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_content},
        ],
    }
    if conversation is not None:
        body['messages'] = [{'role': 'system', 'content': system_prompt}, *conversation]

    global _in_system
    sem = semaphore if semaphore is not None else _default_semaphore

    async def _run() -> bytes:
        # Bounded concurrency: at most `sem`'s count in flight against the local model at once.
        # The queue wait for `sem` is INSIDE the outer total deadline (below), so a backlog
        # can't make one call block past timeout_s.
        async with sem:
            # trust_env=False: never pick up HTTP_PROXY/HTTPS_PROXY and silently route a
            # "local" request somewhere else. follow_redirects left at httpx's default (False).
            async with httpx.AsyncClient(timeout=timeout_s, trust_env=False) as client:
                async with client.stream('POST', f'{base_url}/v1/chat/completions', json=body) as response:
                    if response.status_code != 200:
                        raise VlmUnavailable(f'planner HTTP {response.status_code}')
                    declared = response.headers.get('content-length')
                    if declared is not None:
                        try:
                            if int(declared) > max_response_bytes:
                                raise VlmUnavailable('oversized response (declared content-length)')
                        except ValueError:
                            pass  # Malformed header; the streamed cap below still applies.
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > max_response_bytes:
                            raise VlmUnavailable('oversized response (exceeded cap while streaming)')
                        chunks.append(chunk)
                    return b''.join(chunks)

    # Admission cap (active + queued): reject rather than pile up an unbounded waiter backlog.
    if _in_system >= _DEFAULT_ADMISSION_LIMIT:
        raise VlmUnavailable('planner queue is full')
    _in_system += 1
    try:
        # ONE elapsed deadline across queue wait + connect + every response chunk. A slow peer
        # trickling bytes just under the read timeout, or a long `sem` queue, still expires here.
        raw_body = await asyncio.wait_for(_run(), timeout=timeout_s)
    except (asyncio.TimeoutError, TimeoutError) as exc:
        raise VlmUnavailable('planner deadline exceeded') from exc
    except httpx.HTTPError as exc:
        # Includes connect errors, timeouts, redirect-not-followed, etc. -- all "unavailable".
        raise VlmUnavailable(f'planner request failed: {type(exc).__name__}') from exc
    finally:
        _in_system -= 1

    try:
        payload = json.loads(raw_body)
        content = payload['choices'][0]['message']['content']
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise VlmUnavailable('planner returned an unparseable response') from exc
    if not isinstance(content, str):
        raise VlmUnavailable('planner response content was not a string')
    return content


async def chat_with_vlm(
    *,
    base_url: str,
    system_prompt: str,
    conversation: list[dict[str, str]],
    timeout_s: float = 30.0,
    max_output_tokens: int = 512,
    max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS,
    semaphore: asyncio.Semaphore | None = None,
) -> str:
    """Text-only chat turn against the local model. Thin wrapper over the shared
    ``plan_with_vlm`` transport (same total deadline / admission cap / no-proxy / streamed
    cap): NO image, NO tools, NO action semantics -- the reply is a plain string for display.
    Every failure still raises VlmUnavailable."""
    return await plan_with_vlm(
        base_url=base_url, system_prompt=system_prompt, user_prompt='',
        conversation=conversation, timeout_s=timeout_s, max_output_tokens=max_output_tokens,
        max_prompt_chars=max_prompt_chars, semaphore=semaphore,
    )
