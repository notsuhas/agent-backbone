# Agent Backbone

A generic Homebrew tool for syncing skills and shared global instructions from your own Git repository. Tool code, personal content and OS dotfiles stay separate.

```sh
brew install notsuhas/tap/agent-backbone
agent-backbone configure you/agents
agent-backbone status
```

Homebrew owns the tool and its bundled, checksummed Skillshare engine. `brew upgrade` updates the tool; refresh fetches your selected content repository. No personal skill library is bundled.

## Content repository

Use `skills/` for native skill directories or relative links, `packages/` for complete plugin trees and `instructions/` for shared instructions. `backbone.json` describes them:

```json
{
  "schema_version": 1,
  "skills_dir": "skills",
  "instructions": [{"path": "instructions/global.md", "agents": ["claude", "codex"]}],
  "packages": []
}
```

Package fields: `name`, `path`, `claude_plugin`, `host_notes`, `local_files`, `provenance_file`, and `upstream` (`repository`, `path`, `ref`, `approved_tree`, `approved_commit`). Source pins and host adapters are data in your content repository, not built into the tool.

## Refresh and drift

Refresh runs before agent CLI/app-server starts, through Claude's startup/resume hook, and every 15 minutes on macOS. Linux uses launchers/hooks unless you add a timer. Git pulls are fast-forward only. Dirty source edits prevent refresh; offline/timeout failures preserve available local files and warn. Concurrent refresh writers use a local lock; protocol stdout stays clean.

Full Claude plugins stay together. Native symlinks expose a generated view of complete packages. Disabled skill directories are omitted from that view, including Claude plugins. Generated edits are detected; author changes in the source repository. Shared instructions replace only the `agent-backbone` marked block, preserving local content and existing instruction symlinks. Only recorded links are replaced or removed; foreign installer conflicts are reported before destination changes. Full Claude plugins require a skill root separate from other agents.

Choose targets with `--agents claude,codex,cursor,gemini,opencode`. Claude/Codex instruction and launch integration are verified; other targets use Skillshare's native-directory integration.

## Upstream releases and other installers

```sh
agent-backbone upstream check
agent-backbone upstream update my-plugin
agent-backbone inventory
agent-backbone adopt /path/to/a/skill --name my-skill
agent-backbone sync
agent-backbone skillshare list
```

Daily upstream checks flag new versions. Explicit updates change your local checkout, preserve declared adapters, validate paths/source-name conflicts, refresh the source view and update provenance. Review the Git diff and runtime compatibility before committing and pushing. Nothing is published automatically; other machines then fetch your approved revision.

Inventory shows native locations, differing instruction bodies under the same name, and skills.sh lockfile provenance where available. It deduplicates the same physical directory and skips hidden caches/trash. Adoption copies a full skill into `packages/`, creates a source link and imports available source metadata; the original installer files remain untouched. Review license/private context and resolve duplicate registrations before publication. Choose one owner per skill.

## Enable and disable skills

```sh
agent-backbone skills        # interactive picker in a terminal
agent-backbone skills --list # plain list
agent-backbone disable poteto-mode
agent-backbone enable poteto-mode
```

The picker searches skill IDs, descriptions and source labels. Arrow keys move, Space toggles and Enter saves all changes together. Ctrl-A enables filtered matches; Ctrl-D disables them. Esc clears a search or cancels; Ctrl-C cancels without saving. `agent-backbone manage` always opens the picker. Piped `skills` output stays plain text. Only Backbone-managed skills are selectable; `inventory` also reports installer-owned copies.

Selection is persistent per machine and applies to all configured agent targets. Disabled skills stay in the source repository and keep receiving approved updates, but disappear from native skill discovery and filtered plugin packages. Enabling exposes the latest cached version. Toggles work offline and survive refresh and reconfiguration. Start a new agent session to reload skills; current sessions keep their existing context. Other installers' duplicate copies remain their responsibility.

For CI, `agent-backbone upstream update --all --repository .` updates declared packages without configuring agents or needing Skillshare. `agent-backbone validate --repository .` checks package paths, links and skill metadata before an update PR is opened.

## Native Skillshare controls

```sh
agent-backbone ui                 # native dashboard, foreground
agent-backbone native-manager     # native terminal manager
agent-backbone audit --global --no-tui
agent-backbone analyze --global
agent-backbone doctor
agent-backbone mcp --help
agent-backbone agents --json --global
agent-backbone hooks --help
agent-backbone extras --help
agent-backbone plugin --help
```

Skillshare now owns ignore-pattern parsing and toggle storage. The checkbox picker remains as the Space/Enter interface; it uses that same state. Native dashboard edits update the canonical Git source, and a running adapter applies changes to both native skills and filtered Claude plugins. Rapid changes during a sync are retried. Run the dashboard through Backbone so this adapter stays active; `ui start` is deliberately unavailable. For a background terminal session, use `tmux new-session -d -s agent-backbone-ui 'agent-backbone ui --no-open'`.

`~/.config/agent-backbone/skillshare-control.yaml` stores native preferences and resource definitions with mode 0600. Refresh preserves them instead of replacing them. A separate generated delivery config contains the active skill view. Per-agent filters and copy mode use Skillshare; copies edited locally are preserved and flagged before replacement. Existing foreign MCP servers and credential stores stay untouched.

Shared custom agents live in the content repo's `agents/` directory; extras default to `extras/`. If the repo has `mcp.yaml` and no local inline MCP definitions, it becomes the shared MCP source. Use environment references for credentials; authentication remains on each machine. Native managers can edit these Git files, leaving changes for review and publication. Portable definitions must not contain secrets. Per-machine `.skillignore` and `.agentignore` files are excluded locally from Git.

Backbone retains source refresh, global instruction blocks, package provenance and full-plugin filtering. It does not run skill scripts during audit or sync. Read-only commands and audits use Skillshare directly; static audit findings require interpretation and do not prove a skill safe. Full third-party plugin operations remain Skillshare's native workflow; package-specific host adapters still belong in `backbone.json`.

## Local state and recovery

Config: `~/.config/agent-backbone/`. State/backups: `~/.local/state/agent-backbone/`. Default source checkout: `~/.local/share/agent-backbone/library/`; use `--destination` to change it. Git and agent credentials remain in their existing stores. Private repositories work with normal Git authentication.

Existing sessions retain their conversation context. Backups preserve replaced links/launchers. Homebrew uninstall removes the tool, not user content; restore generated wrappers/hooks/timers before uninstalling. Public content must exclude credentials, private context and restricted vendor exports.

## Development

TypeScript compiled to bundled JavaScript on Node 22.16+. Run `npm ci --ignore-scripts`, then `AGENT_BACKBONE_SKILLSHARE=/path/to/skillshare npm test` with a trusted Skillshare binary and `tmux` installed for terminal tests. `npm run typecheck` checks the source without building.
