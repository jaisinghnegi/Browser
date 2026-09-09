// Substituted at build time via esbuild's `define` (scripts/build.mjs) -- a literal, dead-code
// -eliminated replacement baked into the bundle, not a runtime-configurable value. Defaults to
// 8171 for every normal build; only an isolated e2e build (BUILD_PORT env var) uses another
// port, so the shipped/demo extension always has the port fixed at build time, never at
// runtime, preserving the fixed-origin trust boundary.
declare const PRIVACY_AGENT_PORT: number;

// Artificial per-region delay (ms) added to the local preview build. Substituted at build time
// like PRIVACY_AGENT_PORT; defaults to 0 for every normal/demo/production build (the `if
// (PREVIEW_PACE_MS > 0)` guard is then dead-code-eliminated). Only the isolated e2e build sets
// it, so lifecycle-race tests (Cancel / supersede while a build is genuinely still running) are
// deterministic on fast machines. Never read at runtime.
declare const PREVIEW_PACE_MS: number;
