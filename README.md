<p align="center">
  <img src="assets/logo/starlog-avatar-A.png" alt="Starlog" width="120" height="120">
</p>

<h1 align="center">Starlog</h1>

<p align="center"><strong>Vet a package before your AI coding agent uses it — authoritative facts (CVEs, license, maintenance), free, local, no account.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/starloghq"><img src="https://img.shields.io/npm/v/starloghq?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/starloghq/index/actions/workflows/ci.yml"><img src="https://github.com/starloghq/index/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="License: BUSL-1.1"></a>
  <img src="https://img.shields.io/badge/MCP-server-6E40C9" alt="MCP server">
</p>

<p align="center">
  <img src="demo/facts-demo.gif" alt="An AI coding agent vetting a package through the Starlog MCP server — pulling its known incidents, license, and maintenance before using it" width="820">
</p>

**Vet a package in one command — nothing to install, no API key, no account:**

```bash
npx starloghq facts ua-parser-js
```

Then wire it into your coding agent (Claude Code, Cursor, Copilot, Codex):

```bash
npx starloghq init
```

> **Source-available** under BUSL-1.1 — free to use, modify, and self-host; **converts to Apache-2.0 in 2030**. [Details ↓](#license)

---

## Why

AI coding agents (Claude Code, Cursor, Copilot) pick libraries from **training recall** — a snapshot of scraped code, frozen at a cutoff date and ranked by how often an option appeared, not by what fits your task or what's safe *now*. That recall can't know about a CVE disclosed last week, and it has never seen your company's internal libraries. The agent recommends anyway, with the same confidence either way.

The failure modes are measurable: research finds ~49% of AI-suggested dependencies carry known vulnerabilities and ~34% are hallucinated outright — the package doesn't exist. And for whole categories — most dangerously auth — agents default to hand-rolling custom code instead of reaching for a vetted library.

You can't fix recall by prompting harder. **Starlog puts authoritative, dated facts in front of your agent at decision time.** Its hero surface is **vetting by name** — `starlog facts <package>` returns known CVEs/incidents, SPDX license + risk, and maintenance status (or an honest *"no facts on file"*) — so the install/avoid/pick call rides on facts, not recall. It runs entirely on your machine as an MCP server and a package-install hook, no API key, no sign-up. A companion `starlog_search` finds candidate packages for a capability; facts vet the pick.

**Does it actually change what the agent decides?** Yes — measured before/after, on the venue that matters (private libraries and post-cutoff advisories). → [the validated result](#does-it-change-the-agents-decision).

## What you get

- **`starlog_facts` MCP tool** — your agent looks up **authoritative facts about a specific package** before recommending it: known CVEs/supply-chain incidents, SPDX license and license risk, maintenance status (active/deprecated/abandoned/compromised), and effect surface. In a 4-model benchmark, agents called this tool unprompted on package decisions (100% recall, 98% specificity) and it moved them toward the correct install/avoid/pick call. Every record is sourced, verified, and **dated** — each result shows an "as of `<date>`" line so a stale "no known vulns" is never mistaken for a fresh one. A package with no record returns an honest "no facts on file." Facts are three independent layers, composed at query time: **L1** capability/effect-surface (immutable), **L2** reputation/vuln/license/maintenance (mutable — carries the `as of` recency), **L3** org policy (your suitability verdict). Override or extend any layer locally: point `STARLOG_PRIVATE_FACTS` at a JSON file with independent `l1`/`l2` arrays (internal packages, license rulings) and `STARLOG_POLICY` at an org policy (`{ org, rules }`) for allow/deny/flag verdicts. With `STARLOG_API_KEY` set, org-private overlays and policy come from the hosted facts API (local corpus is the offline fallback); `starlog facts push` uploads your org's overlays + policy. See [docs/FACTS-CONTRACT.md](docs/FACTS-CONTRACT.md).
- **Package-install hook** — fires the moment your agent runs `npm install` / `pnpm add` / `yarn add` / `pip install` and **surfaces that package's facts** (known incidents, license, maintenance) *before* the agent builds on it. Advisory — it informs the next move, it doesn't block the install. Packages with no record are queued for coverage.
- **`starlog_search` MCP tool** — discovery: find candidate packages for a capability (org-sanctioned options first), then vet the named pick with `starlog_facts`. Discovery surfaces what exists; facts vet it.
- **`starlog_advise` MCP tool** — when your agent sees DIY or repeated capability code, advises **MIGRATE** to a safe library (e.g. Clerk/Auth0/Supabase over DIY auth) or **PACKAGEIZE** only when no safe corpus alternative exists. Tracks patterns in `.starlog/patterns.json`.
- **`starlog facts` / `starlog search` / `starlog advise` / `starlog patterns` CLI** — the same facts, discovery, and migrate-or-packageize advisories from your terminal.
- **Runs on your machine** — the engine and corpus are local; the default (keyless) path needs no account, no API key, and no network. Setting `STARLOG_API_KEY` opts into the hosted facts/search tiers (with local fallback) — get a key at [starlog.dev](https://starlog.dev) and wire it with `starlog init --api-key <key>`; anonymous, opt-out usage telemetry is the only thing sent otherwise — see [Telemetry](#telemetry).

This repo ships the engine plus a curated **facts corpus** and a discovery corpus of **51 capability manifests across 7 categories** (including authentication playbooks for migration).

## Quick start

```bash
npx starloghq init
```

This wires Starlog into Claude Code (and drops instruction files for Cursor, Copilot, Codex):

- **MCP server** added to `~/.claude/settings.json` — exposes `starlog_facts` (vet a package by name), `starlog_search` (discover candidates), and `starlog_advise` (migrate-or-packageize for DIY patterns), and wires your **per-project private overlays** (`${CLAUDE_PROJECT_DIR}/.starlog/*`) into the agent so internal-package facts + discovery work automatically in each project
- **PostToolUse hook** installed — surfaces a package's facts on install
- Previews every change and asks before writing; **idempotent** and safe to re-run

Prefer a bare `starlog` command over typing `npx`? Install it globally:

```bash
npm install -g starloghq
starlog init
```

> If `starlog` then reports **`command not found`**, your npm global bin directory isn't on your `PATH` (a common npm setup gap — not a Starlog issue). Either run `export PATH="$(npm prefix -g)/bin:$PATH"` (add it to your shell profile to persist), or just keep using `npx starloghq init` / `npx starloghq facts <pkg>`, which always work without any PATH setup. If the install itself printed an `EACCES`/permission error, it didn't complete — fix your npm prefix or use `npx`.

Add `--project` to also drop Starlog guidance into your project's `CLAUDE.md`; preview without writing, or remove cleanly:

```bash
starlog init --project
starlog init --dry-run
starlog init --uninstall
```

### Onboard a whole org at once

Don't hand-author facts for every internal repo — point Starlog at a directory of checkouts and it derives them in one pass:

```bash
starlog org sync ~/code/my-org
```

For each published package it finds (npm `package.json` **and** Python `pyproject.toml`), it derives:

- **L2 facts** → `.starlog/private-facts.json` — license + license risk (from the manifest, or detected from the `LICENSE` file), maintenance from git last-commit recency, stamped `source: analyzer` with a dated `as of`. Your agent **vets these by name**.
- **Discovery corpus** → `.starlog/private-corpus.json` — captures each manifest's description + keywords so your agent can **find** internal packages by capability via `starlog_search`, not just vet them by name.
- **Suggested policy** → `.starlog/policy.suggested.json` — flag candidates (e.g. strong-copyleft, no declared license) derived from the signals. These are **proposals the agent does not read** — review them, then adopt the ones you trust with `starlog facts policy <pkg> flag`.

Source never leaves your machine; only derived facts are written. Re-run anytime to refresh (it merges over existing facts and regenerates suggestions). Repos with no published name — or no description — are reported, never fabricated. Known-vulnerability scanning and remote GitHub-org enumeration are on the roadmap.

### From source

```bash
git clone https://github.com/starloghq/index.git starlog-index
cd starlog-index && npm install
npx tsx src/cli.ts facts ua-parser-js
```

### Manual MCP setup

`starlog init` writes this for you automatically. To configure by hand, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "starlog": {
      "command": "npx",
      "args": ["-y", "starloghq", "mcp"]
    }
  }
}
```

This is the same launch command MCP registries use. (From a local source clone instead, point `node` at `dist/mcp.js` — `$(npm root -g)/starloghq/dist/mcp.js` for a global install, or your clone's path.) The server exposes two tools: `starlog_facts` (an authoritative per-package fact lookup — CVEs, license, maintenance) and `starlog_search` (a natural-language capability query with optional `category`, `stack`, and `top_k` filters).

## CLI usage

**Vet a package by name** — the hero. Local, no key, no network:

```bash
starlog facts ua-parser-js
```

```
## ua-parser-js (npm)
**Effect surface:** Parses User-Agent strings; pure data transformation, in-process.
**Capabilities:** parsing
**Maintenance:** active
**License:** MIT (risk: none)
**Known vulnerabilities / incidents:**
  - INCIDENT:ua-parser-js-2021 [critical] affected: 0.7.29, 0.8.0, 1.0.0 — Maintainer account hijacked (Oct 2021); these versions shipped a password stealer and cryptominer. Treat installs as account-compromise.
**Transitive risk:** Frequently a transitive dep — pin away from the three bad versions.
**Source:** GitHub Security Advisory; CISA alert Oct 2021 (hand)
**Verified:** as of 2026-06-01
```

A package with no record returns an honest **"No facts on file"** — not a guess. Add `--format json` for machine-readable output with the independent `l1` / `l2` / `l3` layers.

**Discover candidates** for a capability, then vet the named pick with `facts`:

```bash
starlog search "auth for a Next.js app"
```

```
#   Library             Category          Score   Solves
--------------------------------------------------------------------------------
1   Auth0 Next.js SDK   authentication    71.36   Implements user authentication in Next.js applications using Auth0 ...
2   Clerk               authentication    60.64   Provides a fully managed authentication and user management platfor...
```

Search **ranks locally** with the keyword ranker — scores are absolute (a strong match lands in the 70s–80s), so a query outside the indexed categories returns *"no strong match"* rather than a confident wrong answer. Keyless, the candidate set is the bundled corpus (no network). With `STARLOG_API_KEY` set, candidates come from the **hosted full corpus** (`api.starlog.dev/search`) and are ranked by the same local engine — so a key widens *what* can be found, never *how* it's scored; any hosted hiccup silently falls back to the bundled corpus.

```
--category <cat>    Filter by category (authentication, feature-flags, etc.)
--stack <stack>     Filter by stack affinity (e.g., "next.js", "python")
--top-k <n>         Number of results (default: 5)
--format <type>     Output format: table or json
--context <desc>    Project context to tailor the "vs custom" rationale
```

### Your internal packages — the hero case, in two commands

The model structurally **can't** know your private `@acme/*` packages exist — so this is where facts change the most decisions (DIY → the org's sanctioned library). You don't hand-write JSON; two commands author the overlays, and `starlog init` already wired the agent to read them **per-project**:

```bash
# Make it discoverable — search will surface it (private-first) for a capability:
starlog corpus add @acme/flags --solves "Feature flags + remote config for Acme Node services" \
    --category feature-flags --stack node --best-for "gradual rollout,kill switches"

# Make it vet clean — facts confirms it's active/maintained:
starlog facts add @acme/flags --status active --license MIT
```

These write `.starlog/private-corpus.json` (discovery) and `.starlog/private-facts.json` (vetting) in your project. Because `starlog init` bakes `${CLAUDE_PROJECT_DIR}/.starlog/*` into the MCP server's env, your coding agent picks them up **automatically in that project** — no shell `export`, nothing to re-run. Confirm with `starlog doctor` (it reports the wiring and what each project has authored). For richer overlays — full `l1`/`l2` arrays, org `STARLOG_POLICY` allow/deny verdicts, or pushing to the hosted API with `starlog facts push` — see [docs/FACTS-CONTRACT.md](docs/FACTS-CONTRACT.md).

## How it works

Starlog vets a package as **three independent layers, composed at query time** — never collapsed into one blurry "score":

| Layer | Answers | Mutability |
|---|---|---|
| **L1** capability / effect-surface | what does the code *do*? | immutable |
| **L2** reputation overlay | what's *known*? — CVEs, license, maintenance | mutable; carries the dated `as of` recency |
| **L3** org policy | is it *allowed here*? | your rules → allow / deny / flag |

`starlog facts <pkg>` composes the three for the caller and returns them — or an honest miss — over the **MCP server**, the **CLI**, or the **install hook**. The corpus is local and cacheable; override or extend any layer with `STARLOG_PRIVATE_FACTS` (internal packages, license rulings) and `STARLOG_POLICY`. The full contract: [docs/FACTS-CONTRACT.md](docs/FACTS-CONTRACT.md).

Discovery (`starlog_search`) is a separate surface: it ranks capability manifests against each library's `solves` / `best_for` / `stack_affinity` with a local keyword ranker, reporting an *absolute* score so an out-of-corpus query returns "no strong match" instead of a forced result. The candidate set is the bundled corpus, or — with `STARLOG_API_KEY` set — the hosted full corpus, ranked by the same local engine either way. When your agent installs a package with no manifest yet, the hook queues it (`.starlog/pending.json`) for coverage.

For the full picture — surfaces, engine, data sources, and what telemetry leaves the machine — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (with diagrams).

## Does it change the agent's decision?

The real test of a facts tool isn't "does it return data" — it's "does the agent decide differently." Measured before/after (control = recall only; treatment = same prompt + Starlog facts):

- **Private packages (the hero case):** given an *informational-only* fact that an active internal library exists — no "you must use it" — the agent stops hand-rolling and picks the internal library. **2/2, DIY → internal, on information alone.** The model structurally can't recall your private `@acme/*` packages; facts are how it learns they exist.
- **Post-cutoff supply chain:** for `posthog-node`, facts add *"pin away from the malicious 4.18.1 / 5.11.3 / 5.13.3"* — advisory `MAL-2025-190925`, published after the model's training cutoff. It can't know this; the facts can.
- **No spurious flips:** healthy decoys (`zod`, `fastify`) don't change, and `node-cache` (ambiguous, no ground truth) is deliberately **not** counted as a win — a tool that books every change as a victory is lying to you.

Backed by a powered benchmark across **four model vendors**: correct adopt/avoid decisions moved **~20% → ~78%**, with **100% unprompted adoption**.

**Full before/after, the honest scope, and the experiment we threw out → [docs/VALIDATION.md](docs/VALIDATION.md).**

## Coverage

**Facts corpus — 42 packages.** Curated and dated: known supply-chain incidents (xz, event-stream, ua-parser-js, node-ipc, …), notable deprecations, and clean baselines — each with SPDX license + risk, maintenance status, and an `as of` date. Extend it for your org via `STARLOG_PRIVATE_FACTS` (internal packages) without touching the public set.

**Discovery corpus — 25 capability manifests across 7 categories:**

| Category | Examples |
|---|---|
| Authentication | Clerk, Auth0 |
| Real-time | Socket.IO, Ably, Pusher, Supabase Realtime, ws |
| ORM/Database | Prisma, Drizzle, Kysely |
| Background Jobs | BullMQ, Inngest, Bree |
| Email | Resend, SendGrid, Nodemailer |
| Feature Flags | LaunchDarkly, PostHog, Flagsmith, ConfigCat, DevCycle |
| Caching | ioredis, Upstash Redis, Keyv, Cacheable |

> **Note:** facts and manifest data are **point-in-time** — sourced and dated, but a decision aid, not ground truth. Verify anything load-bearing; corrections via PR are welcome.

## Testing

```bash
npx vitest run
```

Unit and e2e tests cover schema validation, corpus loading + integrity, facts/format output, the spawned-CLI round-trip, and search ranking. All run without API keys or external binaries.

## Telemetry

Starlog collects **anonymous, opt-out** usage analytics to understand which
commands, tools, and packages are used. It sends: the command/tool run
(`init`/`facts`/`search`/`doctor` and the `starlog_facts`/`starlog_search` MCP
tools), the CLI/Node/OS version, detected agents, coarse result counts, the
**public** package names you look up, and your **search queries / project
context** — with emails, secrets/tokens, absolute file paths, and IP addresses
**scrubbed before send**.

It **never** sends your **org-private** package names (those are redacted to a
boolean when you use a private overlay), your username/hostname, or any file
contents. It's also disabled automatically in CI and test runs.

A notice is printed on first run and **re-shown whenever the disclosure changes**
(so a broadened collection can never happen silently). Through the MCP tools, the
server **includes the disclosure in its first tool result** (which your agent
relays to you) and only begins recording from the next call — so MCP analytics are
never collected before you've been shown what's collected. Opt out at any time:

```bash
starlog telemetry disable          # persistent opt-out
starlog telemetry status           # see current state + anonymous id
export STARLOG_TELEMETRY=0         # env opt-out
export DO_NOT_TRACK=1              # honored too
starlog <command> --no-telemetry   # one-off
```

## Links

- Website: [starlog.dev](https://starlog.dev)

## License

**Source-available** under the Business Source License 1.1 — see [LICENSE](LICENSE). Not an OSI open-source license: free to use, modify, and self-host (non-competing use), and it **converts to Apache-2.0 on 2030-06-01**.
