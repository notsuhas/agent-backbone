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

Full Claude plugins stay together. Ordinary skills use native symlinks. Shared instructions replace only the `agent-backbone` marked block, preserving local content and existing instruction symlinks. Only recorded links are replaced or removed; foreign installer conflicts are reported before destination changes. Full Claude plugins require a skill root separate from other agents.

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

## Local state and recovery

Config: `~/.config/agent-backbone/`. State/backups: `~/.local/state/agent-backbone/`. Default source checkout: `~/.local/share/agent-backbone/library/`; use `--destination` to change it. Git and agent credentials remain in their existing stores. Private repositories work with normal Git authentication.

Existing sessions retain their conversation context. Backups preserve replaced links/launchers. Homebrew uninstall removes the tool, not user content; restore generated wrappers/hooks/timers before uninstalling. Public content must exclude credentials, private context and restricted vendor exports.

## Development

Python standard library only. Run `AGENT_BACKBONE_SKILLSHARE=/path/to/skillshare python3 -m unittest discover -s tests -v` with a trusted Skillshare binary.
