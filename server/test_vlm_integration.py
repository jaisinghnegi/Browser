"""Integration tests for the VLM client + adapter chain, using httpx.MockTransport -- no real
network, no live model required for the required cases below. server/main.py's /plan endpoint
is untouched by any of this; these tests exercise only the new, unwired vlm_client/vlm_adapter
modules.

One additional test (test_real_smoke_against_running_llama_server) exercises the real path
against an actually-running local llama-server, matching Astra's ask for "real Qwen smoke
through that same Python adapter on safe fixtures" -- it self-skips if no server answers
health on the expected port, since that's a personal-machine artifact (~3.6GB runtime/model,
never installed in CI or committed to this repo).
"""
import asyncio
import json

import httpx
import pytest

from server.vlm_adapter import Candidate, ResolvedAbstain, ResolvedFill, Rejected, resolve_action
from server.vlm_client import VlmUnavailable, plan_with_vlm
from server.vlm_dev_runner import ALLOWED_FIXTURE_IDS, run_fixture

CANDIDATES = [Candidate(label='Shipping address', target_ref='9b218ba3-aa95-4697-a895-ff25d568ca25', allowed_value_refs=['ADDRESS_1'])]
DUMMY_IMAGE = 'data:image/png;base64,aGVsbG8='


def _client_with_transport(transport: httpx.MockTransport, monkeypatch: pytest.MonkeyPatch) -> None:
    """Patches httpx.AsyncClient so plan_with_vlm's internal client uses this transport instead
    of making a real connection."""
    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs['transport'] = transport
        return real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, '__init__', patched_init)


@pytest.mark.anyio
async def test_model_unavailable_connection_refused(monkeypatch):
    def handler(request):
        raise httpx.ConnectError('connection refused', request=request)
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    with pytest.raises(VlmUnavailable):
        await plan_with_vlm(base_url='http://127.0.0.1:1', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)


@pytest.mark.anyio
async def test_model_unavailable_non_200(monkeypatch):
    def handler(request):
        return httpx.Response(503, json={'error': 'model not loaded'})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    with pytest.raises(VlmUnavailable):
        await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)


@pytest.mark.anyio
async def test_malformed_response_body_raises_unavailable(monkeypatch):
    def handler(request):
        return httpx.Response(200, content=b'not json at all')
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    with pytest.raises(VlmUnavailable):
        await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)


@pytest.mark.anyio
async def test_oversized_declared_content_length_raises_unavailable(monkeypatch):
    def handler(request):
        body = json.dumps({'choices': [{'message': {'content': '{}'}}]}).encode()
        return httpx.Response(200, content=body, headers={'content-length': '999999999'})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    with pytest.raises(VlmUnavailable, match='oversized'):
        await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)


@pytest.mark.anyio
async def test_oversized_actual_body_raises_unavailable_even_without_header(monkeypatch):
    huge_content = json.dumps({'choices': [{'message': {'content': 'x' * 2_000_000}}]})
    def handler(request):
        return httpx.Response(200, content=huge_content.encode())
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    with pytest.raises(VlmUnavailable, match='oversized'):
        await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE, max_response_bytes=1000)


@pytest.mark.anyio
async def test_correct_fill_resolves_through_adapter(monkeypatch):
    def handler(request):
        content = json.dumps({'action': 'fill', 'target': 'Shipping address', 'valueRef': 'ADDRESS_1'})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    raw = await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)
    assert resolve_action(raw, CANDIDATES) == ResolvedFill(target_ref='9b218ba3-aa95-4697-a895-ff25d568ca25', value_ref='ADDRESS_1')


@pytest.mark.anyio
async def test_correct_abstain_resolves_through_adapter(monkeypatch):
    def handler(request):
        content = json.dumps({'action': 'abstain', 'target': None, 'valueRef': None})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    raw = await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)
    assert resolve_action(raw, []) == ResolvedAbstain()


@pytest.mark.anyio
async def test_unknown_target_label_rejected_by_adapter_not_the_client(monkeypatch):
    def handler(request):
        content = json.dumps({'action': 'fill', 'target': 'Password', 'valueRef': 'ADDRESS_1'})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    raw = await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='unknown-target-label')


@pytest.mark.anyio
async def test_ambiguous_target_label_rejected_by_adapter(monkeypatch):
    def handler(request):
        content = json.dumps({'action': 'fill', 'target': 'Address', 'valueRef': 'ADDRESS_1'})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    dup = [
        Candidate(label='Address', target_ref='ae7d5cba-cfa1-43cf-96eb-00bc0bec382f', allowed_value_refs=['ADDRESS_1']),
        Candidate(label='Address', target_ref='d038ae3a-6cea-4c30-a0b3-af43b4dfbfdd', allowed_value_refs=['ADDRESS_2']),
    ]
    raw = await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)
    assert resolve_action(raw, dup) == Rejected(reason='ambiguous-target-label')


@pytest.mark.anyio
async def test_extra_field_in_model_json_rejected_by_adapter(monkeypatch):
    def handler(request):
        content = json.dumps({'action': 'fill', 'target': 'Shipping address', 'valueRef': 'ADDRESS_1', 'confidence': 0.9})
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    raw = await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='schema-not-closed')


@pytest.mark.anyio
async def test_real_smoke_against_running_llama_server():
    """Self-skips only when nothing is listening on 127.0.0.1:8973 at all -- that
    runtime/model (~3.6GB) is a personal-machine artifact, never installed in CI. If something
    IS listening there but answers unhealthily or is serving the wrong model, this must FAIL,
    not silently skip -- a skip is for "the optional runtime isn't installed", never a way to
    hide "the server is present but broken" or "the wrong model got loaded"."""
    base_url = 'http://127.0.0.1:8973'
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            health = await client.get(f'{base_url}/health')
    except httpx.TransportError:
        # No response was ever received at all (connection refused, timed out establishing a
        # connection, etc.) -- the optional runtime genuinely isn't there. Anything that DID
        # get a response, even an unhealthy one, falls through to the asserts below and fails.
        pytest.skip('no local llama-server listening on 8973 (optional runtime not installed)')
    assert health.status_code == 200, f'llama-server on 8973 answered but is unhealthy: {health.status_code} {health.text}'

    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
        props = await client.get(f'{base_url}/props')
    loaded_model_path = props.json().get('model_path') or props.json().get('default_generation_settings', {}).get('model')
    assert loaded_model_path and 'Qwen3VL-4B-Instruct-Q4_K_M' in loaded_model_path, (
        f'llama-server on 8973 is running but not serving the expected model: {loaded_model_path!r}'
    )

    for fixture_id in sorted(ALLOWED_FIXTURE_IDS):
        result = await run_fixture(fixture_id, base_url)
        assert result['outcome'] == 'resolved', f'{fixture_id}: {result}'


@pytest.mark.anyio
async def test_total_deadline_expires_on_a_trickling_response(monkeypatch):
    """A peer that trickles bytes forever, each chunk under any per-read timeout, must still
    hit the single elapsed deadline."""
    async def slow_body():
        for _ in range(50):
            await asyncio.sleep(0.05)
            yield b'x'
    def handler(request):
        return httpx.Response(200, content=slow_body())
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    with pytest.raises(VlmUnavailable, match='deadline'):
        await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u',
                            image_data_url=DUMMY_IMAGE, timeout_s=0.3)


@pytest.mark.anyio
async def test_queue_wait_counts_toward_the_deadline(monkeypatch):
    """Time spent waiting for the concurrency semaphore is inside the deadline, not on top of it."""
    def handler(request):
        return httpx.Response(200, json={'choices': [{'message': {'content': '{}'}}]})
    _client_with_transport(httpx.MockTransport(handler), monkeypatch)
    held = asyncio.Semaphore(1)
    await held.acquire()  # nobody will release it -> the call below can never enter
    try:
        with pytest.raises(VlmUnavailable, match='deadline'):
            await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u',
                                image_data_url=DUMMY_IMAGE, timeout_s=0.2, semaphore=held)
    finally:
        held.release()


@pytest.mark.anyio
async def test_admission_cap_rejects_a_full_queue(monkeypatch):
    import server.vlm_client as vc
    monkeypatch.setattr(vc, '_in_system', vc._DEFAULT_ADMISSION_LIMIT)
    with pytest.raises(VlmUnavailable, match='queue is full'):
        await plan_with_vlm(base_url='http://x', system_prompt='s', user_prompt='u', image_data_url=DUMMY_IMAGE)
