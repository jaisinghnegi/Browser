"""Bounded HTTP client to a local llama-server instance -- NOT wired into /plan. Every failure
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


class VlmUnavailable(Exception):
    """Raised for any failure talking to the local VLM server. Signals 'unavailable', not
    'error to propagate raw' -- callers must return an explicit unavailable/invalid outcome,
    never a silently-invented deterministic fallback while claiming AI mode."""


async def plan_with_vlm(
    *,
    base_url: str,
    system_prompt: str,
    user_prompt: str,
    image_data_url: str,
    timeout_s: float = 30.0,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    max_image_data_url_bytes: int = DEFAULT_MAX_IMAGE_DATA_URL_BYTES,
    max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS,
    semaphore: asyncio.Semaphore | None = None,
) -> str:
    """Returns the raw model message content string, or raises VlmUnavailable.

    Caller's responsibility: base_url must already be a trusted, loopback-only endpoint --
    this function does not itself restrict which host it's pointed at.
    """
    # Input caps, not just output caps: an oversized/malformed image or a runaway prompt
    # should never even reach the model process.
    if not isinstance(image_data_url, str) or not image_data_url.startswith('data:image/'):
        raise VlmUnavailable('image_data_url is not a data: image URL')
    if len(image_data_url) > max_image_data_url_bytes:
        raise VlmUnavailable('image_data_url exceeds the size cap')
    if len(system_prompt) > max_prompt_chars or len(user_prompt) > max_prompt_chars:
        raise VlmUnavailable('prompt exceeds the length cap')

    body = {
        'model': 'qwen3-vl-4b',
        'temperature': 0,
        'max_tokens': 200,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': image_data_url}},
                {'type': 'text', 'text': user_prompt},
            ]},
        ],
    }

    sem = semaphore if semaphore is not None else _default_semaphore
    try:
        # Bounded concurrency: at most `sem`'s count in flight against the local model at once.
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
                    raw_body = b''.join(chunks)
    except httpx.HTTPError as exc:
        # Includes connect errors, timeouts, redirect-not-followed, etc. -- all "unavailable".
        raise VlmUnavailable(f'planner request failed: {type(exc).__name__}') from exc

    try:
        payload = json.loads(raw_body)
        content = payload['choices'][0]['message']['content']
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise VlmUnavailable('planner returned an unparseable response') from exc
    if not isinstance(content, str):
        raise VlmUnavailable('planner response content was not a string')
    return content
