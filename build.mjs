import { build } from 'esbuild';

// Keep the real runtime dependencies external (resolved from node_modules at
// runtime), but BUNDLE the workspace package `@starloghq/facts-schema` into
// dist — so the published `starloghq` tarball has no dependency on an
// unpublished package. (zod, which the schema imports, stays external.)
const RUNTIME_EXTERNAL = [
  '@anthropic-ai/sdk', '@anthropic-ai/sdk/*',
  '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*',
  'commander',
  'dotenv',
  'zod', 'zod/*',
];

await build({
  entryPoints: ['src/cli.ts', 'src/mcp.ts', 'src/hook-runner.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
  external: RUNTIME_EXTERNAL,
});

console.log('Built dist/cli.js, dist/mcp.js, and dist/hook-runner.js');
