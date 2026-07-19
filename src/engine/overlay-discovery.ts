import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/**
 * Discover a project-local `.starlog/<relFile>` by walking UP from `startDir`
 * (default cwd) to the filesystem root, returning the first match.
 *
 * Why: the MCP server has STARLOG_PRIVATE_* baked into its env by `starlog init`,
 * but the standalone CLI does not — so a bare `starlog search` / `starlog facts`
 * in a project that has authored `.starlog/` used to see nothing unless you
 * `export`ed the path by hand. Walking up gives the CLI the same per-project
 * overlay the agent gets, from anywhere inside the project tree. Returns undefined
 * when no such file exists (loaders then no-op → public-only).
 */
export function discoverOverlay(relFile: string, startDir: string = process.cwd()): string | undefined {
  const { root } = parse(startDir);
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.starlog', relFile);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Resolve which overlay path to load: an explicit env value always wins (the MCP
 * server and any `export STARLOG_PRIVATE_*` override), otherwise fall back to a
 * discovered project-local `.starlog/<relFile>`. An empty env value is treated as
 * unset.
 */
export function overlayPath(envValue: string | undefined, relFile: string, startDir?: string): string | undefined {
  return envValue || discoverOverlay(relFile, startDir);
}
