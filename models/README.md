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
