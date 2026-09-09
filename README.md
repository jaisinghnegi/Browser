# On-device Privacy Agent · SIH26171

A Chrome extension feasibility slice: capture locally, run a real packaged text-region model, send only field references to a localhost planner, then resolve a synthetic address locally into a bound input.

**Scope:** one synthetic fixture. All screenshot pixels and page text are withheld from the planner. This is not general PII detection, OCR transcription, selective redaction, or a production browser agent. The planner defaults to a deterministic FastAPI response; an optional `PLANNER_MODE=vlm` routes the same reference-only request (still no image) through a local Qwen model behind the same validation. A separate local text-chat surface lives at `/` — see **Local chat** below.

## Setup (Windows PowerShell)

Requires Node.js 22+ and Python 3.11+. Development was checked with Node 22 and Python 3.14.

```powershell
npm.cmd ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r server/requirements.lock.txt
npm.cmd run model:download
npm.cmd run build
.venv/Scripts/python.exe -m uvicorn server.main:app --host 127.0.0.1 --port 8171 --no-access-log
```

The model download is about 4.75 MB and checks a pinned SHA256. It happens during setup; the extension never downloads a model or runtime from the internet. Build output is `dist/`, including local ONNX and WASM files. Model attribution and Apache-2.0 license are in [models](models/README.md).

Port **8171** is deliberate: port 8000 was already occupied on the development machine. The fixture, extension CSP and planner URL all use 8171. Bind the server to loopback as shown.

## Run the demo

### One launcher for the local services

`scripts/dev.mjs` owns the FastAPI backend on 8171 — a single clean start (it stops any stale
listener first, so no double-spawned servers) and a combined status view. It does **not** start
the llama.cpp model server on 8973 (a large personal artifact with its own launch); it checks
it and prints guidance if it is down.

```powershell
npm.cmd run demo:up       # start backend on :8171 (PLANNER_MODE=vlm, VLM_BASE_URL=http://127.0.0.1:8973 by default)
npm.cmd run demo:status   # report backend :8171 (planner mode, model-ready) and model server :8973
npm.cmd run demo:down     # stop the backend on :8171
```

`demo:up` starts uvicorn detached (survives the shell) and logs to `test-results/backend.log`.
Override with `PLANNER_MODE=deterministic`, `VLM_BASE_URL=...`, or `PORT=...`. These are local
dev processes, not an installed service — they stop on `demo:down` or reboot.

### Steps

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project's `dist` directory.
2. Open [the synthetic fixture](http://localhost:8171/fixture).
3. Open the **Privacy Agent** toolbar popup and select **Run private fill**. Keep the popup open.
4. The field receives `991 Vault Lane, Testville 00000` from the extension's synthetic seed. The separate visible address is `71 Visible Road, Sample City 11111`.
5. The popup reports real inference timing and the exact reference-only planner payload. No submit action exists.

Refresh the fixture to run again: the agent refuses to overwrite a nonempty input. Cancel or close the popup to abandon a pending task. Reload the unpacked extension after rebuilding. `npm.cmd run dev` watches TypeScript changes; rebuild after changing static HTML, CSS or the manifest.

The window must be tall/wide enough that the shipping-address field is **fully** inside the
viewport (`captureVisibleTab` only captures what's on screen, and a partially-offscreen field
means the model never saw the pixels it would need to). A maximized window comfortably clears
this; if the status shows "field is not fully visible", enlarge the window or scroll the field
into full view before retrying. Every terminal status also carries a fixed `data-reason`
attribute on the status element (e.g. `observation-failed`, `field-not-visible`,
`vision-failed`, `stale-observation`, `planner-action-rejected`, `execution-rejected`,
`timeout`, `cancelled`, `navigated`, `success`) for scripted/test inspection; it is never
built from page or planner text.

## Local chat

`http://localhost:8171/` serves a small local text-chat workspace that talks to the same local
Qwen server. It is **completely separate** from the browser extension: no screenshots, no page
text, no tools, no ability to act on any page. Bounded to 12 alternating messages / 4000 chars
per turn, same-origin only, model replies rendered as text (never HTML). Conversation history
lives only in the tab (and is sent to local Qwen with each reply); the app does not store it.
The header shows a probed **checking / ready / unavailable** state; when the model is down,
send is blocked and an explicit **Check again** re-probes health without sending a request.

## Privacy boundary

| Local extension only | Planner receives |
|---|---|
| Screenshot, decoded pixels, model tensors | `protocol: 1` |
| Synthetic vault address | Random task/observation/target UUIDs |
| DOM node identity, document, tab, origin, version | `fieldKind: "shipping-address"` |
| Inference timing and text probability statistics | `valueRef: "ADDRESS_1"` |

The worker constructs the payload field by field and validates the response against generated validators from `shared/protocol.schema.json`. No raw strings, images, DOM dump, URL, cookies, redirects or telemetry are allowed in this channel. The full-frame withholding panel is an explanation of the policy, not a selectively redacted screenshot. There are no uploaded image bytes to decode.

The in-memory task is bound to its origin, tab, document, DOM node, observation version and opaque target. The content script checks the real node again immediately before writing. Mutation, navigation, input, scrolling, resizing, expiry, cancellation and failed authorization invalidate a pending attempt. One task permits one value resolution; a replay cannot resolve the address again. Vault entries are discarded on finish/cancel; the hardcoded fictional seed remains part of the demo bundle.

Filling necessarily reveals the value to the destination page. This demo protects its **planner channel for the synthetic fixture**, not the destination page's subsequent behavior, compromised browser/extension code, arbitrary sites, or all forms of PII. The text detector is only a coarse vision gate; it does not decide which information is safe to upload. Full withholding provides that boundary.

Permissions are `activeTab`, `scripting`, and localhost host access. Chrome host permissions do not isolate ports; the code and CSP fix network access to `http://localhost:8171`. There is no `<all_urls>`, storage permission, offscreen permission, or remote extension code. Inference runs in the popup, while capture/network/vault remain in the service worker. Closing the popup tears down inference and aborts the pending task. Cancellation cannot undo a write that has already completed.

## Verification

```powershell
npm.cmd test
npm.cmd run typecheck
.venv/Scripts/python.exe -m pytest server/test_server.py -q
npm.cmd run build
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache/ms-playwright'
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Browser tests start/stop their own FastAPI server on 8171 by default. Stop the manual demo server first, **or** run fully isolated on a different port without touching a live demo:

```powershell
npm.cmd run build:e2e-isolated   # builds dist-e2e/ with the planner/CSP port baked in as 8172
npm.cmd run test:e2e:isolated    # runs its own FastAPI instance on 8172 against dist-e2e/
```

The port is a build-time-only substitution (`extension/config.ts`, `scripts/build.mjs`'s `BUILD_PORT`/`BUILD_OUT_DIR`) — never read at runtime — so a normal `npm.cmd run build` always produces the fixed-8171 production artifact; only an explicit isolated build/test run uses a different port, in its own output directory, against its own FastAPI instance.

They use an isolated Chromium profile, invoke the real extension action to grant `activeTab`, and drive the packaged popup UI in an extension tab because native toolbar popups are not exposed as Playwright pages. Capture, DOM operations, WASM inference and the successful planner request are real. Failure tests replace only the planner's response or corrupt a copied model artifact.

If Chromium is already installed and download/extraction fails, point the test harness at an existing Chromium executable:

```powershell
$env:PRIVACY_CHROMIUM_EXECUTABLE = 'C:/path/to/chromium/chrome.exe'
npm.cmd run test:e2e
```

Use Chromium rather than branded Chrome/Edge for automated extension sideloading. Reports and local inference evidence go to `test-results/`; these may contain synthetic fixture screenshots and are ignored by Git. Server validation tests also verify that rejected data is not echoed in responses or logs.

## Project map

- `extension/background.ts`: task orchestration and the single planner fetch.
- `extension/content.ts`: isolated observation and immediate DOM execution checks.
- `extension/task.ts`: one-use, expiring local value authorization.
- `extension/vision.ts`: real PP-OCRv4 ONNX inference and scratch-buffer cleanup.
- `extension/protocol.ts`, `shared/protocol.schema.json`: outbound allowlist and closed action contract.
- `server/`: strict request/action models, deterministic planner, fixture route and tests.
- `scripts/`: schema validator generation (avoids runtime eval under MV3 CSP), model verification and build.

The approved design is [here](docs/plans/2026-09-08-onDevice-privacy-agent-design.md); the implementation plan and scoped decisions are [here](docs/superpowers/plans/2026-09-08-privacy-slice.md). Later phases cover real PII classification/selective redaction, broader dynamic pages, held-out benchmarks and demo hardening.
