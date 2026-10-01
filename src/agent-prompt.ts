/**
 * The canonical "give this to your coding agent" setup prompt, printed by
 * `starlog init --agent-prompt` (issue #48). The CLI owns this text so it can't
 * drift from the real init flow; the landing page generates its copy from it.
 *
 * Plain text meant to be pasted into a coding agent (Claude Code, Cursor,
 * Copilot, Codex) — NOT markdown for rendering. Its claims are pinned to the real
 * binary by agent-prompt.e2e.test.ts:
 *   - `starlog init` is interactive without `-y` (would hang an agent), so the
 *     flow previews with `--dry-run`, gets human OK, then applies with `-y`.
 *   - The hosted key comes from a browser GitHub OAuth flow the agent can't do,
 *     so step 2 is a human handoff; keyless is fully functional by default.
 *   - MCP tools only load at agent startup, so step 5 requires a restart.
 */

/** Browser GitHub OAuth entry point that issues a hosted STARLOG_API_KEY. */
export const KEY_URL = 'https://api.starlog.dev/auth/github';

export const AGENT_SETUP_PROMPT = `Set up Starlog for me — a capability index that helps you (my coding agent) vet packages and pick proven libraries instead of hand-rolling custom code. Work through these steps, narrate each one, and stop and show me the error if anything fails.

1. Install and preview (don't change anything yet):
     npm install -g starloghq
     starlog init --dry-run
   Requires Node 20+. Show me the planned changes: it wires the Starlog MCP server and an install hook into ~/.claude/, and writes agent-instruction files into THIS project for the agents it detects (.cursor/rules/, .github/copilot-instructions.md, AGENTS.md). Wait for my OK before writing anything.

2. Ask me about a key before applying — recommended, but optional. Tell me, in your own words: "Everything works with no key and no account — public package vetting and offline capability search are fully live. A free key adds org-private vetting on top: it lets me check your internal/private packages (not just public ones), enforce your license rules (e.g. flag GPL), and apply your team's allow/deny policy. On a team or a private codebase, it's worth setting up. Solo on open source? Skip it — nothing else changes. To get one: open ${KEY_URL}, sign in with GitHub, and copy the key it shows once. Paste it back to me, or say 'skip'."

3. Apply (non-interactive, only after my OK):
     starlog init -y
   Or, if I gave you a key:
     starlog init --api-key <key> -y

4. Verify:
     starlog doctor
   Report what it finds: corpus, MCP server, install hook, detected agents, and ranking mode.

5. Tell me to restart you. The starlog_search and starlog_facts tools only load when the agent starts — you won't be able to call them until I relaunch this session.

6. After I restart, prove it works: run "starlog facts <name a package I'm considering>" to show the vetting (known CVEs, license, maintenance status), then use starlog_search on a capability like "auth for Next.js" to show the ranked pick and why it beats hand-rolling.`;
