import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft7Validator

from server.main import app

client = TestClient(app)
REQUEST = {
    'protocol': 1,
    'taskId': '11111111-1111-4111-8111-111111111111',
    'observationId': '22222222-2222-4222-8222-222222222222',
    'target': '33333333-3333-4333-8333-333333333333',
    'fieldKind': 'shipping-address', 'valueRef': 'ADDRESS_1',
}
SCHEMA = json.loads((Path(__file__).parents[1] / 'shared/protocol.schema.json').read_text())


def test_returns_bound_action_without_secret(caplog):
    response = client.post('/plan', json=REQUEST)
    assert response.status_code == 200
    action = response.json()
    Draft7Validator({**SCHEMA, '$ref': '#/definitions/action'}).validate(action)
    assert action['taskId'] == REQUEST['taskId']
    assert action['observationId'] == REQUEST['observationId']
    assert action['target'] == REQUEST['target']
    assert action['valueRef'] == 'ADDRESS_1'
    assert action['action'] == 'fill'
    assert 'Vault Lane' not in caplog.text


@pytest.mark.parametrize('change', [
    {'secret': '991 Vault Lane'}, {'target': '991 Vault Lane'},
    {'valueRef': 'PASSWORD_1'}, {'protocol': '1'}, {'protocol': True},
    {'screenshot': '991 Vault Lane'}, {'fieldKind': 'password'},
])
def test_rejects_invalid_request_without_echo_or_log(change, caplog):
    response = client.post('/plan', json={**REQUEST, **change})
    assert response.status_code == 422
    assert response.json() == {'error': 'Invalid planner request'}
    assert '991 Vault Lane' not in response.text + caplog.text


def test_shared_schema_rejects_same_invalid_shapes():
    validator = Draft7Validator({**SCHEMA, '$ref': '#/definitions/request'})
    validator.validate(REQUEST)
    for invalid in [{**REQUEST, 'extra': 'secret'}, {**REQUEST, 'protocol': True},
                    {**REQUEST, 'valueRef': 'PASSWORD_1'}]:
        assert list(validator.iter_errors(invalid))


def test_fixture_is_local_and_has_separate_visible_value():
    response = client.get('/fixture')
    assert response.status_code == 200
    assert '71 Visible Road' in response.text
    assert '991 Vault Lane' not in response.text
    assert 'id="shipping-address"' in response.text


def test_fixture_preview_variant_is_smaller_and_still_local():
    response = client.get('/fixture', params={'variant': 'preview'})
    assert response.status_code == 200
    assert 'id="shipping-address"' in response.text
    assert '14 Baker Rd, Testville 00000' in response.text  # a synthetic address to redact
    assert '991 Vault Lane' not in response.text            # vault value never in the page
    # default (no variant) is unchanged
    assert '71 Visible Road' in client.get('/fixture').text


def test_malformed_json_is_not_echoed():
    response = client.post('/plan', content='{"991 Vault Lane"', headers={'content-type': 'application/json'})
    assert response.status_code == 422
    assert '991 Vault Lane' not in response.text
