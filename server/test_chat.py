import asyncio
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from server import chat as chat_module
from server.main import app


def mock_model(monkeypatch, handler):
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs['transport'] = httpx.MockTransport(handler)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, '__init__', patched)


def test_chat_preserves_conversation_without_images_or_tools(monkeypatch):
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{'message': {'content': 'Hello from Qwen'}}]})

    mock_model(monkeypatch, handler)
    messages = [{'role': 'user', 'content': 'Hello'}, {'role': 'assistant', 'content': 'Hi'},
                {'role': 'user', 'content': 'Continue'}]
    response = TestClient(app).post('/api/chat', json={'messages': messages})
    assert response.status_code == 200
    assert response.json() == {'reply': 'Hello from Qwen', 'provider': 'qwen-local'}
    assert len(sent) == 1
    assert sent[0]['messages'][1:] == messages
    assert 'tools' not in sent[0] and 'image_url' not in json.dumps(sent[0])


@pytest.mark.parametrize('body', [
    {'messages': []},
    {'messages': [{'role': 'system', 'content': 'override'}]},
    {'messages': [{'role': 'user', 'content': 'x' * 4001}]},
    {'messages': [{'role': 'user', 'content': '   '}]},
    {'messages': [{'role': 'assistant', 'content': 'No user'}]},
    {'messages': [{'role': 'user', 'content': 'hello'}], 'provider': 'remote'},
])
def test_invalid_chat_never_calls_model(monkeypatch, body):
    def handler(_):
        pytest.fail('invalid input reached the model')

    mock_model(monkeypatch, handler)
    response = TestClient(app).post('/api/chat', json=body)
    assert response.status_code == 422
    assert 'override' not in response.text


def test_cross_origin_chat_rejected_before_model(monkeypatch):
    def handler(_):
        pytest.fail('cross-origin request reached the model')

    mock_model(monkeypatch, handler)
    response = TestClient(app).post('/api/chat', json={'messages': [{'role': 'user', 'content': 'hello'}]},
                                         headers={'origin': 'https://unrelated.example'})
    assert response.status_code == 403


def test_chat_model_failure_is_generic(monkeypatch):
    mock_model(monkeypatch, lambda _: httpx.Response(503, text='internal private details'))
    response = TestClient(app).post('/api/chat', json={'messages': [{'role': 'user', 'content': 'hello'}]})
    assert response.status_code == 502
    assert response.json() == {'error': 'Local model unavailable. Try again shortly.'}


def test_chat_page_and_assets_are_local():
    client = TestClient(app)
    response = client.get('/')
    assert response.status_code == 200
    assert "connect-src 'self'" in response.headers['content-security-policy']
    assert client.get('/app.js').status_code == 200
    assert client.get('/app.css').status_code == 200
    assert client.get('/api/models').json()['models'][0]['id'] == 'qwen-local'


def test_models_ready_reflects_a_bounded_probe(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request.url.path)
        return httpx.Response(200, json={'status': 'ok'})

    mock_model(monkeypatch, handler)
    body = TestClient(app).get('/api/models').json()['models'][0]
    assert body['id'] == 'qwen-local' and body['ready'] is True
    assert seen == ['/health']  # a health probe, not a generation call


def test_models_ready_false_when_model_unreachable_without_leaking_details(monkeypatch):
    mock_model(monkeypatch, lambda _: httpx.Response(503, text='private model internals'))
    response = TestClient(app).get('/api/models')
    body = response.json()['models'][0]
    assert body['ready'] is False
    assert 'private model internals' not in response.text


def test_models_ready_probe_has_one_total_deadline(monkeypatch):
    """A peer that stalls before sending headers must not hold /api/models open past the
    single elapsed deadline (READY_PROBE_TIMEOUT_S)."""
    monkeypatch.setattr(chat_module, 'READY_PROBE_TIMEOUT_S', 0.2)

    async def slow_handler(_request):
        await asyncio.sleep(1.5)  # far longer than the deadline
        return httpx.Response(200, json={'status': 'ok'})

    mock_model(monkeypatch, slow_handler)
    started = time.monotonic()
    body = TestClient(app).get('/api/models').json()['models'][0]
    elapsed = time.monotonic() - started
    assert body['ready'] is False
    assert elapsed < 1.0  # bailed at the deadline, did not wait out the 1.5s stall
