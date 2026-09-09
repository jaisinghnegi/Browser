"""Tests for the real-model /plan path (PLANNER_MODE=vlm). Mocked httpx transport for the
required cases; one skippable smoke against a live local llama-server.

The model's output is always run through resolve_action + a binding re-check, so a wrong label
or invented value can never produce a fill; every failure raises VlmPlanRejected and the route
returns 502 with no model text.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import httpx
import pytest
from fastapi.testclient import TestClient

from server import main
from server.models import FillAction
from server.vlm_planner import VlmPlanRejected, plan_action

REQUEST = {
    'protocol': 1,
    'taskId': '11111111-1111-4111-8111-111111111111',
    'observationId': '22222222-2222-4222-8222-222222222222',
    'target': '33333333-3333-4333-8333-333333333333',
    'fieldKind': 'shipping-address',
    'valueRef': 'ADDRESS_1',
}
BASE_URL = 'http://127.0.0.1:8973'


def _mock_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs['transport'] = httpx.MockTransport(handler)
        return real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, '__init__', patched_init)


def _model_says(text: str):
    def handler(request):
        return httpx.Response(200, json={'choices': [{'message': {'content': text}}]})
    return handler


def _req() -> main.PlannerRequest:
    return main.PlannerRequest.model_validate(REQUEST)


@pytest.mark.anyio
async def test_valid_model_fill_produces_a_bound_action(monkeypatch):
    _mock_transport(monkeypatch, _model_says(
        json.dumps({'action': 'fill', 'target': 'Shipping address', 'valueRef': 'ADDRESS_1'})))
    action = await plan_action(_req(), base_url=BASE_URL)
    assert isinstance(action, FillAction)
    assert action.taskId == REQUEST['taskId']
    assert action.observationId == REQUEST['observationId']
    assert action.target == REQUEST['target']       # trusted binding value, not the model's string
    assert action.valueRef == 'ADDRESS_1'
    assert action.actionId != REQUEST['target']     # freshly minted


@pytest.mark.anyio
async def test_model_abstain_is_rejected(monkeypatch):
    _mock_transport(monkeypatch, _model_says(
        json.dumps({'action': 'abstain', 'target': None, 'valueRef': None})))
    with pytest.raises(VlmPlanRejected):
        await plan_action(_req(), base_url=BASE_URL)


@pytest.mark.anyio
async def test_model_prose_is_rejected(monkeypatch):
    _mock_transport(monkeypatch, _model_says('Sure! Here is the action: {"action":"fill"...}'))
    with pytest.raises(VlmPlanRejected):
        await plan_action(_req(), base_url=BASE_URL)


@pytest.mark.anyio
async def test_model_targeting_a_different_label_cannot_fill(monkeypatch):
    _mock_transport(monkeypatch, _model_says(
        json.dumps({'action': 'fill', 'target': 'Card number', 'valueRef': 'ADDRESS_1'})))
    with pytest.raises(VlmPlanRejected):
        await plan_action(_req(), base_url=BASE_URL)


@pytest.mark.anyio
async def test_model_inventing_a_value_ref_cannot_fill(monkeypatch):
    _mock_transport(monkeypatch, _model_says(
        json.dumps({'action': 'fill', 'target': 'Shipping address', 'valueRef': 'PASSWORD_1'})))
    with pytest.raises(VlmPlanRejected):
        await plan_action(_req(), base_url=BASE_URL)


@pytest.mark.anyio
async def test_model_unreachable_is_rejected(monkeypatch):
    def handler(request):
        raise httpx.ConnectError('connection refused', request=request)
    _mock_transport(monkeypatch, handler)
    with pytest.raises(VlmPlanRejected):
        await plan_action(_req(), base_url=BASE_URL)


def test_route_vlm_mode_returns_bound_action(monkeypatch):
    monkeypatch.setattr(main, 'PLANNER_MODE', 'vlm')
    _mock_transport(monkeypatch, _model_says(
        json.dumps({'action': 'fill', 'target': 'Shipping address', 'valueRef': 'ADDRESS_1'})))
    r = TestClient(main.app).post('/plan', json=REQUEST)
    assert r.status_code == 200
    body = r.json()
    assert body['action'] == 'fill' and body['valueRef'] == 'ADDRESS_1'
    assert body['taskId'] == REQUEST['taskId']


def test_route_vlm_mode_fails_closed_without_leaking_model_text(monkeypatch):
    monkeypatch.setattr(main, 'PLANNER_MODE', 'vlm')
    _mock_transport(monkeypatch, _model_says('leak address 42 Secret Lane {"action":"fill"}'))
    r = TestClient(main.app).post('/plan', json=REQUEST)
    assert r.status_code == 502
    assert r.json() == {'error': 'planner unavailable'}
    assert 'Secret Lane' not in r.text


def test_route_default_mode_is_still_deterministic(monkeypatch):
    # no PLANNER_MODE override -> deterministic path, unchanged.
    r = TestClient(main.app).post('/plan', json=REQUEST)
    assert r.status_code == 200
    assert r.json()['valueRef'] == 'ADDRESS_1'


def test_health_reports_planner_mode():
    assert TestClient(main.app).get('/health').json() == {'status': 'ok', 'plannerMode': 'deterministic'}


@pytest.mark.anyio
async def test_real_smoke_against_running_llama_server():
    base = os.environ.get('VLM_BASE_URL', BASE_URL)
    try:
        with urllib.request.urlopen(f'{base}/health', timeout=2) as resp:
            if resp.status != 200:
                pytest.skip('local llama-server did not answer health 200')
    except (urllib.error.URLError, OSError):
        pytest.skip('no local llama-server on the expected port (personal-machine artifact)')
    action = await plan_action(main.PlannerRequest.model_validate(REQUEST), base_url=base)
    assert isinstance(action, FillAction)
    assert action.target == REQUEST['target'] and action.valueRef == 'ADDRESS_1'
