// install-parse.ts — shared dependency-install command parser.
//
// One grammar, two consumers: the PostToolUse install-facts hook (surfaces L2
// facts after an install) and the PreToolUse policy gate (before_execution —
// blocks/asks on an L3-denied dependency). Extracted verbatim from the original
// hook-runner logic so its regression tests (compound commands #29, version/tag
// stripping, scope preservation) keep it honest.

export type Ecosystem = 'npm' | 'pypi';

export interface ParsedPackage {
  /** Real package name, version/tag stripped (e.g. `@scope/pkg`, `ua-parser-js`). */
  name: string;
  /** Corpus manifest id (scope removed, dots→dashes, lowercased). */
  manifestId: string;
}

export interface ParsedInstall {
  ecosystem: Ecosystem;
  packages: ParsedPackage[];
}

const INSTALL_PATTERNS: RegExp[] = [
  /(?:npm\s+(?:install|i|add))\s+(.+)/i,
  /(?:pnpm\s+add)\s+(.+)/i,
  /(?:yarn\s+add)\s+(.+)/i,
  /(?:pip\s+install)\s+(.+)/i,
];

/** Strip a trailing version/tag so lookups key on the real package name. npm:
 *  pkg@1.2.3 / @scope/pkg@next (leading scope @ preserved); pypi: pkg==1.0 etc. */
export function stripVersionSpec(name: string, ecosystem: Ecosystem): string {
  const n = String(name);
  if (ecosystem === 'pypi') return n.split(/[<>=!~;[]/)[0];
  const at = n.lastIndexOf('@');
  return at > 0 ? n.slice(0, at) : n;
}

export function normalizeToManifestId(pkg: string): string {
  return pkg
    .replace(/^@[^/]+\//, '')
    .replace(/\./g, '-')
    .toLowerCase();
}

/** A token is a real package name only if it matches ecosystem naming rules
 *  (after stripping a trailing version/tag). Rejects shell tokens, paths, quotes,
 *  and metacharacters. */
export function isValidPkgName(name: string, ecosystem: Ecosystem): boolean {
  if (!name) return false;
  let n = String(name);
  if (ecosystem === 'pypi') {
    n = n.split(/[<>=!~;[]/)[0];
  } else {
    const at = n.lastIndexOf('@');
    if (at > 0) n = n.slice(0, at);
  }
  if (!n || n.length > 214) return false;
  if (ecosystem === 'pypi') return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(n);
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(n);
}

/**
 * Parse a shell command into the dependency-install packages it introduces, or
 * null if it isn't a recognized install command. Stops at the first shell
 * operator/redirection so a compound command can't bleed shell tokens into the
 * package list (regression #29), then keeps only well-formed package names.
 */
export function parseInstallCommand(cmd: string): ParsedInstall | null {
  let pkgArgs: string | null = null;
  let ecosystem: Ecosystem = 'npm';
  for (const pat of INSTALL_PATTERNS) {
    const m = cmd.match(pat);
    if (m) {
      pkgArgs = m[1];
      ecosystem = pat.source.includes('pip') ? 'pypi' : 'npm';
      break;
    }
  }
  if (!pkgArgs) return null;

  const headArgs = pkgArgs.split(/[;&|<>()`#\n]/)[0];
  const rawPkgs = headArgs
    .split(/\s+/)
    .filter((a) => a && !a.startsWith('-') && isValidPkgName(a, ecosystem));

  const packages: ParsedPackage[] = rawPkgs.map((raw) => {
    const name = stripVersionSpec(raw, ecosystem);
    return { name, manifestId: normalizeToManifestId(name) };
  });

  return { ecosystem, packages };
}
