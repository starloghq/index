import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Resolve an MCP overlay path (STARLOG_PRIVATE_CORPUS / _FACTS / STARLOG_POLICY)
 * to an absolute path AT RUNTIME, inside the spawned server.
 *
 * Why this exists: Claude Code does NOT expand `${CLAUDE_PROJECT_DIR}` inside an
 * `mcpServers.*.env` value — `${VAR}` expansion happens at config-parse time from
 * Claude Code's OWN environment, where CLAUDE_PROJECT_DIR is not set, so the token
 * reaches the server LITERAL. Claude Code does, however, inject CLAUDE_PROJECT_DIR
 * into the spawned server's `process.env` (= the project root). So the server must
 * expand the token itself, here, at read time. This repairs already-wired configs
 * with no re-`init`.
 *
 * Handles: `${VAR}` / `${VAR:-default}` from process.env (CLAUDE_PROJECT_DIR falls
 * back to cwd rather than empty, so an unset var never yields a bogus `/.starlog/…`),
 * a leading `~`, and project-relative paths (resolved against CLAUDE_PROJECT_DIR||cwd).
 * Absolute paths pass through unchanged (idempotent). Falsy input passes through so
 * loaders keep treating it as "no overlay configured".
 *
 * `baseProjectDir` overrides the project root used for `${CLAUDE_PROJECT_DIR}` and
 * relative-path resolution. Loaders omit it (server runtime → read from env). `doctor`
 * passes the project it is inspecting, so it validates the server-side env string
 * against a KNOWN root instead of doctor's own cwd.
 */
export function resolveOverlayPath(raw?: string, baseProjectDir?: string): string | undefined {
  if (!raw) return raw;

  const projectDir = baseProjectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const expanded = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, def) => {
    if (name === 'CLAUDE_PROJECT_DIR') {
      if (baseProjectDir) return baseProjectDir;
      if (process.env[name]) return process.env[name] as string;
      return def ?? process.cwd();
    }
    const value = process.env[name];
    return value !== undefined && value !== '' ? value : (def ?? '');
  });

  const tildeExpanded = expanded === '~' || expanded.startsWith('~/') ? homedir() + expanded.slice(1) : expanded;

  return isAbsolute(tildeExpanded) ? tildeExpanded : resolve(projectDir, tildeExpanded);
}
