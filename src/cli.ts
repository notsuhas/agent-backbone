import { validate } from './validate.js';
import { Command } from 'commander';
import * as path from 'node:path';
import { agentSchema, defaultTargets, VERSION } from './model.js';
import { config, manifest } from './delivery.js';
import { configure, sync, status, inventory, launch, skills, setEnabled, removeStartupRefresh } from './operations.js';
import { upstreamCheck, upstreamUpdate, adopt } from './upstream.js';
import { locked } from './files.js';
import { runtimeStatus, pinArgent, syncRuntimes } from './runtimes.js';

const cli = new Command().enablePositionalOptions().name('agent-backbone').description('Keep coding agents\' skills, MCP servers, hooks, instructions and settings in sync from one Git repository.').version('agent-backbone ' + VERSION);
cli.command('configure <repository>').description('Clone or link a content repository and install it for your agents.').option('--destination <path>', 'where to clone a remote repository').option('--agents <agents>', 'agent targets', defaultTargets.join(',')).action(async (repository: string, options: { destination?: string; agents: string }) => {
  await configure({ repository, ...options });
});
cli.command('sync').description('Pull the content repository and apply it.').option('--startup', 'legacy: ignored; automatic refresh was removed').action(async (options: { startup?: boolean }) => { if (!options.startup) await sync(); });
cli.command('cleanup-startup').description('Remove legacy automatic refresh hooks without pulling the repository.').action(async () => locked(removeStartupRefresh));
cli.command('status').description('Show the source, refresh state, targets and upstream checks.').action(status);
const runtime = cli.command('runtime').description('Manage the approved Argent version.');
runtime.command('status').description('Compare the approved and installed Argent versions.').action(async () => runtimeStatus(config().repo));
runtime.command('sync').description('Install the approved Argent version and its skills.').action(async () => locked(async () => syncRuntimes(config())));
runtime.command('pin <name> <version>').description('Record an approved Argent version in the content repository.').option('--repository <path>', 'content repository to edit').action((name: string, version: string, options: { repository?: string }) => {
  if (name !== 'argent') throw new Error('Only Argent runtime ownership is supported.');
  pinArgent(options.repository ? path.resolve(options.repository) : config().repo, version);
});
cli.command('inventory').description('List installed skills across agents as JSON, with duplicates.').action(inventory);
cli.command('skills').description('Open Skillshare’s native manager; list state when piped.').option('--list', 'print skill states without opening the picker').option('--interactive', 'open the native manager').action(async (options: { list?: boolean; interactive?: boolean }) => {
  if (options.list && options.interactive) throw new Error('Choose --list or --interactive.');
  if (options.interactive || (!options.list && process.stdin.isTTY && process.stdout.isTTY)) await (await import('./native.js')).nativeManager();
  else skills();
});
cli.command('manage').description('Open Skillshare’s native skill manager.').action(async () => (await import('./native.js')).nativeManager());
cli.command('enable <names...>').description('Expose the latest cached versions of shared skills.').action((names: string[]) => setEnabled(names, true));
cli.command('disable <names...>').description('Hide shared skills while continuing source updates.').action((names: string[]) => setEnabled(names, false));
cli.command('launch <agent> [arguments...]').description('Run the original agent executable without refreshing.').allowUnknownOption().allowExcessArguments().passThroughOptions().action((agent: string, args: string[]) => launch(agentSchema.parse(agent), args));
cli.command('validate').description('Check skills, packages and shared settings in a content repository.').option('--repository <path>', 'content repository to check').action((options: { repository?: string }) => validate(options.repository ? path.resolve(options.repository) : config().repo));
const upstream = cli.command('upstream').description('Check and apply updates to packages with an upstream.');
upstream.command('check').description('Report packages whose upstream changed.').option('--repository <path>', 'content repository to check').action(async (options: { repository?: string }) => { const repo = options.repository ? path.resolve(options.repository) : config().repo; await upstreamCheck(manifest(repo)); });
upstream.command('update [name]').description('Copy upstream changes into the content repository for review.').option('--all', 'update every package with an upstream').option('--repository <path>', 'content repository to edit').action(async (name: string | undefined, options: { all?: boolean; repository?: string }) => {
  if (!name && !options.all) throw new Error('Choose a package or --all.');
  if (name && options.all) throw new Error('Choose a package or --all, not both.');
  const repo = options.repository ? path.resolve(options.repository) : config().repo;
  await locked(() => upstreamUpdate(repo, name, !!options.all));
});
cli.command('adopt <source>').description('Copy an installed skill into the content repository as a package.').requiredOption('--name <name>', 'package and skill name').action(async (source: string, options: { name: string }) => locked(async () => adopt(config().repo, source, options.name)));
for (const name of ['ui', 'audit', 'doctor', 'analyze', 'mcp', 'hooks', 'extras', 'target', 'search', 'plugin']) {
  cli.command(name + ' [arguments...]').description('Use Skillshare’s native ' + name + ' controls.').allowUnknownOption().allowExcessArguments().passThroughOptions().helpOption(false).action(async (args: string[]) => (await import('./native.js')).nativeCommand([name, ...args]));
}
cli.command('agents [arguments...]').description('Manage custom agents with Skillshare.').allowUnknownOption().allowExcessArguments().passThroughOptions().helpOption(false).action(async (args: string[]) => (await import('./native.js')).nativeCommand(['list', 'agents', ...args]));
cli.command('native-manager').description('Open Skillshare’s native terminal manager.').action(async () => (await import('./native.js')).nativeManager());
cli.command('skillshare [arguments...]').description('Run Skillshare with the managed configuration.').allowUnknownOption().allowExcessArguments().passThroughOptions().helpOption(false).action(async (args: string[]) => (await import('./native.js')).nativeCommand(args));
try { await cli.parseAsync(); }
catch (error) { process.stderr.write('agent-backbone: ' + (error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
