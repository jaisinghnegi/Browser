# Privacy slice implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task, inline in the authorized fresh workspace.

**Goal:** Prove synthetic address filling through an on-device observation boundary and a schema-constrained localhost planner.

**Architecture:** A Manifest V3 service worker owns the in-memory task and planner channel. An isolated content script binds a real DOM node to an observation. The popup performs packaged ONNX inference on captured pixels. Only opaque IDs and fixed field semantics reach FastAPI; all screenshot pixels and page text are withheld in Phase 1.

**Tech Stack:** TypeScript, esbuild, Ajv, ONNX Runtime Web, FastAPI/Pydantic, Vitest, Playwright.

**Spec:** ../../plans/2026-09-08-onDevice-privacy-agent-design.md

## Global constraints

- Chrome/Chromium only; synthetic fixture only at `http://localhost:8171/fixture`.
- No raw screenshot, page text, URL, or vault values in the planner channel.
- Fail closed on model, sanitization, capture, schema, freshness or binding failure.
- Packaged PP-OCRv4 text-region detector is real inference, not a PII classifier; DOM selects the fixture field. Model uncertainty blocks upload.
- Popup closure cancels task. Vault values are memory-only and task-scoped.
- Runtime permissions: activeTab and scripting; localhost host permission only.
- Planner is deterministic for this feasibility milestone; no paid model/API needed.

## Task 1: Contract and local authorization boundary

Files: `shared/protocol.schema.json`, `extension/protocol.ts`, `extension/task.ts`, `tests/task.test.ts`, `tsconfig.json`.

Interfaces: `buildPayload(binding): PlannerRequest`; `parseAction(unknown): FillAction`; `Task.consume(action, current): string`; `Task.cancel(): void`. Binding includes taskId, observationId, documentId, tabId, origin, target and version. Only taskId, observationId and target cross the planner boundary.

- [ ] Add test tooling and write boundary tests before implementation. Example:
  ```ts
  expect(() => task.consume({...action, target: crypto.randomUUID()}, binding)).toThrow();
  expect(JSON.stringify(buildPayload(binding))).not.toContain('991 Vault Lane');
  ```
- [ ] Run `npm test` to establish missing behavior.
- [ ] Define closed request/action schemas, literal `shipping-address`/`ADDRESS_1`, UUID IDs, and no additional properties. Build requests field-by-field; never spread observations into payloads.
- [ ] Implement one-use vault consumption and exact local binding equality; invalidate on any failed authorization and on cancellation/expiry.
- [ ] Run boundary tests and `npm run typecheck`.

## Task 2: FastAPI planner and fixture

Files: `server/main.py`, `server/models.py`, `server/test_server.py`, `server/requirements.txt`, `fixtures/checkout.html`.

Interfaces: `POST /plan` accepts shared request, returns fill action with UUID actionId and matching taskId/observationId/target. `GET /fixture` serves a synthetic-only form with no submission.

- [ ] Test valid request, extra secret fields, malformed IDs, schema agreement, safe validation responses and logs. Example:
  ```py
  response = client.post('/plan', json={**request, 'secret': '991 Vault Lane'})
  assert response.status_code == 422
  assert '991 Vault Lane' not in response.text
  ```
- [ ] Run `python -m pytest server/test_server.py` to establish absent endpoint.
- [ ] Implement strict Pydantic models and generic rejection messages (no request echo), deterministic planner, fixed fixture route; disable body logging and docs in prototype service.
- [ ] Verify server tests, including bidirectional schema acceptance using the checked-in JSON schema.

## Task 3: Extension observation, inference and execution

Files: `extension/background.ts`, `extension/content.ts`, `extension/popup.ts`, `extension/vision.ts`, `extension/manifest.json`, `extension/popup.html`, `extension/popup.css`, `scripts/build.mjs`, `scripts/download-model.mjs`, `models/README.md`.

Interfaces: popup Port messages START/CANCEL/VISION; worker returns CAPTURE/RESULT. Content messages OBSERVE/CHECK/FILL/CANCEL. Content keeps node identity and mutation version in the isolated world. Background performs the only external fetch, after real successful inference and current binding check.

- [ ] Write browser acceptance tests for correct fill, planner payload absence of fixture values, real inference metadata, stale response rejection and popup cancellation before implementing adapter code.
- [ ] Build extension with local runtime/model assets. Pin model revision and SHA256 on download; preprocessing is BGR NCHW float32, dimensions rounded to multiples of 32, ImageNet normalization; output is text probability map.
- [ ] Implement content observation with mutation/input/scroll/resize invalidation and immediate DOM-node identity checks before setting value. Reject nonempty/disabled/invisible fields; consume authorization once; no submit action.
- [ ] Implement background orchestration with tab/window checks around capture, document-bound messaging, timeout/abort, single active task, strict response schema and per-task vault cleanup.
- [ ] Implement popup inference and explicit full-frame withholding preview; closing popup aborts and erases pending task. Never persist captures or values.
- [ ] Run `npm run build`, `npm run typecheck`, browser tests against actual Chromium and actual FastAPI.

## Task 4: Failure proof and handoff

Files: `tests/e2e/privacy.spec.ts`, `playwright.config.ts`, `README.md`, review evidence artifact.

- [ ] Exercise model failure (block packaged artifact load), malformed/wrong-target/unknown-ref planner responses, delayed response after mutation, and cancellation. Assert zero upload on preflight/model failure and no unintended fill on execution failure.
- [ ] Inspect every planner request and server log; record real local inference timing and output shape. No image bytes are uploaded in this phase, so decoded-image leakage is impossible by contract.
- [ ] Run final typecheck/build/unit/server/browser checks; record exact results and limitations.
- [ ] Document setup, unpacked extension instructions, permissions, model source/license, privacy scope, and the Phase 2 work still outstanding. Do not claim general PII detection or later phases complete.

## Review decisions

The source design's §5 still mentions video-only feasibility proof; §3.1's automated acceptance list takes precedence. Phase 1 uses full screenshot/page-text withholding, not selective redaction, so it cannot measure PII recall. Inference is hosted in the popup to retain the settled minimum permissions. Closing it intentionally aborts the run. Existing workspace is a new repository on `feat/privacy-slice`; no shared existing implementation requires another worktree.
