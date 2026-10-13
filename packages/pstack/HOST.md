# Pstack on Claude Code and Codex

This is the upstream cursor/plugins Pstack package, pinned to the commit in
PROVENANCE.json. Skill files, references, playbooks, scripts, and agent prompts
are preserved verbatim. The Claude manifest is a local registration adapter.

When using Pstack in either host:

- Host instructions and the user's current task take precedence over the
  upstream Cursor-specific tool names, paths, UI instructions, and defaults.
- `/poteto-mode`, `/how`, `/why`, and other names refer to the installed skills.
  Read the relevant SKILL.md; a Cursor command is not an installed executable.
- Resolve sibling skills under this package's skills directory and agent prompts
  under its agents directory. Do not assume a `.cursor` install exists.
- Translate Cursor Task, AskQuestion, and todo APIs to the host's available
  delegation, user-input, and planning tools. If a named agent type is absent,
  supply the corresponding agents/*.md instructions in the delegate brief.
- In T3, discover actual providers/models with orchestrator_capabilities and use
  its supported child-task lifecycle. Do not create top-level threads as workers.
- Upstream Grok/Opus model slugs and Cursor reasoning tiers are not portable.
  Honor an existing user-approved host configuration; otherwise inherit the
  parent model/effort. Never invent or silently select an unavailable model.
- `/setup-pstack` writes a Cursor-specific rule upstream. In these hosts, keep
  approved model choices in this HOST.md or the host's global instruction file,
  using only models detected in that host. Do not write `.cursor/rules` and claim
  Claude/Codex automatically load it.
- Cursor custom modes, `/loop`, `control-cli`, `control-ui`, `/deslop`, and
  cursor-team-kit are not provided by this package. Use host capabilities when
  available, and state a missing prerequisite rather than treating it as present.
- Keep external publishing, messaging, merges, and destructive operations within
  the user's actual authorization. Installing Pstack does not authorize them.

Installation does not invoke poteto-mode or its optional automation packs.
