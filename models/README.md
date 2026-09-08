# Local text-region model

Candidate: **PP-OCRv4 mobile text detector**, ONNX export distributed by SWHL/RapidOCR.

- Source: https://huggingface.co/SWHL/RapidOCR/tree/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv4
- File: `ch_PP-OCRv4_det_infer.onnx` (4,745,517 bytes).
- SHA256: `d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9`.
- License: Apache-2.0, as declared by the model repository. Upstream: https://github.com/PaddlePaddle/PaddleOCR
- Download only during setup: `npm run model:download`. Build re-verifies the hash. Runtime loads packaged assets exclusively.

Input: screenshot resized with maximum side 640, dimensions rounded to multiples of 32; BGR planar float32 NCHW, scaled by 1/255 and normalized with means `[0.485, 0.456, 0.406]` and standard deviations `[0.229, 0.224, 0.225]` as in the Paddle detection preprocessing. Output: `[1,1,H,W]` text probability map. The prototype counts finite pixels above 0.3 and requires at least 8 such pixels; it reports real inference duration and map dimensions locally. This is a coarse text-presence gate, not calibrated uncertainty or a PII classifier.

Phase 1 withholds the entire screenshot and all page text regardless of the detected mask. DOM cues identify one fixture field. This model does not establish semantic UI understanding, PII recall, OCR transcription, or unseen-layout performance; those remain later-phase work. Load failure, invalid output, no detected text, or timeout blocks the task.

Runtime guidance: https://onnxruntime.ai/docs/tutorials/web/deploy.html

## Phase 2 candidate: text recognition (pinned, not yet integrated)

Pinned and download-verified ahead of any code that uses them (`npm run model:download`
fetches all three artifacts), per the Phase 2 revised plan's delivery sequence. **Nothing in
the extension loads or runs these yet** — `build.mjs` does not package them and `vision.ts`
does not reference them. They exist only so the exact artifact is fixed before recognition
code is written.

- Candidate: **PP-OCRv4 mobile text recognizer**, same repo/revision as the detector above.
  - Source: https://huggingface.co/SWHL/RapidOCR/tree/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv4
  - File: `ch_PP-OCRv4_rec_infer.onnx` (10,857,958 bytes).
  - SHA256: `48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b`.
  - License: Apache-2.0, same upstream (PaddleOCR) as the detector. The "ch" (Chinese+English)
    recognizer is used because no PP-OCRv4 Latin-only recognizer artifact exists in this repo;
    its character dictionary is a superset that still covers the ASCII/digits/punctuation
    needed for the bounded address/phone/email categories.
- Dictionary: PaddleOCR's `ppocr_keys_v1.txt` (6,623 entries).
  - Source: https://github.com/PaddlePaddle/PaddleOCR/blob/release/2.7/ppocr/utils/ppocr_keys_v1.txt
  - SHA256: `28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7`.
  - License: Apache-2.0 (PaddleOCR).
  - Not committed to this repo (downloaded like the model artifacts, see `.gitignore`) since
    it's a third-party file this project doesn't modify.
- Expected preprocessing (PaddleOCR's recognition pipeline, distinct from the detector's):
  fixed height 32px, width scaled to preserve aspect ratio, BGR, normalized to `[-1, 1]` via
  `(pixel/255 - 0.5) / 0.5`. Expected output shape `[1, T, 6625]` (6,623 dictionary entries +
  CTC blank + PaddleOCR's trailing space class), decoded via CTC greedy decode with
  blank/repeat collapse. Both the preprocessing and output-shape assumptions are to be
  verified against the model's actual behavior once integration starts, not taken on faith
  from documentation — see the Phase 2 plan doc for details.

Full details, redaction geometry, coordinate-transform math, and the acceptance gates this
candidate must clear before any upload changes: [Phase 2 plan](../docs/superpowers/plans/2026-09-08-phase2-detection-redaction.md).
