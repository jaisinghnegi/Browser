"""Backend adapter groundwork (synthetic inputs only) -- NOT wired into /plan, which keeps its
tested deterministic Protocol-1 behavior completely unchanged until Protocol-2 is reviewed.

Port of scripts/vlm-eval/adapter.mjs's exact semantics, with the same test vectors, so both
implementations are held to one contract rather than drifting independently. The model's
free-text ``target`` label is never itself an executable reference -- it is only used to look
up one pre-authorized entry in a caller-supplied ``candidates`` list (standing in for what a
real observation/binding step would supply); the ``target_ref`` actually returned is always the
trusted value from that candidate, never anything the model invented.
"""
from __future__ import annotations

import json
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

from server.models import Id

_CLOSED_KEYS = frozenset({'action', 'target', 'valueRef'})
# Matches the bounded reference vocabulary this prototype's protocol actually uses
# (server/models.py's FillAction.valueRef) -- a candidate can never authorize an arbitrary
# string as a valueRef, only one from this fixed set.
_VALUE_REF = Annotated[str, Field(pattern=r'^[A-Z][A-Z0-9_]*_\d+$')]


class Candidate(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    label: Annotated[str, Field(min_length=1, max_length=200)]
    target_ref: Id
    allowed_value_refs: Annotated[list[_VALUE_REF], Field(min_length=1)]


class ResolvedFill(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ok: Literal[True] = True
    action: Literal['fill'] = 'fill'
    target_ref: str
    value_ref: str


class ResolvedAbstain(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ok: Literal[True] = True
    action: Literal['abstain'] = 'abstain'
    target_ref: None = None
    value_ref: None = None


class Rejected(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ok: Literal[False] = False
    reason: str


ResolveResult = Union[ResolvedFill, ResolvedAbstain, Rejected]


def resolve_action(raw_text: str | None, candidates: list[Candidate]) -> ResolveResult:
    if not isinstance(raw_text, str):
        return Rejected(reason='no-response')

    trimmed = raw_text.strip()
    # Strict: JSON-only, no markdown fences, no surrounding prose. Matches adapter.mjs exactly.
    if not (trimmed.startswith('{') and trimmed.endswith('}')):
        return Rejected(reason='not-json-only')

    try:
        parsed = json.loads(trimmed)
    except json.JSONDecodeError:
        return Rejected(reason='invalid-json')
    if not isinstance(parsed, dict):
        return Rejected(reason='invalid-json')
    if set(parsed.keys()) != _CLOSED_KEYS:
        return Rejected(reason='schema-not-closed')

    action = parsed.get('action')
    if action not in ('fill', 'abstain'):
        return Rejected(reason='invalid-action')

    if action == 'abstain':
        if parsed.get('target') is not None or parsed.get('valueRef') is not None:
            return Rejected(reason='abstain-with-extra-fields')
        return ResolvedAbstain()

    target = parsed.get('target')
    value_ref = parsed.get('valueRef')
    if not isinstance(target, str) or not isinstance(value_ref, str):
        return Rejected(reason='fill-missing-fields')

    label = target.strip().lower()
    matches = [c for c in candidates if c.label.strip().lower() == label]
    if not matches:
        return Rejected(reason='unknown-target-label')
    if len(matches) > 1:
        return Rejected(reason='ambiguous-target-label')

    candidate = matches[0]
    if value_ref not in candidate.allowed_value_refs:
        return Rejected(reason='unauthorized-value-ref')

    # The trusted target_ref comes from the candidate, never from the model's raw string --
    # this is what makes "no arbitrary execution" true regardless of what the model wrote.
    return ResolvedFill(target_ref=candidate.target_ref, value_ref=value_ref)
