// PRIVACY_AGENT_PORT is substituted by esbuild's `define` at build time (see
// scripts/build.mjs and extension/global.d.ts) -- fixed per build, never read from any
// runtime source (URL, storage, message, env). Production builds always get 8171.
export const ORIGIN = `http://localhost:${PRIVACY_AGENT_PORT}`;
export const FIXTURE_URL = `${ORIGIN}/fixture`;
export const PLANNER_URL = `${ORIGIN}/plan`;
