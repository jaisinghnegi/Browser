from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from server.models import FillAction, PlannerRequest

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, _error):
    # FastAPI's default response includes rejected input. Never echo it here.
    return JSONResponse(status_code=422, content={'error': 'Invalid planner request'})


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/plan', response_model=FillAction)
def plan(request: PlannerRequest):
    # Deterministic planner for the synthetic milestone. No request-body logging.
    return FillAction(action='fill', actionId=str(uuid4()), taskId=request.taskId,
                      observationId=request.observationId, target=request.target,
                      valueRef=request.valueRef)


@app.get('/fixture')
def fixture(request: Request):
    # `?variant=preview` serves a smaller page whose structural text fits the local preview's
    # bounded budget, so the Phase 2 preview path reaches an actual nonempty masked outcome
    # (see tests/e2e/privacy.spec.ts). The extension's allowed-URL check strips the query
    # string (background.ts normalizeFixtureUrl / content.ts normalizedHref), so both variants
    # are the same single allowed page as far as the gating flow is concerned.
    name = 'fixtures/preview-supported.html' if request.query_params.get('variant') == 'preview' else 'fixtures/checkout.html'
    return FileResponse(Path(__file__).parents[1] / name,
                        headers={'Cache-Control': 'no-store',
                                 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'"})
