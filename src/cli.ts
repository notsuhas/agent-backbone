import { validate } from './validate.js';
import { Command } from 'commander';
import * as path from 'node:path';
import { agentSchema, VERSION } from './model.js';
import { config, manifest } from './delivery.js';
import { configure, sync, status, inventory, launch, execute, skills, setEnabled } from './operations.js';
import { upstreamCheck, upstreamUpdate, adopt } from './upstream.js';
import { enginePath, paths, locked } from './files.js';

const cli = new Command().enablePositionalOptions().name('agent-backbone').description('Sync skills and shared agent instructions from any Git repository.').version('agent-backbone ' + VERSION);
cli.command('configure <repository>').option('--destination <path>').option('--agents <agents>', 'agent targets', 'claude,codex').option('--interval <seconds>', 'refresh interval', value => Number(value), 900).option('--no-background').action(async (repository: string, options: { destination?: string; agents: string; interval: number; background: boolean }) => {
  if (!Number.isInteger(options.interval) || options.interval < 60) throw new Error('Refresh interval must be at least 60 seconds.');
  await configure({ repository, ...options, noBackground: !options.background });
});
cli.command('sync').option('--startup').action(async (options: { startup?: boolean }) => sync(!!options.startup));
cli.command('status').action(status);
cli.command('inventory').action(inventory);
cli.command('skills').description('List shared skills and their local enabled state.').action(skills);
cli.command('enable <names...>').description('Expose the latest cached versions of shared skills.').action((names: string[]) => setEnabled(names, true));
cli.command('disable <names...>').description('Hide shared skills while continuing source updates.').action((names: string[]) => setEnabled(names, false));
cli.command('launch <agent> [arguments...]').allowUnknownOption().allowExcessArguments().passThroughOptions().action((agent: string, args: string[]) => launch(agentSchema.parse(agent), args));
cli.command('validate').option('--repository <path>').action((options: { repository?: string }) => validate(options.repository ? path.resolve(options.repository) : config().repo));
const upstream = cli.command('upstream');
upstream.command('check').option('--repository <path>').action(async (options: { repository?: string }) => { const repo = options.repository ? path.resolve(options.repository) : config().repo; await upstreamCheck(repo, manifest(repo)); });
upstream.command('update [name]').option('--all').option('--repository <path>').action(async (name: string | undefined, options: { all?: boolean; repository?: string }) => {
  if (!name && !options.all) throw new Error('Choose a package or --all.');
  if (name && options.all) throw new Error('Choose a package or --all, not both.');
  const repo = options.repository ? path.resolve(options.repository) : config().repo;
  await locked(() => upstreamUpdate(repo, name, !!options.all));
});
cli.command('adopt <source>').requiredOption('--name <name>').action(async (source: string, options: { name: string }) => locked(async () => adopt(config().repo, source, options.name)));
cli.command('skillshare [arguments...]').allowUnknownOption().allowExcessArguments().passThroughOptions().action((args: string[]) => { config(); process.env.SKILLSHARE_CONFIG = path.join(paths().directory, 'skillshare.yaml'); execute(enginePath(), args); });
try { await cli.parseAsync(); }
catch (error) { process.stderr.write('agent-backbone: ' + (error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
