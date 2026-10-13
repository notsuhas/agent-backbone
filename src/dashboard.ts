import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer, request } from 'node:http';
import { createServer as reservePort } from 'node:net';
import { z } from 'zod';
import { config, manifest, sourceSkills } from './delivery.js';
import { nativeDocument, controlPath, engineTarget } from './engine.js';
import { paths, exists, real, digest, contained } from './files.js';
import { roots, type Agent } from './model.js';

const itemSchema = z.object({ skill: z.string(), action: z.string(), kind: z.string().optional() }).passthrough();
const diffSchema = z.object({ target: z.string(), items: z.array(itemSchema) }).passthrough();
function deliveryProbe() {
  const current = config(), data = manifest(current.repo), skills = sourceSkills(current.repo, data);
  const native = nativeDocument(controlPath());
  const targetRoots = new Map(current.targets.map(agent => [agent, engineTarget(native, agent).path || path.join(paths().home, roots[agent])]));
  const canonicalSources = new Set(skills.values());
  const nativeTargets = new Map<Agent, Map<string, string>>();
  for (const agent of current.targets) {
    const entries = Object.entries(current.managed_links).filter(([file, source]) => path.dirname(file) === targetRoots.get(agent) && canonicalSources.has(real(source)));
    nativeTargets.set(agent, new Map(entries.map(([file, source]) => [real(source), file])));
  }
  const plugins = data.packages.filter(pkg => pkg.claude_plugin).map(pkg => ({ name: pkg.name, root: real(contained(current.repo, pkg.path)) }));
  const hashes = new Map<string, string>();
  function hash(file: string) {
    const cached = hashes.get(file);
    if (cached) return cached;
    const value = digest(file); hashes.set(file, value); return value;
  }
  function delivered(agent: Agent, id: string) {
    const root = targetRoots.get(agent);
    if (!root) return false;
    const aliasSource = current.managed_links[path.join(root, id)];
    const canonical = skills.get(id) || (aliasSource && canonicalSources.has(real(aliasSource)) ? real(aliasSource) : undefined);
    if (!canonical || !root) return false;
    const direct = nativeTargets.get(agent)?.get(canonical) || path.join(root, id), recorded = current.managed_links[direct];
    if (recorded && exists(direct)) {
      const copy = current.managed_copies[direct];
      if (copy && hash(direct) === copy && hash(canonical) === current.managed_source_hashes[direct]) return true;
      if ((real(direct) === real(recorded) || copy) && hash(direct) === hash(canonical)) return true;
    }
    if (agent !== 'claude') return false;
    for (const pkg of plugins) {
      const relative = path.relative(pkg.root, canonical);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const alias = path.join(root, pkg.name), installed = path.join(alias, relative);
      if (current.managed_links[alias] && exists(installed) && real(alias) === real(current.managed_links[alias]) && hash(installed) === hash(canonical)) return true;
    }
    return false;
  }
  return { current, skills, delivered };
}
function correctedTarget(value: unknown, probe: ReturnType<typeof deliveryProbe>) {
  const diff = diffSchema.parse(value), agent = probe.current.targets.find(agent => agent === diff.target);
  if (agent) diff.items = diff.items.filter(item => (item.kind && item.kind !== 'skill') || !['link', 'update'].includes(item.action) || !probe.delivered(agent, item.skill));
  return diff;
}
function correctedPayload(value: unknown) {
  const body = z.record(z.string(), z.unknown()).parse(value), probe = deliveryProbe();
  if (Array.isArray(body.diffs)) body.diffs = body.diffs.map(value => correctedTarget(value, probe));
  if (body.diff) body.diff = correctedTarget(body.diff, probe);
  if (Array.isArray(body.targets)) {
    const { current, skills, delivered } = probe;
    body.targets = body.targets.map(value => {
      const target = z.object({ name: z.string(), path: z.string(), expectedSkillCount: z.number().optional(), localCount: z.number().optional() }).passthrough().parse(value);
      const agent = current.targets.find(agent => agent === target.name);
      if (!agent) return target;
      const count = [...skills.keys()].filter(id => delivered(agent, id)).length;
      const physical = Object.keys(current.managed_links).filter(file => path.dirname(file) === target.path && exists(file)).length;
      return { ...target, linkedCount: count, localCount: Math.max(0, (target.localCount || 0) - physical), status: count === target.expectedSkillCount ? 'linked' : 'has files' };
    });
  }
  return body;
}
export async function dashboardProxy(args: string[]) {
  let port = 19420;
  const backendArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--port') { port = Number(args[++index]); continue; }
    if (arg?.startsWith('--port=')) { port = Number(arg.slice(7)); continue; }
    if (arg === '--host') { const host = args[++index]; if (!['127.0.0.1', 'localhost'].includes(host || '')) throw new Error('The dashboard adapter binds to loopback. Forward its port for remote access.'); continue; }
    if (arg?.startsWith('--host=')) { if (!['127.0.0.1', 'localhost'].includes(arg.slice(7))) throw new Error('The dashboard adapter binds to loopback. Forward its port for remote access.'); continue; }
    if (arg) backendArgs.push(arg);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dashboard port.');
  const reserved = reservePort(); await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const address = reserved.address(); if (!address || typeof address === 'string') throw new Error('Could not allocate dashboard backend port.');
  const backendPort = address.port; await new Promise<void>((resolve, reject) => reserved.close(error => error ? reject(error) : resolve()));
  const frontURL = 'http://127.0.0.1:' + port, backendURL = 'http://127.0.0.1:' + backendPort;
  const server = createServer((incoming, outgoing) => {
    if (![ '127.0.0.1:' + port, 'localhost:' + port ].includes(incoming.headers.host || '')) { outgoing.writeHead(403); outgoing.end('Invalid dashboard host.'); return; }
    const origin = incoming.headers.origin;
    if (origin && ![frontURL, 'http://localhost:' + port].includes(origin)) { outgoing.writeHead(403); outgoing.end('Invalid dashboard origin.'); return; }
    const headers = { ...incoming.headers, host: '127.0.0.1:' + backendPort, ...(origin ? { origin: backendURL } : {}) };
    const upstream = request({ hostname: '127.0.0.1', port: backendPort, path: incoming.url, method: incoming.method, headers }, response => {
      const isDiff = incoming.method === 'GET' && /\/api\/(?:diff|targets)(?:\?|$)/.test(incoming.url || '');
      const isStream = incoming.method === 'GET' && /\/api\/diff\/stream(?:\?|$)/.test(incoming.url || '');
      if (!isDiff && !isStream) { outgoing.writeHead(response.statusCode || 502, response.headers); response.pipe(outgoing); return; }
      const filteredHeaders = { ...response.headers }; delete filteredHeaders['content-length'];
      outgoing.writeHead(response.statusCode || 502, filteredHeaders);
      let buffer = '';
      response.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (isStream) {
          const frames = buffer.split('\n\n'); buffer = frames.pop() || '';
          for (const frame of frames) {
            outgoing.write(frame.split('\n').map(line => {
              if (!line.startsWith('data:')) return line;
              try { return 'data: ' + JSON.stringify(correctedPayload(JSON.parse(line.slice(5)))); } catch { return line; }
            }).join('\n') + '\n\n');
          }
        }
      });
      response.on('end', () => {
        if (isStream) outgoing.end(buffer);
        else { try { outgoing.end(JSON.stringify(correctedPayload(JSON.parse(buffer)))); } catch { outgoing.end(buffer); } }
      });
    });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end('Skillshare is starting. Retry shortly.'); });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { args: [...backendArgs, '--host', '127.0.0.1', '--port', String(backendPort), '--no-open'], frontURL, backendURL, close: () => { server.closeAllConnections(); server.close(); } };
}
