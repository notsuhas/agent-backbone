# Agent Backbone

A TypeScript adapter around Skillshare for automatic Git refresh and complete plugin delivery. Skillshare is the management interface: its dashboard, terminal manager, toggles, audits, targets, MCP, hooks and extras use one persistent configuration.

```sh
brew install notsuhas/tap/agent-backbone
agent-backbone configure OWNER/REPOSITORY
skillshare list       # / searches, t toggles immediately, q exits
skillshare ui         # dashboard; keep this terminal running
skillshare pull       # fetch approved content and apply it
```

Configure installs a `~/.local/bin/skillshare` launcher that runs the bundled native engine through the adapter. An existing executable there is retained in the configuration backup. Put `~/.local/bin` first in PATH. Homebrew owns engine upgrades: use `brew upgrade agent-backbone`. `agent-backbone skills`, `manage` and the previous native command aliases remain compatible, but all interactive skill management now uses Skillshare's native terminal UI. There is no second checkbox manager.

## What belongs to which tool

| Responsibility | Owner |
|---|---|
| Dashboard, terminal manager, ignore patterns, skill toggles and per-agent settings | Skillshare |
| Skill/agent/MCP/hook/extra delivery and security audits | Skillshare |
| Shared instruction blocks that preserve local content and symlinks | Skillshare single-file extras |
| Session-start refresh and the macOS 15-minute timer | Backbone adapter |
| Filter individual disabled skills inside complete plugins; preserve package assets and host notes | Backbone adapter |
| Upstream provenance, adapter-preserving package updates and daily update PRs | Backbone updater and the content repository |

The adapter is needed for this package layout, not for ordinary standalone Skillshare libraries. Native plugin selection is per target; it does not apply the library's individual skill selections inside complete plugin trees. Native `pull` uses its Git root scope and can merge histories. Managed `skillshare pull` instead keeps the existing fast-forward-only refresh and applies all configured resources. Force and other pull options are refused; project mode stays native.

## Content and machine settings

Tool code, shared content and OS dotfiles stay separate. A content repository has `skills/`, `packages/`, `instructions/` and `backbone.json`:

```json
{
  "schema_version": 1,
  "skills_dir": "skills",
  "instructions": [{"path": "instructions/global.md", "agents": ["claude", "codex"]}],
  "packages": []
}
```

Package declarations support `name`, `path`, `claude_plugin`, `host_notes`, `local_files`, `provenance_file` and `upstream` (`repository`, `path`, `ref`, `approved_tree`, `approved_commit`). Full packages retain their licenses, scripts, references and host adapters. Disabled skills keep receiving approved source updates but are omitted from delivery. Start a new agent session after changing selection.

Selection and target preferences are per machine, in `~/.config/agent-backbone/skillshare-control.yaml`. Local ignore files are excluded from Git. `agents/`, `extras/` and `mcp.yaml` can hold portable shared definitions; credentials and OAuth state stay local. Existing installer-owned skills and foreign MCP servers are preserved. The default checkout is `~/.local/share/agent-backbone/library/`.

Shared instruction files are native single-file extras in append mode. Their dashboard entries point to canonical Git files. Generated extras named `agent-backbone-*` provide instruction bindings and package access policy; change their content sources or skill/target selection rather than editing generated bindings. Legacy Backbone instruction blocks migrate once to Skillshare blocks. Local text and instruction symlinks remain; a hand-edited Skillshare block is flagged and preserved.

## Updates and safety

Refresh runs before supported agent launch, on Claude startup/resume, and every 15 minutes on macOS. Linux uses launchers/hooks unless you add a timer. Dirty sources, divergence and network failures retain cached delivery and report the problem. Native dashboard edits apply locally, but must be reviewed, committed and pushed to reach other machines. Native ignore patterns, resource settings and copy mode survive refresh. Locally edited managed copies and generated package views are detected.

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

Adoption copies the full skill and available provenance; it does not remove the installer's original. Review licenses, private content and duplicate registration before publishing. In CI, `upstream update --all --repository .` and `validate --repository .` work without configuring agents. Source updates do not publish automatically. Audits and sync do not execute skill scripts; audit findings need interpretation.

Run the dashboard through the managed launcher so package filtering stays active. `ui start` is unavailable; use a detached terminal instead: `tmux new-session -d -s agent-backbone-ui 'skillshare ui --no-open'`. The adapter binds to loopback. Remote sharing needs a private port forward/proxy that validates the remote Host and Origin. Dashboard status recognizes actual generated package contents without hiding foreign local skills or changed bodies.

Homebrew uninstall removes the tool, not content or state. Restore generated launchers/hooks/timers before uninstalling. State and backups are under `~/.local/state/agent-backbone/`. Claude/Codex instruction and launch integration are verified; other configured agent targets use native skill-directory delivery.

## Development

Requires Node 22.16+ and a trusted Skillshare binary. Run `npm ci --ignore-scripts`, `npm run typecheck`, and `AGENT_BACKBONE_SKILLSHARE=/path/to/skillshare npm test`. Terminal tests require tmux; tests run the real engine and native HTTP dashboard.
