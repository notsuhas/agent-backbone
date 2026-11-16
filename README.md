# Agent Backbone

Agent Backbone keeps the skills, MCP servers, hooks, global instructions and settings of several coding agents (Claude Code, Codex, OpenCode, Cursor and others) in sync with one Git content repository. Each agent session start pulls the repository and applies it, so every machine converges on the same setup without a background job. It wraps [Skillshare](https://github.com/runkids/skillshare), which stays the management interface; Backbone adds the Git refresh, complete plugin packages, shared settings and upstream tracking.

```sh
brew install notsuhas/tap/agent-backbone
agent-backbone configure OWNER/REPOSITORY
skillshare list       # / searches, t toggles immediately, q exits
skillshare ui         # dashboard; keep this terminal running
skillshare pull       # fetch approved content and apply it
```

Put `~/.local/bin` first in `PATH`. Configure installs a `~/.local/bin/skillshare` launcher that runs Skillshare with Backbone's configuration. Homebrew owns upgrades of both: use `brew upgrade agent-backbone`.

## What belongs to which tool

| Responsibility | Owner |
|---|---|
| Dashboard, terminal manager, ignore patterns, skill toggles and per-agent settings | Skillshare |
| Skill, agent, MCP, hook and extra delivery; security audits | Skillshare |
| Shared instruction blocks that preserve local content and symlinks | Skillshare single-file extras |
| Session-start refresh | Backbone |
| Disabling individual skills inside complete plugins; keeping package assets and host notes | Backbone |
| Shared agent settings | Backbone |
| Upstream provenance and package updates that keep local adapters | Backbone |
| Scheduled update PRs | The content repository's own CI workflow |

Native Skillshare plugin selection is per target and does not apply individual skill selections inside complete plugin trees; Backbone fills that gap. Native `pull` can merge histories. The managed `skillshare pull` instead runs a fast-forward-only refresh and applies every resource; force and other pull options are refused. Project mode (`--project`) stays native.

## Agent targets

New configurations target Claude, Codex and OpenCode. Choose others with `--agents`, for example `--agents claude,codex,cursor,gemini`.

| Target | Skills | Global instructions | Session-start refresh |
|---|---|---|---|
| `claude` | `~/.claude/skills` | `~/.claude/CLAUDE.md` | `SessionStart` hook |
| `codex` | `~/.agents/skills` | `~/.codex/AGENTS.md` | `SessionStart` hook |
| `opencode` | `~/.config/opencode/skills` | `~/.config/opencode/AGENTS.md` | Plugin |
| `cursor` | `~/.cursor/skills` | none | `sessionStart` hook |
| `gemini` | `~/.gemini/skills` | none | none |

Every target with an executable on `PATH` at configure time also gets a launcher in `~/.local/bin` that refreshes before starting the original executable. Cursor's hook is installed whenever `~/.cursor` exists. Grok reads the Claude and Cursor hook files, so it refreshes too.

## Content repository

A content repository has `skills/`, `packages/`, `instructions/` and `backbone.json`. The default checkout is `~/.local/share/agent-backbone/library/`.

```json
{
  "schema_version": 1,
  "skills_dir": "skills",
  "instructions": [{"path": "instructions/global.md", "agents": ["claude", "codex", "opencode"]}],
  "packages": []
}
```

`instructions[].agents` defaults to Claude, Codex and OpenCode. `mode` is `append` (default) or `symlink`. Append mode adds the shared file as a block in each agent's instruction file and keeps local text. Symlink mode links every agent's instruction file to one canonical source; it must be the only instruction source for those agents and gets no separate host-policy block, so the shared file must carry any required host guidance.

Package declarations support:

- `name`, `path`: the package slug and its directory.
- `claude_plugin`: deliver the package to Claude as one complete plugin.
- `host_notes`: a file the agents are told to read before using the package.
- `local_files`: files kept across upstream updates, such as host adapters.
- `provenance_file`: a JSON file updated with the upstream repository, commit and tree.
- `upstream`: `repository`, `path`, `ref`, `approved_tree`, `approved_commit`.
- `skill_naming`: how upstream updates name shared skill links. `directory` (default) uses each skill's folder name; `frontmatter` uses the `name` in its `SKILL.md`.
- `skill_prefix`: a prefix such as `"skill_prefix": "vendor"`. Updates name shared links `vendor-<skill>`, and delivery rewrites the frontmatter name the same way without changing source files.

Full packages keep their licenses, scripts, references and adapters. `agents/`, `extras/` and `mcp.yaml` can hold portable shared definitions; credentials and OAuth state stay local. Existing installer-owned skills and foreign MCP servers are preserved.

Disabled skills keep receiving approved source updates but are not delivered. Start a new agent session after changing the selection. Selection and target preferences are per machine, in `~/.config/agent-backbone/skillshare-control.yaml`; local ignore files are excluded from Git.

Generated extras named `agent-backbone-*` bind the shared instructions and the package access policy. Change their content sources or the skill selection rather than editing them. Skillshare flags and preserves a hand-edited block.

## Runtimes

`runtimes.json` can pin an approved Argent version. Configure and refresh install it through Argent's own installer, then install its skills for the configured Claude, Codex and OpenCode targets. Argent owns its CLI skills and lockfile; they are not copied into the shared source. A local Argent change is reported, not reverted.

Backbone sets Argent's `allowlist.enabled` to `false` when it is unset. This only stops `argent update` from rewriting editors' auto-approve lists, which Backbone and Git own.

```sh
agent-backbone runtime status
agent-backbone runtime sync
agent-backbone runtime pin argent VERSION   # records the version for review and publishing
```

## Shared agent settings

Put the settings every machine should share in `settings/`:

| File | Written to |
|---|---|
| `claude.json` | `~/.claude/settings.json`, including `enabledPlugins` and `extraKnownMarketplaces` |
| `codex.toml` | `~/.codex/config.toml` |
| `opencode.json` | `~/.config/opencode/opencode.jsonc`, or `opencode.json` |
| `grok.toml` | `~/.grok/config.toml`, when `~/.grok` exists |
| `cursor.json` | Cursor's user `settings.json`, when Cursor is installed |

Each refresh writes exactly the listed keys and leaves every other local key alone. Removing a key from Git removes it locally on the next refresh. Objects merge key by key; arrays and scalars replace. TOML files are edited line by line, so comments and unmanaged tables stay as they are.

Claude plugins listed as enabled are installed with `claude plugin install` when missing. Plugins ending in `@synced` are skipped: they come from the claude.ai account, and Claude syncs them itself.

Keys owned elsewhere are refused: Claude `hooks` and `mcpServers`; Codex `mcp_servers`, `hooks` and `projects`; OpenCode `mcp`; Grok `hooks`. Never put logins, tokens or machine-specific paths in these files.

## Refresh and safety

Refresh runs before a launcher starts an agent and from each agent's session-start hook. Version and help probes (`--version`, `-h` and similar) skip it. Codex needs `[features] hooks = true`; Backbone records the trust hash for its own refresh hook in `~/.codex/config.toml`, so Codex runs it without asking, while other hooks still need your approval.

Dirty sources, divergence and network failures keep the cached delivery and report the problem. Dashboard edits apply locally; review, commit and push them to reach other machines. Native ignore patterns, resource settings and copy mode survive refresh. Locally edited managed copies and generated package views are detected and refused.

```sh
agent-backbone status
agent-backbone inventory
agent-backbone adopt /path/to/skill --name my-skill
agent-backbone upstream check
agent-backbone upstream update --all
agent-backbone validate
skillshare audit --global --no-tui
skillshare doctor
```

`adopt` copies the full skill and any installer provenance; it does not remove the original. Review licenses, private content and duplicate registrations before publishing. Upstream updates stay local until you commit them. In CI, `upstream update --all --repository .` and `validate --repository .` work without configuring agents. Audits and sync do not run skill scripts.

Run the dashboard through the managed launcher so package filtering stays active. `ui start` is refused; use a detached terminal instead: `tmux new-session -d -s agent-backbone-ui 'skillshare ui --no-open'`. The dashboard binds to loopback. Remote access needs a private port forward or proxy that validates the Host and Origin headers.

## Files Backbone writes

- `~/.local/bin/skillshare`, `~/.local/bin/<agent>` and `~/.local/bin/agent-backbone-refresh`
- The refresh entry in `~/.claude/settings.json` and `~/.codex/hooks.json` (`SessionStart`) and `~/.cursor/hooks.json` (`sessionStart`)
- `~/.config/opencode/plugins/agent-backbone-refresh.js`
- The Codex hook trust record in `~/.codex/config.toml`
- Configuration in `~/.config/agent-backbone/` and generated skill views in `~/.local/share/agent-backbone/active/`
- State under `~/.local/state/agent-backbone/`, including the shared-settings ledger `settings-managed.json`

Each configure, refresh, toggle and upstream update saves what it replaces in a new `backup-*`, `sync-backup-*`, `toggle-backup-*`, `native-backup-*` or `upstream-backup-*` directory under `~/.local/state/agent-backbone/`. The configure backup holds the original `skillshare` and agent executables.

Homebrew uninstall removes the tool, not content or state. Before uninstalling, remove the launchers and hook entries above and restore the originals from the configure backup.

## Development

Requires Node 22.16+, tmux and a Skillshare binary. `scripts/download-engine.sh` downloads the pinned, checksum-verified release to `vendor/skillshare`.

```sh
npm ci --ignore-scripts
scripts/download-engine.sh
npm run typecheck
AGENT_BACKBONE_SKILLSHARE="$PWD/vendor/skillshare" npm test
```

Tests run the real engine and its HTTP dashboard. After `npm run build`, `npm run test:built` reruns the compiled suite, and `node --test --test-name-pattern="case name" dist/tests/integration.js` runs one case. Rebuild after source edits.
