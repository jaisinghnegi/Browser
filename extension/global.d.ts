// Substituted at build time via esbuild's `define` (scripts/build.mjs) -- a literal, dead-code
// -eliminated replacement baked into the bundle, not a runtime-configurable value. Defaults to
// 8171 for every normal build; only an isolated e2e build (BUILD_PORT env var) uses another
// port, so the shipped/demo extension always has the port fixed at build time, never at
// runtime, preserving the fixed-origin trust boundary.
declare const PRIVACY_AGENT_PORT: number;
