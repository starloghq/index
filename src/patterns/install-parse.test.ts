import { describe, it, expect } from 'vitest';
import { parseInstallCommand } from './install-parse.js';

// Shared parser used by BOTH the install-facts hook and the policy gate. The
// hook-runner e2e (init.hook.test.ts) already exercises the #29 compound-command
// and version-stripping paths end-to-end; these pin the extracted function.
describe('parseInstallCommand', () => {
  const names = (cmd: string) => parseInstallCommand(cmd)?.packages.map((p) => p.name) ?? null;

  it('returns null for non-install commands', () => {
    expect(parseInstallCommand('ls -la')).toBeNull();
    expect(parseInstallCommand('git commit -m x')).toBeNull();
    expect(parseInstallCommand('npm run build')).toBeNull();
  });

  it('parses npm/pnpm/yarn/pip install forms', () => {
    expect(names('npm install lodash react')).toEqual(['lodash', 'react']);
    expect(names('npm i chalk')).toEqual(['chalk']);
    expect(names('pnpm add zod')).toEqual(['zod']);
    expect(names('yarn add express')).toEqual(['express']);
    expect(parseInstallCommand('pip install requests')?.ecosystem).toBe('pypi');
  });

  it('strips version/tag but keeps the scope', () => {
    expect(names('npm install lodash@4.17.21')).toEqual(['lodash']);
    expect(names('pnpm add @scope/pkg@2.0.0')).toEqual(['@scope/pkg']);
    expect(names('pip install requests==2.31.0')).toEqual(['requests']);
  });

  it('stops at shell operators and drops junk (#29)', () => {
    expect(names('npm i -g some-pkg >/dev/null 2>&1 && echo done')).toEqual(['some-pkg']);
    expect(names('npm i "$TARBALL" && echo done')).toEqual([]);
    expect(names('pip install /tmp/local.tgz')).toEqual([]);
  });

  it('derives the corpus manifestId (scope stripped, dots→dashes, lowercased)', () => {
    const p = parseInstallCommand('npm i @scope/My.Pkg')?.packages[0];
    expect(p?.name).toBe('@scope/My.Pkg');
    expect(p?.manifestId).toBe('my-pkg');
  });
});
