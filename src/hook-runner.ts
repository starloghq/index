// hook-runner.ts — the real PostToolUse install-hook logic.
//
// Why this is a module and not inlined into the generated hook script:
// `starlog init` installs a THIN SHIM at ~/.claude/hooks/starlog-pkg-check.js
// that resolves and runs THIS module from the installed `starloghq` package. So
// `npm update starloghq` refreshes hook BEHAVIOUR with zero re-init — the shim on
// disk never changes, only the package's dist/hook-runner.js it points at.
// (Corpus DATA already refreshed on upgrade; this closes the same gap for LOGIC.)
//
// Contract: advisory only. It reads a Claude Code PostToolUse payload on stdin,
// and for each package in a detected install command emits exactly one
// hookSpecificOutput line with Starlog facts, then queues unknown packages for
// batch manifest generation. It must NEVER throw out or block a tool call.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPackageRoot } from './paths.js';
import { runHook } from './hook/dispatch.js';
import { parseInstallCommand } from './patterns/install-parse.js';

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

function handlePayload(input: string): void {
  const data = JSON.parse(input);
  const cmd = (data.tool_input && data.tool_input.command) || '';

  const parsed = parseInstallCommand(cmd);
  if (!parsed) return;
  const { ecosystem } = parsed;

  for (const { name: originalPkg, manifestId: pkg } of parsed.packages) {
    const manifestPath = findManifest(pkg) || findManifest(pkg.replace(/-/g, ''));

    // Surface FACTS for the just-installed package, looked up by name
    // independently of whether a corpus-free manifest exists. Exactly one
    // hookSpecificOutput per detected package (advisory; never fails).
    const l2 = lookupL2(originalPkg, pkg);
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: factsMessage(originalPkg, l2) },
      }),
    );

    if (!manifestPath) {
      // Queue for batch generation.
      try {
        const homedir = os.homedir();
        const globalQueueDir = path.join(homedir, '.starlog');
        const globalQueuePath = path.join(globalQueueDir, 'pending.json');
        const localQueueDir = path.join(data.cwd || process.cwd(), '.starlog');
        const localQueuePath = path.join(localQueueDir, 'pending.json');

        const entry = {
          package_name: originalPkg,
          manifest_id: pkg,
          ecosystem: ecosystem,
          detected_at: new Date().toISOString(),
          source_project: data.cwd || process.cwd(),
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

// ── File-edit tripwire (after_file_edit) ───────────────────────────────────
//
// Claude Code has no literal `after_file_edit` event — a PostToolUse hook on the
// Edit/Write/MultiEdit tools IS that event. `starlog init` registers this shim
// under an `Edit|Write|MultiEdit` matcher; the payload is translated into the
// portable dispatcher envelope and any warn is re-emitted in Claude's native
// hookSpecificOutput shape. This is the Claude-Code half of the cross-platform
// hook contract (the Go/Hookshot shim owns the same mapping for other hosts).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Extract { path, content } from Claude's edit tool_input. Write carries the
// full `content`; Edit carries `new_string` (the added code — enough for the
// regex tripwire); MultiEdit carries an `edits[]` array of new_strings. Field
// names verified against Claude Code's real tool schemas (file_path / content /
// new_string), not the diff-only `edits[].new_text` a docs summary suggested.
// Exported for direct unit testing of the translation.
export function editPayload(toolInput: any): { path: string; content: string } | null {
  const filePath = toolInput?.file_path;
  if (typeof filePath !== 'string' || !filePath) return null;
  let content = '';
  if (typeof toolInput.content === 'string') content = toolInput.content;
  else if (typeof toolInput.new_string === 'string') content = toolInput.new_string;
  else if (Array.isArray(toolInput.edits)) {
    content = toolInput.edits
      .map((e: any) => (typeof e?.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  return { path: filePath, content };
}

async function handleEdit(data: any): Promise<void> {
  const ep = editPayload(data.tool_input || {});
  if (!ep) return;
  const result = await runHook({
    event: 'after_file_edit',
    cwd: data.cwd || process.cwd(),
    payload: { path: ep.path, content: ep.content },
  });
  if (result.decision !== 'allow' && result.message) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.message },
      }),
    );
  }
}

// ── Policy gate (before_execution) ─────────────────────────────────────────
//
// A PreToolUse hook on the Bash tool IS the "before_execution" event. For a
// dependency-install command that L3 policy DENIES, the dispatcher returns
// warn/deny; we map that to Claude's PreToolUse permissionDecision:
//   deny → "deny" (hard block) · warn → "ask" (surface + user decides) · allow → nothing.
async function handleBeforeExec(data: any): Promise<void> {
  const command = data.tool_input?.command;
  if (typeof command !== 'string') return;
  const result = await runHook({
    event: 'before_execution',
    cwd: data.cwd || process.cwd(),
    payload: { command },
  });
  if (result.decision === 'allow') return; // no decision → normal permission flow
  const permissionDecision = result.decision === 'deny' ? 'deny' : 'ask';
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: result.message ?? 'Starlog policy',
      },
    }),
  );
}

/** Read a hook payload from stdin and route it. Routes by event then tool:
 *  PreToolUse/Bash → policy gate; PostToolUse edit tools → DIY tripwire;
 *  everything else → install-facts. Never throws; always exits 0 so the hook can
 *  never wedge a tool call. */
export function run(): void {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', async () => {
    clearTimeout(stdinTimeout);
    try {
      const data = JSON.parse(input);
      if (data.hook_event_name === 'PreToolUse') {
        if (data.tool_name === 'Bash') await handleBeforeExec(data);
      } else if (EDIT_TOOLS.has(data.tool_name)) {
        await handleEdit(data);
      } else {
        handlePayload(input);
      }
    } catch {
      // Never fail — advisory only.
    }
    process.exit(0);
  });
}
