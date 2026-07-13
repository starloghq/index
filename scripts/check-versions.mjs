#!/usr/bin/env node
// Version-consistency gate. A Starlog release is TWO publishes — npm (package.json)
// and the MCP registry (server.json) — and the version is hand-bumped in both.
// They drift silently: the registry once sat at 0.1.9 while npm had moved to 0.6.0,
// because nothing in CI ever cross-checked server.json against package.json.
//
// publish.yml already checks the git tag against package.json, but never looks at
// server.json, and server.json declares the version in TWO places (top-level and
// each packages[] entry) that must also agree. This check closes both gaps:
//   1. every version-bearing field must share one pinned X.Y.Z version, and
//   2. on a release-tag CI run, that shared version must equal the tag.
//
// Note: this verifies the *committed* manifests are consistent. The actual MCP
// registry publish is still a manual `mcp-publisher` step — keeping server.json
// honest here is what makes that step a no-surprise sync rather than a guess.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_SEMVER = /^\d+\.\d+\.\d+$/;

function readJson(relPath) {
  // Strip a UTF-8 BOM some editors prepend (breaks JSON.parse).
  const raw = readFileSync(join(root, relPath), 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

// Every field that declares the project version, and who reads it. Add new
// version-bearing manifests here so a future surface can't drift unnoticed.
const pkg = readJson('package.json');
const server = readJson('server.json');

const fields = [
  ['package.json .version', pkg.version], // npm — what `npm install` resolves
  ['server.json .version', server.version], // MCP registry manifest
];
(server.packages ?? []).forEach((p, i) => {
  fields.push([`server.json .packages[${i}].version`, p?.version]);
});

let failed = false;

for (const [label, version] of fields) {
  if (typeof version !== 'string' || !PINNED_SEMVER.test(version)) {
    console.error(`${label}: must be a pinned X.Y.Z semver, got ${JSON.stringify(version)}`);
    failed = true;
  }
}

// Every field must declare the same version.
const distinct = [...new Set(fields.map(([, v]) => v))];
if (distinct.length > 1) {
  console.error('Version mismatch — every manifest field must share one version:');
  for (const [label, version] of fields) console.error(`  ${version}\t${label}`);
  failed = true;
}
const shared = distinct.length === 1 ? distinct[0] : null;

// On a release-tag push, CI sets GITHUB_REF_TYPE=tag and GITHUB_REF_NAME=vX.Y.Z.
// The shared version must equal the tag — this catches tagging a release whose
// manifests were never bumped, which mutual agreement alone cannot.
if (shared && process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  const tagVersion = tag.replace(/^v/, '');
  if (PINNED_SEMVER.test(tagVersion) && tagVersion !== shared) {
    console.error(`release tag ${tag} does not match version ${shared}; bump package.json and server.json before tagging`);
    failed = true;
  }
}

if (failed) {
  console.error('Align the version fields in package.json and server.json so every surface ships the same release.');
  process.exit(1);
}

console.log(`All ${fields.length} version fields pinned at ${shared}.`);
