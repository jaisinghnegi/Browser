"""Mirrors tests/vlm-adapter.test.ts's 12 cases exactly -- one contract, two implementations,
held to the same test vectors so they can't silently drift apart. No network, no live model."""
from server.vlm_adapter import Candidate, ResolvedAbstain, ResolvedFill, Rejected, resolve_action

CANDIDATES = [
    Candidate(label='Shipping address', target_ref='target-uuid-1', allowed_value_refs=['ADDRESS_1']),
    Candidate(label='Phone number', target_ref='target-uuid-2', allowed_value_refs=['PHONE_1']),
]


def test_resolves_fill_to_trusted_target_ref():
    raw = '{"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1"}'
    assert resolve_action(raw, CANDIDATES) == ResolvedFill(target_ref='target-uuid-1', value_ref='ADDRESS_1')


def test_matches_labels_case_insensitively_and_trims_whitespace():
    raw = '{"action":"fill","target":"  phone NUMBER  ","valueRef":"PHONE_1"}'
    assert resolve_action(raw, CANDIDATES) == ResolvedFill(target_ref='target-uuid-2', value_ref='PHONE_1')


def test_resolves_abstain_with_no_candidates_needed():
    assert resolve_action('{"action":"abstain","target":null,"valueRef":null}', []) == ResolvedAbstain()


def test_rejects_unknown_target_label():
    raw = '{"action":"fill","target":"Email address","valueRef":"ADDRESS_1"}'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='unknown-target-label')


def test_rejects_ambiguous_label_matching_more_than_one_candidate():
    dup = [
        Candidate(label='Address', target_ref='target-uuid-a', allowed_value_refs=['ADDRESS_1']),
        Candidate(label='Address', target_ref='target-uuid-b', allowed_value_refs=['ADDRESS_2']),
    ]
    raw = '{"action":"fill","target":"Address","valueRef":"ADDRESS_1"}'
    assert resolve_action(raw, dup) == Rejected(reason='ambiguous-target-label')


def test_rejects_unauthorized_value_ref():
    raw = '{"action":"fill","target":"Shipping address","valueRef":"PHONE_1"}'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='unauthorized-value-ref')


def test_rejects_markdown_fenced_response():
    raw = '```json\n{"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1"}\n```'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='not-json-only')


def test_rejects_extra_prose_around_json():
    raw = 'Sure, here you go: {"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1"}'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='not-json-only')


def test_rejects_open_schema():
    raw = '{"action":"fill","target":"Shipping address","valueRef":"ADDRESS_1","script":"alert(1)"}'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='schema-not-closed')


def test_rejects_abstain_carrying_extra_fields():
    raw = '{"action":"abstain","target":"Shipping address","valueRef":null}'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='abstain-with-extra-fields')


def test_rejects_invalid_action_value():
    raw = '{"action":"submit","target":null,"valueRef":null}'
    assert resolve_action(raw, CANDIDATES) == Rejected(reason='invalid-action')


def test_rejects_malformed_json():
    assert resolve_action('{not json}', CANDIDATES) == Rejected(reason='invalid-json')
