// hook-runner.ts — Claude Code hook dispatcher (install vet + DIY detection).
//
// Why this is a module and not inlined into the generated hook script:
// `starlog init` installs a THIN SHIM at ~/.claude/hooks/starlog-pkg-check.js
// that resolves and runs THIS module from the installed `starloghq` package. So
// `npm update starloghq` refreshes hook BEHAVIOUR with zero re-init — the shim on
// disk never changes, only the package's dist/hook-runner.js it points at.
//
// Routes:
//   PreToolUse Write|Edit|MultiEdit → DIY pattern detect + starlog advise inject
//   PostToolUse Bash               → package-install facts vetting
//
// Contract: advisory by default; deny only on org DIY policy. Never throw.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPackageRoot } from './paths.js';
import { detectHookPlatform, emitPostToolUseContext } from './hook-output.js';
import { handleDiyPreToolUse } from './diy-hook-runner.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

const CORPUS_DIR = path.join(getPackageRoot(), 'corpus-free');
const L2_FACTS_PATH = path.join(CORPUS_DIR, 'l2-facts.json');

// Atomic write: temp sibling + rename, so a crash can't truncate the queue.
function writeFileAtomic(p: string, data: string): void {
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

function loadL2Facts(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(L2_FACTS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function lookupL2(rawPkg: string, normId: string): any {
  const facts = loadL2Facts();
  return facts[rawPkg] || facts[normId] || null;
}

// Strip a trailing version/tag so every downstream use (facts lookup, the
// displayed name, the starlog_facts suggestion, the pending-queue manifest_id)
// keys on the real package name. npm: pkg@1.2.3 / @scope/pkg@next (the leading
// scope @ is preserved); pypi: pkg==1.0 / pkg>=2 / pkg[extra].
function stripVersionSpec(name: string, ecosystem: string): string {
  const n = String(name);
  if (ecosystem === 'pypi') return n.split(/[<>=!~;[]/)[0];
  const at = n.lastIndexOf('@');
  return at > 0 ? n.slice(0, at) : n;
}

function normalizeToManifestId(pkg: string): string {
  return pkg
    .replace(/^@[^/]+\//, '')
    .replace(/\./g, '-')
    .toLowerCase();
}

// A token is a real package name only if it matches ecosystem naming rules
// (after stripping a trailing version/tag). Rejects shell tokens, paths, quotes,
// and anything with metacharacters — the grammars below allow only [a-z0-9._-]
// plus one optional npm scope slash.
function isValidPkgName(name: string, ecosystem: string): boolean {
  if (!name) return false;
  let n = String(name);
  if (ecosystem === 'pypi') {
    n = n.split(/[<>=!~;[]/)[0];
  } else {
    const at = n.lastIndexOf('@');
    if (at > 0) n = n.slice(0, at); // strip trailing @version/@tag, keep leading scope
  }
  if (!n || n.length > 214) return false;
  if (ecosystem === 'pypi') return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(n);
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(n);
}

function findManifest(id: string): string | null {
  try {
    const categories = fs
      .readdirSync(CORPUS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const cat of categories) {
      const p = path.join(CORPUS_DIR, cat.name, id + '.json');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function factsMessage(originalPkg: string, l2: any): string {
  if (l2) {
    const parts: string[] = [];
    if (l2.known_vulns && l2.known_vulns.length) {
      parts.push(
        'KNOWN VULNS/INCIDENTS: ' +
          l2.known_vulns
            .map((v: any) => v.id + ' [' + v.severity + '] ' + v.summary)
            .join(' | '),
      );
    } else {
      parts.push('No known vulns/incidents on file.');
    }
    parts.push(
      'Maintenance: ' + l2.maintenance + '. License: ' + l2.license + ' (risk: ' + l2.license_risk + ').',
    );
    parts.push('As of ' + l2.fetched_at + '. Vet with starlog_facts ' + l2.package + ' before building on it.');
    return '[Starlog facts] ' + originalPkg + ' — ' + parts.join(' ');
  }
  return '[Starlog] No facts on file for "' + originalPkg + '". Run starlog_facts ' + originalPkg + ' to vet it.';
}

function handleInstallPayload(data: Record<string, unknown>): void {
  const platform = detectHookPlatform(data);
  const toolInput = (data.tool_input ?? {}) as Record<string, unknown>;
  const cmd = String(toolInput.command ?? data.command ?? '');

  const patterns = [
    /(?:npm\s+(?:install|i|add))\s+(.+)/i,
    /(?:pnpm\s+add)\s+(.+)/i,
    /(?:yarn\s+add)\s+(.+)/i,
    /(?:pip\s+install)\s+(.+)/i,
  ];

  let pkgArgs: string | null = null;
  let ecosystem = 'npm';
  for (const pat of patterns) {
    const m = cmd.match(pat);
    if (m) {
      pkgArgs = m[1];
      ecosystem = pat.source.includes('pip') ? 'pypi' : 'npm';
      break;
    }
  }
  if (!pkgArgs) return;

  // Stop at the first shell operator/redirection so a compound command
  // (npm i x && echo done; npm pack >/dev/null) can't bleed shell tokens into
  // the package list, then keep only well-formed package names.
  const headArgs = pkgArgs.split(/[;&|<>()`#\n]/)[0];
  const rawPkgs = headArgs.split(/\s+/).filter((a) => a && !a.startsWith('-') && isValidPkgName(a, ecosystem));

  for (const raw of rawPkgs) {
    // Strip the trailing version/tag BEFORE lookup/display/queueing — otherwise a
    // pinned install of a covered package (e.g. ua-parser-js@0.7.29) misses facts.
    const originalPkg = stripVersionSpec(raw, ecosystem);
    const pkg = normalizeToManifestId(originalPkg);
    const manifestPath = findManifest(pkg) || findManifest(pkg.replace(/-/g, ''));

    // Surface FACTS for the just-installed package, looked up by name
    // independently of whether a corpus-free manifest exists. Exactly one
    // hookSpecificOutput per detected package (advisory; never fails).
    const l2 = lookupL2(originalPkg, pkg);
    emitPostToolUseContext(platform, factsMessage(originalPkg, l2));

    if (!manifestPath) {
      // Queue for batch generation.
      try {
        const homedir = os.homedir();
        const globalQueueDir = path.join(homedir, '.starlog');
        const globalQueuePath = path.join(globalQueueDir, 'pending.json');
        const localQueueDir = path.join(String(data.cwd ?? process.cwd()), '.starlog');
        const localQueuePath = path.join(localQueueDir, 'pending.json');

        const entry = {
          package_name: originalPkg,
          manifest_id: pkg,
          ecosystem: ecosystem,
          detected_at: new Date().toISOString(),
          source_project: String(data.cwd ?? process.cwd()),
          install_command: cmd,
          status: 'pending',
        };

        // Read global queue, deduplicate by manifest_id.
        let globalQueue: any[] = [];
        try {
          globalQueue = JSON.parse(fs.readFileSync(globalQueuePath, 'utf8'));
        } catch {
          /* file doesn't exist yet */
        }

        const alreadyQueued = globalQueue.some((e) => e.manifest_id === pkg);
        if (!alreadyQueued) {
          globalQueue.push(entry);
          fs.mkdirSync(globalQueueDir, { recursive: true });
          writeFileAtomic(globalQueuePath, JSON.stringify(globalQueue, null, 2) + '\n');

          // Append to project-local log.
          let localQueue: any[] = [];
          try {
            localQueue = JSON.parse(fs.readFileSync(localQueuePath, 'utf8'));
          } catch {
            /* */
          }
          localQueue.push(entry);
          fs.mkdirSync(localQueueDir, { recursive: true });
          writeFileAtomic(localQueuePath, JSON.stringify(localQueue, null, 2) + '\n');
        }
        // NB: the facts hookSpecificOutput was already emitted above; the queue
        // write is a silent side-effect (no second JSON on stdout).
      } catch {
        // Never fail — advisory only.
      }
    }
  }
}

/** Read hook payload from stdin, dispatch to install-vet or DIY detect. Never throws. */
export function run(): void {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 8000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    void (async () => {
      try {
        const data = JSON.parse(input) as Record<string, unknown>;
        const event = String(data.hook_event_name ?? data.hookEventName ?? '');
        const tool = String(data.tool_name ?? '');

        if (event === 'beforeShellExecution') {
          handleInstallPayload({ ...data, tool_input: { command: data.command ?? '' } });
        } else if (
          event === 'preToolUse' ||
          event === 'PreToolUse' ||
          WRITE_TOOLS.has(tool)
        ) {
          await handleDiyPreToolUse(data);
        } else {
          handleInstallPayload(data);
        }
      } catch {
        // Never fail — advisory only.
      }
      process.exit(0);
    })();
  });
}
