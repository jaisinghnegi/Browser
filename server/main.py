import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from server.models import FillAction, PlannerRequest
from server.vlm_planner import VlmPlanRejected, plan_action

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

_VALID_PLANNER_MODES = ('deterministic', 'vlm')
_LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '::1')


def validate_planner_mode(mode: str) -> str:
    """A typo must fail startup, not silently run deterministic while the UI could say 'vlm'."""
    if mode not in _VALID_PLANNER_MODES:
        raise RuntimeError(f'PLANNER_MODE must be one of {_VALID_PLANNER_MODES}, got {mode!r}')
    return mode


def validate_local_vlm_url(url: str) -> str:
    """The current 'vlm' mode is LOCAL Qwen only. Enforce a plain http loopback endpoint with a
    real port and nothing else -- no https/remote host, no userinfo, no path/query/fragment --
    so a mis-set env can never point 'local Qwen' at a remote service. Future cloud providers
    would be a separate, explicitly labelled mode."""
    trimmed = url.rstrip('/')
    p = urlsplit(trimmed)
    if p.scheme != 'http':
        raise RuntimeError(f'VLM_BASE_URL must be http:// (local loopback), got {url!r}')
    if p.username or p.password:
        raise RuntimeError('VLM_BASE_URL must not contain userinfo')
    if p.path or p.query or p.fragment:
        raise RuntimeError('VLM_BASE_URL must be scheme://host:port with no path/query/fragment')
    if p.hostname not in _LOOPBACK_HOSTS:
        raise RuntimeError(f'VLM_BASE_URL host must be loopback {_LOOPBACK_HOSTS}, got {p.hostname!r}')
    try:
        port = p.port
    except ValueError as exc:
        raise RuntimeError('VLM_BASE_URL has an invalid port') from exc
    if port is None or not (1 <= port <= 65535):
        raise RuntimeError('VLM_BASE_URL must include a valid port')
    return trimmed


# 'deterministic' (default): the tested Protocol-1 planner echoes the authorised binding.
# 'vlm': an actual local Qwen call selects one pre-authorised option (NOT general page
# reasoning -- the reference-only request carries a single bounded choice), still passed through
# the resolve_action trust boundary and the extension's schema/binding/one-use validation. Set
# at process start only; never per-request. There is NO silent deterministic fallback in vlm mode.
PLANNER_MODE = validate_planner_mode(os.environ.get('PLANNER_MODE', 'deterministic'))
VLM_BASE_URL = validate_local_vlm_url(os.environ.get('VLM_BASE_URL', 'http://127.0.0.1:8973'))


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, _error):
    # FastAPI's default response includes rejected input. Never echo it here.
    return JSONResponse(status_code=422, content={'error': 'Invalid planner request'})


@app.get('/health')
def health():
    # plannerMode is surfaced so the client can honestly show which planner is active and never
    # claim "Qwen" while actually deterministic.
    return {'status': 'ok', 'plannerMode': PLANNER_MODE}


@app.post('/plan', response_model=FillAction)
async def plan(request: PlannerRequest):
    if PLANNER_MODE == 'vlm':
        try:
            return await plan_action(request, base_url=VLM_BASE_URL)
        except VlmPlanRejected:
            # Fail closed: the extension maps a non-200 to 'planner-action-rejected'. No body
            # detail (could echo model text); no deterministic fallback.
            return JSONResponse(status_code=502, content={'error': 'planner unavailable'})
    # Deterministic planner for the synthetic milestone. No request-body logging.
    return FillAction(action='fill', actionId=str(uuid4()), taskId=request.taskId,
                      observationId=request.observationId, target=request.target,
                      valueRef=request.valueRef)


@app.get('/fixture')
def fixture(request: Request):
    # `?variant=preview` / `preview-multi` serve smaller pages whose structural text fits the
    # local preview's bounded budget, so the Phase 2 preview path reaches a nonempty masked /
    # deterministic in-flight outcome (see tests/e2e/privacy.spec.ts). The extension's
    # allowed-URL check strips the query string (background.ts normalizeFixtureUrl /
    # content.ts normalizedHref), so every variant is the same single allowed page.
    variant = request.query_params.get('variant')
    name = {
        'preview': 'fixtures/preview-supported.html',
        'preview-multi': 'fixtures/preview-multiline.html',
    }.get(variant, 'fixtures/checkout.html')
    return FileResponse(Path(__file__).parents[1] / name,
                        headers={'Cache-Control': 'no-store',
                                 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'"})
