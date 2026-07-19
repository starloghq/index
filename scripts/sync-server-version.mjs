#!/usr/bin/env node
// Sync server.json's version fields to package.json's version.
//
// Runs as the npm `version` lifecycle script: `npm version X.Y.Z` bumps
// package.json first, then invokes this, then (in the package.json script) stages
// server.json — so the MCP-registry manifest can never drift from npm again. The
// CI gate (scripts/check-versions.mjs) is the backstop that FAILS on any residual
// mismatch; this is the ergonomic half that keeps them aligned at bump time.
//
// Edits are surgical string replacements on the raw text (not JSON.parse +
// re-stringify) so the file's formatting, key order, and $schema comment survive
// untouched — a re-serialize would churn the whole file on every bump.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sync-server-version: package.json version is not a pinned X.Y.Z: ${JSON.stringify(version)}`);
  process.exit(1);
}

const serverPath = join(root, 'server.json');
const original = readFileSync(serverPath, 'utf8');

// Replace every `"version": "X.Y.Z"` (top-level + each packages[] entry). The
// pinned-semver value pattern avoids matching any unrelated "version"-named field.
let count = 0;
const updated = original.replace(/("version":\s*")\d+\.\d+\.\d+(")/g, (_, pre, post) => {
  count++;
  return `${pre}${version}${post}`;
});

if (count === 0) {
  console.error('sync-server-version: no "version" fields found in server.json — refusing to write');
  process.exit(1);
}

if (updated !== original) {
  writeFileSync(serverPath, updated);
  console.log(`sync-server-version: set ${count} server.json version field(s) to ${version}`);
} else {
  console.log(`sync-server-version: server.json already at ${version}`);
}
