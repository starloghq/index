# Changelog

All notable changes to `starloghq` are documented here. This project follows [semantic versioning](https://semver.org/) (pre-1.0: minor = features, patch = fixes).

## 0.9.0 (unreleased)

Pattern tracking and migrate-or-packageize advisories — track DIY capability code, prefer migrating to safe corpus libraries over repeating dangerous DIY, and packageize only when no safe alternative exists.

- **feat(mcp): `starlog_advise` tool** — scans for DIY patterns or accepts an observation, searches the corpus, applies a facts-based safety gate, and returns **MIGRATE** (when Clerk/Auth0/Supabase-class alternatives exist), **PACKAGEIZE** (niche with no safe hit), or **WATCH** (below recurrence threshold).
- **feat(cli): `starlog advise`, `starlog patterns scan|list`, `starlog advise packageize`** — CLI parity with bundled playbooks and private corpus/facts scaffolding for packageize paths.
- **feat(patterns): project + global `.starlog/patterns.json` store** — heuristic scanners for the 7 indexed categories; recurrence threshold before advising action.
- **feat(corpus): Supabase Auth manifest** + L2 facts for `@clerk/nextjs`, `@auth0/nextjs-auth0`, `@supabase/supabase-js`.
- **feat(doctor): pattern store check** + MCP handshake expects `starlog_advise`.

## 0.8.0

Per-project private overlays now work end-to-end — the root-cause fix that made the MCP server's `${CLAUDE_PROJECT_DIR}` wiring silently no-op, plus CLI parity so `search`/`facts` see the same private `.starlog/` the agent does.

- **feat(cli): `search` / `facts` auto-detect a project-local `.starlog/`.** The MCP server has `STARLOG_PRIVATE_FACTS` / `STARLOG_PRIVATE_CORPUS` / `STARLOG_POLICY` baked into its env by `starlog init`, but the standalone CLI did not — so a bare `starlog search` / `starlog facts` in a project that had authored `.starlog/` overlays returned public-only unless you `export`ed the path by hand (CLI ≠ MCP; same repo, different answers). The CLI now falls back to a project-local `.starlog/{private-corpus,private-facts,policy}.json`, discovered by walking **up** from the current directory, so it surfaces the same org-private packages the agent sees — from anywhere in the project tree, no export needed. An explicit `STARLOG_PRIVATE_*` still overrides, and the shared `runSearch` / `buildComposeDeps` stay env-only (the MCP server is unchanged). The `corpus add` / `facts add` / `facts policy` default-path hints now say "…from this project: …" instead of pointing at the env var. (#59)
- **fix(mcp): private overlays wired with `${CLAUDE_PROJECT_DIR}` now actually load.** `starlog init` bakes `${CLAUDE_PROJECT_DIR}/.starlog/{private-facts,private-corpus,policy}.json` into the MCP server's `env` block, but Claude Code does **not** expand `${CLAUDE_PROJECT_DIR}` there — `${VAR}` expansion runs at config-parse time from Claude Code's own environment, where the variable is unset, so the token reached the server **literal** and every private overlay silently degraded to public-only (the only signal was a stderr warning the MCP stdio channel discards). Claude Code *does* inject `CLAUDE_PROJECT_DIR` into the spawned server's `process.env`, so the loaders (`loadPrivateCorpus`, `loadPrivateFacts`, `loadPolicy`) now resolve the token themselves at read time — plus `~` and project-relative paths. This repairs already-wired installs with **no re-init**. (#57)
- **fix(doctor): "Private overlays wired" now verifies the path resolves to this project.** The wiring check reported `[ok]` on mere presence of the env keys, so a stale absolute path or a cross-project leak — the agent silently reading a *different* project's `.starlog/` — passed as healthy. `doctor` now resolves each wired env path exactly as the server will (expanding `${CLAUDE_PROJECT_DIR}` to the project root) and warns when it doesn't land on this project's `.starlog/`, instead of asserting a green it can't stand behind. (#58)

## 0.7.1

Fixes and upgrade hardening from a full feature audit (every user-facing behaviour tested against the built CLI/MCP server/hook — the audit lives in `docs/feature-audit.csv`).

- **fix(hook): version-pinned installs now hit the facts lookup.** The install hook stripped nothing from `pkg@1.2.3` / `pkg==1.0`, so a pinned install of a covered package missed its facts entirely — `npm install ua-parser-js@0.7.29` (one of the exact hijacked versions the corpus warns about) reported *"No facts on file"*, suggested the unresolvable `starlog_facts ua-parser-js@0.7.29`, and queued mangled ids like `requests==2-31-0`. The hook now strips the trailing npm `@version`/tag (leading `@scope` preserved) and pypi `==`/`>=`/`~=`/`[extra]` specifiers before the lookup, the displayed name, the `starlog_facts` suggestion, and the pending-queue `manifest_id`. **One-time step for existing installs: re-run `starlog init` after upgrading** to pick up this fix (init detects the drift and shows `[~ update]`); new installs get it automatically. Thanks to the runtime shim below, this is the *last* upgrade that needs a re-init.
- **fix(search): table columns no longer collide.** Library/Category column widths now grow with the data plus a 2-space gutter, so a long name like `Flagsmith JavaScript Client` no longer runs into its category with no separator.
- **fix(search): `--top-k` is validated.** Zero/negative/non-numeric values are rejected with a clear error and exit 1, instead of silently defaulting to 5 or printing a misleading *"No strong match"* when matches exist.
- **feat(hook): zero-touch upgrades via a runtime shim.** Hook logic used to be copied inline into `~/.claude/hooks/`, so a package upgrade never refreshed it — every hook change needed a `starlog init` re-run (the version-pin fix above shipped with exactly that caveat). The installed hook is now a thin shim that loads its logic from the installed package (`dist/hook-runner.js`) at runtime, so `npm update starloghq` refreshes hook behaviour in place with no re-init. The shim file itself is stable across versions; `doctor` gains a *Hook logic* check that verifies the runner module resolves, so a broken upgrade surfaces instead of silently disabling facts.
- **feat(doctor): flags a legacy self-contained hook.** `starlog doctor` now warns when the installed hook is the pre-shim inline form — `[!] Hook logic — legacy self-contained hook … re-run \`starlog init\` to adopt the shim (zero-touch upgrades)` — so an upgraded user still frozen on old inline logic (including the pre-fix version-pin hook) is told how to migrate instead of being silently reported as `[ok]`.

## 0.7.0

- **Internal-traffic marker for analytics (`STARLOG_INTERNAL`).** Set `STARLOG_INTERNAL=1` on dev machines / CI-with-telemetry and events now carry `$internal_or_test_user` — both as an event property (PostHog's built-in test-user filter) and via `$set` as a person property (the "Internal / Test users" cohort) — so founder/test runs are excluded from product analytics. On a low-traffic project our own runs otherwise dominate the funnels. **Off by default**: real users are unaffected, nothing new is collected, and the opt-out env vars are unchanged.

## 0.6.0

- **Full hosted corpus tier for `starlog_search`.** The package bundles only the small `corpus-free` tier; with `STARLOG_API_KEY` set, `runSearch` now pulls the candidate set from the hosted full corpus (`api.starlog.dev/search`) and ranks it with the **same local engine** — a key widens *what* can be found, never *how* it's scored. Mirrors the facts client: Bearer auth, short abort timeout, defensive parsing, **never throws** — any hosted failure (no key, network, non-200, garbage body) silently degrades to the bundled corpus, so keyless users are unaffected.

## 0.5.3

- **MCP analytics now self-disclose instead of waiting on a CLI run.** In 0.5.1 the MCP tools stayed silent until the new telemetry notice was acknowledged via a CLI command — which meant the *entire existing install base* (all on a legacy `noticeVersion`) and agent-only users (who rarely touch the CLI) were never captured, undercounting exactly the population the events exist to observe. Now, on an unacknowledged install, the MCP server **appends the one-line disclosure to its first tool result** (the channel your agent actually relays to you), captures **nothing** on that call, self-acknowledges, and begins recording from the next call. No CLI run required; still nothing collected before you're shown what's collected. Opt-out unchanged.

## 0.5.2

- **fix(mcp): `node dist/cli.js mcp` started two MCP servers.** `mcp.ts`'s run-if-main guard fired inside the `cli.js` bundle (where `import.meta.url` is `cli.js`), so a second server ran alongside the `mcp` command's — every tool call executed **twice** (double `resolveFactView`/`runSearch` and, as of 0.5.1, double telemetry). Now the guard requires its own module URL to be the `mcp` entry, staying inert when bundled into `cli.js`. Standalone `dist/mcp.js` still auto-starts. Caught by the new MCP telemetry (one call → two events).

## 0.5.1

Product analytics for the surface that matters. The MCP tools (`starlog_facts`, `starlog_search`) — the way AI agents actually use Starlog — now emit anonymous usage events, so we can see real usage and improve the corpus around it.

- **MCP-surface telemetry.** `starlog_facts` → `mcp_facts` (hit/miss, ecosystem, vuln/license/maintenance signal, org policy decision) and `starlog_search` → `mcp_search` (result count, top score, category/stack). Fire-and-forget — the agent never waits on, or breaks because of, telemetry.
- **Broadened, scrubbed collection.** Now captures the package names you vet — including public ones we don't yet index (the "what to add next" signal) — and your **search queries / project context**, with emails, secrets/tokens, absolute paths, and IPs scrubbed before send (`scrubText`, exhaustively tested). **Org-private** package names (resolved from a `STARLOG_PRIVATE_FACTS` overlay) are never sent — redacted to a boolean.
- **Honest re-consent.** The first-run notice is rewritten to disclose exactly this, and is **re-shown on upgrade** (`NOTICE_VERSION`) so a broadened collection can never happen silently. Because the MCP server can't show a human a notice, **MCP-tool analytics stay suppressed until the current notice has been acknowledged via a CLI run** — no silent capture on the surface that's newly instrumented. Opt-out is unchanged (`STARLOG_TELEMETRY=0`, `DO_NOT_TRACK=1`, `starlog telemetry disable`, `--no-telemetry`) and still default-off in CI/tests.
- `STARLOG_TELEMETRY_HOST` env override (self-hosted PostHog / testability).

## 0.5.0

Onboard a whole org without hand-authoring a fact per repo. The new `starlog org sync` walks a directory of internal checkouts and **derives** their facts locally — so your AI agent can vet *and* discover your private packages, not just public ones.

### Added
- **`starlog org sync <dir>`.** Scans immediate subdirectories that are published packages (npm `package.json` **and** Python `pyproject.toml`/PEP 621) and derives, per package: an **L2 facts overlay** (`.starlog/private-facts.json`) with license + `license_risk`, maintenance from git last-commit recency, `attestation.source: "analyzer"` and a dated `fetched_at`; a **discovery corpus** (`.starlog/private-corpus.json`) from each manifest's description + keywords, so `starlog_search` surfaces internal packages by capability; and **suggested L3 policy** (`.starlog/policy.suggested.json`) — flag candidates from the signals, written to a separate proposal file the agent does **not** read (propose-not-apply; a human adopts them). Source never leaves the machine; `--facts-out` / `--corpus-out` / `--policy-out` / `--no-git` available. Repos with no published name (or no description) are reported, never fabricated.
- **LICENSE-file license detection.** When a manifest declares no license, the license is detected from the repo's `LICENSE`/`COPYING` file (GPL/LGPL/AGPL version-aware, Apache/MIT/MPL/ISC/BSD); unrecognized → `unknown` (never a false `none`).
- **`analyzer` attestation source.** `@starloghq/facts-schema` gains `'analyzer'` as an L2 `attestation.source`, so clone-derived facts carry honest provenance instead of masquerading as hand-authored. (schema 0.1.0 → 0.2.0)
- Auto-generated discovery manifests are now labelled `auto_generated: true`, distinguishing them from hand-authored `corpus add` entries.

### Changed
- **README:** the global-install section no longer over-promises "always on your PATH" — it now notes the `command not found` (PATH) and `EACCES` cases and points to the always-works `npx` path.

### Internal
- Single L2 construction seam (`assembleL2`) shared by the hand and analyzer paths, replacing a near-duplicate builder.

## 0.4.0

First-real-user fixes: a tester ran `npm i starloghq` and drove the CLI through their agent **without ever running `starlog init`**, so the MCP tools were never registered (the agent fell back to shelling the CLI), and they judged the tool on a mainstream public stack where most vetting honestly returns *"no facts on file."* These changes close the install-≠-wired gap and turn the two dead-end messages into pointers — without overclaiming public-package coverage (the value remains private/internal packages + post-cutoff advisories).

### Added
- **Post-install nudge.** `npm i starloghq` now prints one line — *"run `npx starlog init` to wire your AI agent — install alone does nothing"* — because install registers no MCP server or hook on its own. Stays silent in CI / non-interactive / piped installs and never fails the install. (P0)
- **CLI self-heal nudge.** When `starlog search` / `starlog facts` runs but `~/.claude/settings.json` exists *without* a `starlog` MCP server (a confirmed agent user who skipped `init`), a single stderr line points at `starlog init`. Conservative by design: silent when settings.json is absent/invalid (ambiguous) and suppressible with `STARLOG_NO_NUDGE`. (P0)
- **Anonymous key↔issuance link (opt-out aware).** Keyed `facts` API requests now relay an anonymous CLI id (`X-Starlog-Anon-Id`) so the server can associate a key with its issuance. The header is omitted entirely under `DO_NOT_TRACK` / `STARLOG_TELEMETRY=0` / CI / tests, and never carries queries, file paths, or package names.

### Changed
- **"No facts on file" now converts instead of dead-ending.** The miss message explains that a blank for a *mainstream public* package is expected (your model already knows it; Starlog's edge is post-cutoff advisories + your private packages), points to `npm audit`/OSV for mainstream vetting, and shows the one-liner to teach Starlog an internal package. Shared by the CLI and the `starlog_facts` MCP tool. (P1)
- **"No strong match" search result names the scope.** Both the CLI and `starlog_search` now state that discovery covers JS/TS capabilities, and that a non-JS/TS stack has no candidates to surface — while `starlog facts <pkg>` still vets any package by name and `starlog corpus add` makes internal packages discoverable. (P2)

## 0.3.0

The **private/internal-package** flow is now first-class: an org makes its internal package both *discoverable* and *vettable* in two commands, and the agent picks it up automatically per-project. Plus a class of trust-breaking fact mis-attribution is fixed.

### Fixed
- **Facts vetting resolves package names exactly — no more fabricated facts.** Previously a scoped or hyphenated name could fuzzy-/substring-match and return a *different* package's facts as authoritative (e.g. `@your-scope/pkg` → `q`, `express-rate-limit` → `express`). Resolution is now exact (normalized); an unknown name returns an honest *"no facts on file."* Natural-language *discovery* stays in `starlog_search`, where it belongs. (#7, #9)

### Added
- **`starlog corpus add <pkg> --solves "…"`** — make an internal/private package **discoverable** in one command: `starlog_search` surfaces it (private-first) for a matching capability. Defaults the public-signal fields that don't apply to internal packages, so there's no manifest to hand-write. (#11)
- **`starlog init` wires per-project private overlays into the agent.** The MCP server entry now carries `${CLAUDE_PROJECT_DIR}/.starlog/{private-facts,private-corpus,policy}.json`, so private vetting + discovery work **automatically in each project** — no shell `export` (which never reached the agent-spawned server). One global entry, resolved per-project, no cross-project leak. (#13)
- **`starlog doctor` reports the private setup** — whether overlays are wired into the agent (warns to re-run `init` on a pre-wiring install) and what the current project has authored (`vetting N, discovery N, policy N`), flagging an invalid overlay file instead of ignoring it. (#14)

### Changed
- `facts add` / `corpus add` guidance now describes the agent path accurately (overlays are auto-read per-project after `init`; the inline-env form is for CLI use) instead of suggesting a shell `export` that the agent never sees. README documents the two-command internal-package on-ramp. (#15)

## 0.2.0

Initial public release: `starlog_facts` (vet a package by name — CVEs/incidents, SPDX license + risk, maintenance, dated) and `starlog_search` (discover candidates) as a local MCP server + CLI + package-install hook. Curated facts corpus (42 packages) + discovery corpus (25 capability manifests). Free, local, no account.
