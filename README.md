# Shared skill backbone

A public, curated skill source for Claude Code and Codex. Pstack is pinned to the upstream revision in `packages/pstack/PROVENANCE.json`; its MIT notice is retained in that package. Cloud skill exports and machine configuration are deliberately excluded from this repository.

## Layout

- `packages/pstack/`: complete plugin, including agents and support files.
- `skills/`: portable relative links to the 52 approved Pstack skills. Optional automation packs are not exposed here.
- `scripts/skills_refresh.py`: bounded refresh, process lock, revision and freshness tracking, and stale-cache warnings.
- `scripts/skills_launch.py`: refresh before starting an agent; keeps stdout clean for stdio app servers.

## Bootstrap on each machine

```sh
git clone https://github.com/notsuhas/skill-backbone.git ~/.agents/skill-backbone
python3 ~/.agents/skill-backbone/scripts/bootstrap.py
```

Requires Python 3, Git and curl on macOS/Linux. It installs pinned Skillshare v0.25.10 after checksum verification, configures native links, backs up replaced paths and wraps installed Claude/Codex launchers. Keep `~/.local/bin` first in PATH. It refreshes on CLI/app-server process start; already-running sessions retain their existing context.

Claude also receives a native startup/resume hook. On macOS a user LaunchAgent refreshes every 15 minutes, covering long-lived processes and applications that launch their own binaries. Existing conversation context is not rewritten; newly loaded files use the refreshed library. Linux uses the launchers and Claude hook; a system timer is not installed there.

1. Clone this repository to a stable local directory.
2. Install a pinned Skillshare release for that machine's OS.
3. Initialize Skillshare with `--source <checkout>/skills --targets codex --mode merge --no-copy --no-git --no-skill`. Set `follow_source_links: true` in that machine's Skillshare config. Keep `git_root` at its default so pulls use the skills directory's enclosing Git repository.
4. Set `git config pull.ff only` in the checkout. Publish reviewed edits from the canonical repository; never force-pull at startup.
5. Preserve the Claude plugin as one unit: link `~/.claude/skills/pstack` to `<checkout>/packages/pstack`. Review existing installations before replacing links to avoid duplicate registrations.
6. Link `~/.agents/packages/pstack` to the same complete package and add a host instruction to read its `HOST.md` when using Pstack. Preserve existing user instructions.
7. Wire the refresh wrapper into Claude's startup hook or an agent launcher. For Codex, use the launcher before both CLI and app-server starts, or review/trust its native hook in `/hooks`. A hook file alone is not sufficient.

These steps are a rollout recipe, not a statement that your current installation has been migrated. Tool authentication and required runtimes remain local to each machine.

## Refresh command

Invoke `python3 <checkout>/scripts/skills_refresh.py --binary <absolute-skillshare-path> --repo <checkout> --state <local-state-directory>/refresh-status.json`. Configure the local Skillshare config path in the launch environment when needed.

The wrapper records the checked-out revision, last attempt, last successful refresh and status. Failure emits a warning and retains available local skills. The timeout defaults to 20 seconds. Concurrent startups serialize through a nonblocking local lock; the second start uses the current cache.

For a pre-launch refresh, pass that command as a JSON argument array to `skills_launch.py --refresh-command-json '<array>' --agent-command-json '["<absolute-agent-binary>"]' -- <agent arguments>`. Use the real agent binary, not the wrapper itself.

## Drift and upstream updates

Use merge/symlink delivery. Editing a managed link changes the canonical Git-tracked file; dirty sources refuse a pull. Copy targets can silently retain local edits until a later source update overwrites them, so they are unsuitable as authoring locations without a separate drift audit.

Sharing an approved revision and upgrading upstream skills are separate operations. Review upstream changes, preserve licenses, run compatibility checks, update the provenance pin, then commit the approved version. Do not auto-publish arbitrary upstream changes into the shared branch.

The refresh script checks the public Pstack tree at most once daily and warns when upstream changes need review. It records that check separately from machine sync freshness. An unavailable upstream check does not replace the approved skills.

```sh
skill-backbone status                 # revision, freshness, local edits, upstream state
skill-backbone sync                   # refresh now
skill-backbone skillshare list        # use the shared library configuration
```

Add reviewed skills to the source view in `skills/`, keeping full packages in `packages/` and using relative links. Commit with a Conventional Commit message and push to the shared branch; other bootstrapped machines receive it on refresh. A new third-party skill still needs its own license, privacy and host-compatibility review.

Keep private context, credentials, generated output and auth stores outside this public repository. Check new skills and their supporting files before publication; a generic SKILL.md does not guarantee that its examples or assets are safe to share.
