#!/usr/bin/env node
// boxed — run a program inside an MXC sandbox using a stored per-program config.
//
//   boxed [options] <name> [program args...]
//   boxed [options] --config FILE [program args...]
//
// Options: --debug, --dry-run, --print-config, --show-config, --allow-symlink PATH[:rw], --allow-port PORT,
//          --allow-host HOST, --deny-host HOST.
//
// Configs live in $BOXED_CONFIG_DIR, else $XDG_CONFIG_HOME/boxed, else ~/.config/boxed,
// one file per program: <name>.json. Each file is an MXC request JSON
// (https://github.com/microsoft/mxc/blob/main/docs/schema.md) plus an optional
// "boxed" key that this wrapper consumes and strips before handing off to MXC.
// --config FILE loads that file instead of looking <name> up in the config dir;
// <name> is then omitted and the program defaults to FILE's basename.
// --allow-symlink PATH grants read access to whatever the symlink PATH (relative to the
// current directory) points at, for this run only. PATH:rw grants write access as well.
// --allow-port PORT opens one more port on this machine through the proxy, for this run only.
// --allow-host HOST and --deny-host HOST add to the proxy's host lists for this run only.
//
// Each run gets a private directory under $XDG_CACHE_HOME/boxed (else ~/.cache/boxed)
// that holds the request handed to MXC and the program's TMPDIR; it is removed on exit.
//
// When the program exits, boxed stops the processes it left running, puts back any
// --allow-symlink link it changed, and reports symlinks it created that lead outside
// the sandbox.
//
// A config with "boxed.proxy" gets a filtering proxy for the length of the run. It lives
// in this process, so it cannot outlive boxed however boxed exits.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseHostRule, startProxy } from '../lib/proxy.js';

const DEFAULT_PASS_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'TERM_PROGRAM',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'EDITOR', 'VISUAL', 'NO_COLOR',
];

const PATH_KEYS = ['readwritePaths', 'readonlyPaths', 'deniedPaths'];

function die(message, code = 2) {
  console.error(`boxed: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = { debug: false, dryRun: false, printConfig: false, showConfig: false, config: null, allowSymlinks: [], allowPorts: [],
    allowHosts: [], denyHosts: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--debug') flags.debug = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--print-config') flags.printConfig = true;
    else if (arg === '--show-config') flags.showConfig = true;
    else if (arg === '--config') {
      if (++i >= argv.length) die('--config requires a file path');
      flags.config = argv[i];
    }
    else if (arg.startsWith('--config=')) flags.config = arg.slice('--config='.length);
    else if (arg === '--allow-symlink') {
      if (++i >= argv.length) die('--allow-symlink requires a path');
      flags.allowSymlinks.push(argv[i]);
    }
    else if (arg.startsWith('--allow-symlink=')) flags.allowSymlinks.push(arg.slice('--allow-symlink='.length));
    else if (arg === '--allow-port' || arg.startsWith('--allow-port=')) {
      if (arg === '--allow-port' && ++i >= argv.length) die('--allow-port requires a port number');
      const value = arg === '--allow-port' ? argv[i] : arg.slice('--allow-port='.length);
      const port = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!(port >= 1 && port <= 65535)) die(`--allow-port: ${JSON.stringify(value)} is not a port number`);
      flags.allowPorts.push(port);
    }
    else if (/^--(allow|deny)-host(=|$)/.test(arg)) {
      const [option, inline] = arg.split(/=(.*)/s);
      if (inline === undefined && ++i >= argv.length) die(`${option} requires a host`);
      const value = inline ?? argv[i];
      try { parseHostRule(value); } catch (error) { die(`${option}: ${error.message}`); }
      (option === '--allow-host' ? flags.allowHosts : flags.denyHosts).push(value);
    }
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (arg === '--') { i++; break; }
    else if (arg.startsWith('-')) {
      die(`unknown option ${arg} ` + (flags.config
        ? '(put program args after "--")'
        : '(options go before the program name)'));
    }
    else break;
  }
  if (flags.config === '') die('--config requires a file path');
  if (flags.allowSymlinks.some((arg) => /^(:(ro|rw))?$/.test(arg))) die('--allow-symlink requires a path');
  if (flags.config) return { flags, name: null, programArgs: argv.slice(i) };
  if (i >= argv.length) usage(2);
  return { flags, name: argv[i], programArgs: argv.slice(i + 1) };
}

function usage(code) {
  const text = [
    'Usage: boxed [options] <name> [program args...]',
    '       boxed [options] --config FILE [program args...]',
    '',
    `  <name>          loads ${path.join(configDir(), '<name>.json')}`,
    '  --debug         print the resolved request and enable MXC diagnostics (generated profile, etc.)',
    '  --dry-run       have MXC validate the request without running the program',
    '  --print-config  print the resolved MXC request JSON and exit',
    '  --show-config   summarise what the program would be allowed to do, and exit',
    '  --config FILE   load FILE instead of a named config; the program to run defaults to',
    '                  FILE\'s basename, and program args starting with "-" go after "--"',
    '  --allow-symlink PATH[:rw]',
    '                  grant read access to the target of the symlink PATH (relative to the',
    '                  current directory), or read-write access with ":rw"; may be repeated',
    '  --allow-port PORT',
    '                  let the program reach PORT on this machine through the boxed proxy;',
    '                  may be repeated',
    '  --allow-host HOST',
    '                  let the program reach HOST (or *.DOMAIN, optionally with :PORT) when the',
    '                  boxed proxy otherwise keeps it off the internet; may be repeated',
    '  --deny-host HOST',
    '                  have the boxed proxy refuse HOST (same forms); may be repeated',
  ].join('\n');
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

function configDir() {
  if (process.env.BOXED_CONFIG_DIR) return process.env.BOXED_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'boxed');
}

function cacheDir() {
  const xdg = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdg, 'boxed');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// True if child is parent or lies underneath it.
function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Objects merge key by key, arrays concatenate, anything else is replaced.
function merge(base, override) {
  if (Array.isArray(base) && Array.isArray(override)) return [...base, ...override];
  if (isObject(base) && isObject(override)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in base ? merge(base[key], value) : value;
    }
    return out;
  }
  return override;
}

function realOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

// What sits at p itself, without following it: "link:<target>", "other" or "absent".
function linkState(p) {
  try {
    return lstatSync(p).isSymbolicLink() ? `link:${readlinkSync(p)}` : 'other';
  } catch {
    return 'absent';
  }
}

// p and every directory between base and p, outermost first; just p if it is not under base.
function pathsBelow(base, p) {
  if (p === base || !isWithin(p, base)) return [p];
  const out = [];
  let current = base;
  for (const part of path.relative(base, p).split(path.sep)) {
    current = path.join(current, part);
    out.push(current);
  }
  return out;
}

// The program can write to the directory an --allow-symlink link lives in, so it can
// point the link somewhere else and wait for the next run to grant that. Anything it
// changed along the link's path is put back, and a link that appeared where there was
// none is removed.
function restoreSymlinks(watched) {
  const warn = (message) => console.error(`boxed: warning: ${message}`);
  for (const { link, from, target, snapshot } of watched) {
    for (const [p, before] of snapshot) {
      const now = linkState(p);
      if (now === before) continue;
      const was = before.startsWith('link:') ? before.slice(5) : null;
      const is = now.startsWith('link:') ? now.slice(5) : null;
      if (is === null && (was === null || now === 'other')) {
        if (was !== null) warn(`${p} was a symlink to ${was} and is now a file or directory; left as it is`);
        continue;
      }
      try {
        if (is !== null) unlinkSync(p);
        if (was !== null) symlinkSync(was, p);
        warn(`${p} ${is === null ? 'was removed' : `was made a symlink to ${is}`} during the run; ` +
             (was === null ? 'removed it' : `restored it to ${was}`));
      } catch (error) {
        warn(`${p} ${is === null ? 'was removed' : `was made a symlink to ${is}`} during the run ` +
             `and could not be put back: ${error.message}`);
      }
      // What used to be a real directory here is gone, so nothing beneath it can be put back.
      if (before === 'other') break;
    }
    // A link further along the chain is not in the snapshot, so the end result is compared too.
    let now = null;
    try { now = realpathSync(from); } catch { /* resolves to nothing */ }
    if (target !== null && now !== target) {
      warn(`--allow-symlink ${link} led to ${target} at launch and now leads to ${now ?? 'nothing'}; ` +
           'check it before the next run');
    }
  }
}

// Symlinks under roots that were created or replaced since the given time and lead
// somewhere the program was not allowed to go. The sandbox does not follow them, but
// whatever handles the directory next might.
function newOutsideSymlinks(roots, granted, since, skip) {
  const found = [];
  const stack = roots.filter((root) => !roots.some((other) => other !== root && isWithin(root, other)));
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      if (!entry.isSymbolicLink() || skip.has(p)) continue;
      try {
        if (lstatSync(p).ctimeMs < since) continue;
        const raw = readlinkSync(p);
        const target = realOrSelf(path.resolve(dir, raw));
        if (!granted.some((g) => isWithin(target, g))) found.push(`${p} -> ${raw}`);
      } catch { /* gone again */ }
    }
  }
  return found;
}

// Every process on the machine, by pid. withEnv adds each one's environment to "command"
// where the system lets ps read it. Null if ps cannot be run.
async function processTable(withEnv) {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('ps',
      [withEnv ? 'axeww' : 'axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='],
      { maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return null;
  }
  const table = new Map();
  for (const line of stdout.split('\n')) {
    // lstart is five words, as in "Tue Oct 13 12:06:30 2026".
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
    if (m) {
      table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), started: m[4], command: m[5] });
    }
  }
  return table;
}

// Finds what the program left running after it exited, so it can be stopped: a process
// still alive then can change things after boxed has checked them. Nothing ties an
// orphaned process to the run that started it, so this goes on three signs:
//   - it descends from the program, as seen by watching the process list during the run;
//   - it carries the marker boxed put in the program's environment;
//   - it is an orphan in boxed's own process group that started during the run. This one
//     only counts when boxed leads that group, as it does when started from an interactive
//     shell; a group shared with whatever launched boxed holds other programs' orphans too.
// A process that sets out to avoid all three can, so this is a clean-up and not a guarantee.
function watchProcesses(rootPid, marker, since) {
  const tracked = new Map(); // pid -> start time, which tells a reused pid apart
  let rootAlive = true;
  let timer;
  let polling = Promise.resolve();

  function update(table) {
    for (const [pid, started] of tracked) {
      if (table.get(pid)?.started !== started) tracked.delete(pid);
    }
    const mine = table.get(process.pid);
    for (const [pid, p] of table) {
      if (pid === process.pid || pid === rootPid || p.ppid === process.pid) continue;
      const orphaned = p.ppid === 1 && p.pgid === process.pid && mine?.pgid === process.pid &&
        Date.parse(p.started) >= since;
      if (orphaned || p.command.includes(marker)) tracked.set(pid, p.started);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, p] of table) {
        if (tracked.has(pid) || pid === process.pid || pid === rootPid) continue;
        if ((rootAlive && p.ppid === rootPid) || tracked.has(p.ppid)) {
          tracked.set(pid, p.started);
          grew = true;
        }
      }
    }
  }

  function poll() {
    polling = processTable(false).then((table) => {
      if (table && rootAlive) update(table);
      if (rootAlive) timer = setTimeout(poll, 500);
    });
  }
  poll();

  // Call once the program has exited. Resolves to the commands of the processes stopped.
  async function stopLeftovers() {
    rootAlive = false;
    clearTimeout(timer);
    await polling;
    const stopped = new Map();
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // One polite round with time to finish, then forced rounds for whatever is left or
    // was started in the meantime.
    for (let round = 0; round < 5; round++) {
      const table = await processTable(true);
      if (!table) break;
      update(table);
      if (!tracked.size) break;
      for (const pid of tracked.keys()) {
        stopped.set(pid, table.get(pid).command.split(' ')[0]);
        try { process.kill(pid, round === 0 ? 'SIGTERM' : 'SIGKILL'); } catch { /* already gone */ }
      }
      for (let waited = 0; waited < (round === 0 ? 2000 : 500); waited += 100) {
        await pause(100);
        const now = await processTable(false);
        if (now && ![...tracked].some(([pid, started]) => now.get(pid)?.started === started)) break;
      }
    }
    return [...stopped].map(([pid, command]) => `${path.basename(command)} (${pid})`);
  }

  return { stopLeftovers };
}

// quote, if given, is applied to each substituted value. onMissing, if given, is called
// for a variable with no value; otherwise ${env:NAME} becomes empty and ${NAME} is left alone.
// keepEnv leaves ${env:NAME} as it is, for showing a request without its secrets.
function expand(value, vars, { quote, onMissing, keepEnv } = {}) {
  if (Array.isArray(value)) return value.map((v) => expand(v, vars, { quote, onMissing, keepEnv }));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expand(v, vars, { quote, onMissing, keepEnv })]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, isEnv, key) => {
    if (isEnv && keepEnv) return match;
    const found = isEnv ? process.env[key] : (Object.hasOwn(vars, key) ? vars[key] : undefined);
    if (found === undefined) return onMissing ? onMissing(match) : (isEnv ? '' : match);
    return quote ? quote(found) : found;
  });
}

function expandTilde(p) {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function shellQuote(arg) {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function findExecutor() {
  if (process.env.BOXED_MXC_EXEC) return process.env.BOXED_MXC_EXEC;
  const binary = { darwin: 'mxc-exec-mac', linux: 'lxc-exec' }[process.platform];
  if (!binary) die(`unsupported platform ${process.platform}`);
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  let sdkRoot;
  try {
    const require = createRequire(import.meta.url);
    sdkRoot = path.dirname(require.resolve('@microsoft/mxc-sdk/package.json'));
  } catch {
    die('@microsoft/mxc-sdk is not installed next to boxed; run `npm install` or set BOXED_MXC_EXEC');
  }
  const candidate = path.join(sdkRoot, 'bin', arch ?? '', binary);
  if (!arch || !existsSync(candidate)) {
    die(`no ${binary} for ${process.platform}/${process.arch} in @microsoft/mxc-sdk; ` +
        'build MXC from source and set BOXED_MXC_EXEC to the binary');
  }
  return candidate;
}

// Holds the request file and, in tmp/, the program's private TMPDIR. It must not sit in
// a shared temp directory: those are denied to the program, and a deny covers everything
// beneath it.
function createRunDir() {
  const base = cacheDir();
  let dir;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    dir = mkdtempSync(path.join(realOrSelf(base), 'run-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'tmp'));
  } catch (error) {
    die(`cannot create a run directory under ${base}: ${error.message}`);
  }
  return dir;
}

function sharedTempDirs() {
  return [...new Set([os.tmpdir(), '/tmp', '/var/tmp'].filter(existsSync).map(realOrSelf))];
}

function validate(file, ok, message) {
  if (!ok) die(`${file}: ${message}`);
}

function validateRequest(file, request) {
  const { filesystem, process: proc } = request;
  validate(file, filesystem === undefined || isObject(filesystem), '"filesystem" must be an object');
  for (const key of PATH_KEYS) {
    validate(file, filesystem?.[key] === undefined || isStringArray(filesystem[key]),
      `"filesystem.${key}" must be an array of strings`);
  }
  validate(file, proc === undefined || isObject(proc), '"process" must be an object');
  validate(file, proc?.env === undefined || isStringArray(proc.env),
    '"process.env" must be an array of "KEY=VALUE" strings');
  for (const key of ['commandLine', 'cwd']) {
    validate(file, proc?.[key] === undefined || typeof proc[key] === 'string',
      `"process.${key}" must be a string`);
  }
}

function buildRequest(name, programArgs, flags, runDir) {
  const file = flags.config ? path.resolve(flags.config) : path.join(configDir(), `${name}.json`);
  if (!existsSync(file)) {
    die(flags.config ? `config file not found: ${file}` : `no config for "${name}" (expected ${file})`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    die(`${file}: ${error.message}`);
  }

  validate(file, isObject(config), 'a config must be a JSON object');

  const { boxed = {}, $schema, ...request } = config;
  validate(file, isObject(boxed), '"boxed" must be an object');
  const {
    command = name ?? path.basename(file, '.json'), passEnv = DEFAULT_PASS_ENV,
    privateTmp = true, proxy, darwin, linux, ...unknown
  } = boxed;
  if (Object.keys(unknown).length) die(`${file}: unknown "boxed" keys: ${Object.keys(unknown).join(', ')}`);
  validate(file, typeof command === 'string' && command !== '', '"boxed.command" must be a non-empty string');
  validate(file, isStringArray(passEnv), '"boxed.passEnv" must be an array of strings');
  validate(file, typeof privateTmp === 'boolean', '"boxed.privateTmp" must be true or false');
  for (const [key, value] of Object.entries({ darwin, linux })) {
    validate(file, value === undefined || isObject(value), `"boxed.${key}" must be an object`);
  }
  if (proxy !== undefined) {
    validate(file, isObject(proxy), '"boxed.proxy" must be an object');
    const {
      loopbackPorts = [], external = 'allow', allowHosts = [], denyHosts = [], ...unknownProxy
    } = proxy;
    validate(file, !Object.keys(unknownProxy).length,
      `unknown "boxed.proxy" keys: ${Object.keys(unknownProxy).join(', ')}`);
    validate(file, Array.isArray(loopbackPorts) &&
      loopbackPorts.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
      '"boxed.proxy.loopbackPorts" must be an array of port numbers');
    validate(file, external === 'allow' || external === 'deny',
      '"boxed.proxy.external" must be "allow" or "deny"');
    for (const [key, hosts] of Object.entries({ allowHosts, denyHosts })) {
      validate(file, isStringArray(hosts), `"boxed.proxy.${key}" must be an array of strings`);
      for (const host of hosts) {
        try { parseHostRule(host); } catch (error) { die(`${file}: "boxed.proxy.${key}": ${error.message}`); }
      }
    }
  }

  const platformOverride = { darwin, linux }[process.platform];
  const raw = platformOverride ? merge(request, platformOverride) : request;
  validateRequest(file, raw);

  const cwd = realOrSelf(process.cwd());
  const tmp = privateTmp ? path.join(runDir, 'tmp') : realOrSelf(os.tmpdir());
  const vars = { CWD: cwd, HOME: os.homedir(), TMPDIR: tmp };
  const merged = expand(raw, vars);
  // A variable that silently expands to nothing would turn a grant or a deny into a
  // different path, so in "filesystem" an unset one is an error.
  if (raw.filesystem) {
    merged.filesystem = expand(raw.filesystem, vars, {
      onMissing: (variable) => die(`${file}: ${variable} in "filesystem" has no value`),
    });
  }
  // commandLine goes to a shell, so substituted values are quoted.
  if (raw.process?.commandLine) {
    merged.process.commandLine = expand(raw.process.commandLine, vars, { quote: shellQuote });
  }

  merged.version ??= '1.0.0';
  merged.containment ??= 'process';
  merged.process ??= {};
  merged.process.cwd ??= cwd;

  let activeProxy = proxy;
  const { egress, ingress } = merged.network ?? {};
  let { allowPorts, allowHosts } = flags;
  if (allowPorts.length && !proxy && ingress?.hostLoopback === 'allow') {
    console.error('boxed: warning: this config already opens every local port ' +
                  '(network.ingress.hostLoopback); ignoring --allow-port');
    allowPorts = [];
  }
  const internetOpen = proxy
    ? (proxy.external ?? 'allow') === 'allow' && !proxy.allowHosts?.length
    : egress?.default === 'allow';
  if (allowHosts.length && internetOpen) {
    console.error('boxed: warning: this config already lets the program reach any host; ignoring --allow-host');
    allowHosts = [];
  }
  const used = Object.entries({
    '--allow-port': allowPorts, '--allow-host': allowHosts, '--deny-host': flags.denyHosts,
  }).filter(([, values]) => values.length).map(([option]) => option).join(', ');
  if (used) {
    if (!proxy) {
      // The config has no proxy, so one is started for this run. It keeps what the
      // config says about the outside world: open stays open, closed stays closed.
      validate(file, !egress?.allow && !egress?.deny,
        `${used} starts the boxed proxy, which cannot be combined with network.egress rules`);
      validate(file, merged.runtimeConfig?.networkProxy === undefined,
        `${used} starts the boxed proxy, which cannot be combined with runtimeConfig.networkProxy`);
      validate(file, ingress?.hostLoopback !== 'allow',
        `${used} starts the boxed proxy, which cannot be combined with network.ingress.hostLoopback "allow"`);
      const external = egress?.default === 'allow' ? 'allow' : 'deny';
      activeProxy = { external };
      if (egress) egress.default = 'deny';
      console.error(`boxed: ${used}: network traffic goes through the boxed proxy for this run ` +
                    `(external: ${external})`);
    }
    const union = (key, extra) => [...new Set([...(activeProxy[key] ?? []), ...extra])];
    activeProxy = {
      ...activeProxy,
      loopbackPorts: union('loopbackPorts', allowPorts),
      allowHosts: union('allowHosts', allowHosts),
      denyHosts: union('denyHosts', flags.denyHosts),
    };
  }

  if (activeProxy) {
    // The proxy only filters what is sent through it, so any direct route the config
    // opens would go around it.
    validate(file, merged.runtimeConfig?.networkProxy === undefined,
      '"boxed.proxy" sets runtimeConfig.networkProxy itself; remove it from the config');
    validate(file, egress?.default !== 'allow' && !egress?.allow && !egress?.deny,
      '"boxed.proxy" needs network.egress to be {"default": "deny"} or absent');
    validate(file, ingress?.hostLoopback !== 'allow',
      '"boxed.proxy" cannot be combined with network.ingress.hostLoopback "allow"');
    merged.network = merge(merged.network ?? {}, { egress: { default: 'deny' } });
  }

  const argv = programArgs.map(shellQuote).join(' ');
  const withArgs = (line) => (line
    ? [line, argv].filter(Boolean).join(' ')
    : ['exec', shellQuote(command), argv].filter(Boolean).join(' '));
  merged.process.commandLine = withArgs(merged.process.commandLine);
  // What --show-config prints of the request as written: ${env:NAME} stays as it is,
  // since its value can be a secret.
  const shown = expand(raw, vars, { keepEnv: true });
  const shownCommandLine = withArgs(raw.process?.commandLine &&
    expand(raw.process.commandLine, vars, { quote: shellQuote, keepEnv: true }));

  // MXC never inherits the host environment, so pass through an explicit allowlist.
  const env = new Map();
  for (const key of passEnv) {
    if (process.env[key] !== undefined) env.set(key, process.env[key]);
  }
  const hostEnv = [...env.keys()].filter((key) => !(privateTmp && key === 'TMPDIR'));
  if (privateTmp) env.set('TMPDIR', tmp);
  const configEnv = new Set();
  for (const entry of merged.process.env ?? []) {
    const eq = entry.indexOf('=');
    if (eq < 1) die(`${file}: process.env entries must be "KEY=VALUE", got ${JSON.stringify(entry)}`);
    env.set(entry.slice(0, eq), entry.slice(eq + 1));
    configEnv.add(entry.slice(0, eq));
  }
  merged.process.env = [...env].map(([key, value]) => `${key}=${value}`);

  // A relative or unexpanded entry would be passed on as written and match nothing,
  // which for deniedPaths means no protection and no error.
  const fs = (merged.filesystem ??= {});
  for (const key of PATH_KEYS) {
    fs[key] = [...new Set((fs[key] ?? []).map((entry) => {
      const p = expandTilde(entry);
      if (!path.isAbsolute(p) || p.includes('${')) {
        die(`${file}: filesystem.${key} entry ${JSON.stringify(entry)} is not an absolute path ` +
            '(only a leading "~/" and ${CWD}, ${HOME}, ${TMPDIR}, ${env:NAME} are expanded)');
      }
      return path.resolve(p);
    }))];
  }

  // The sandbox matches a deny against resolved paths, so one given as a symlink has to
  // name what the link leads to as well.
  fs.deniedPaths = [...new Set(fs.deniedPaths.flatMap((p) => [p, realOrSelf(p)]))];

  // Read-only grants for paths that do not exist are dropped so one config can list
  // locations for several machines. A missing read-write path is usually something the
  // program creates on first run: Seatbelt can grant it anyway, but Bubblewrap fails
  // outright on a missing bind source, so on Linux it is dropped with a warning.
  // A missing read-only path inside a read-write one is kept on macOS for the same
  // reason: it stops the program creating something there.
  const seatbelt = process.platform === 'darwin';
  for (const key of ['readwritePaths', 'readonlyPaths']) {
    fs[key] = fs[key].filter((p) => {
      if (existsSync(p)) return true;
      if (key === 'readwritePaths' && seatbelt) return true;
      if (key === 'readonlyPaths' && seatbelt && fs.readwritePaths.some((rw) => isWithin(p, rw))) return true;
      if (key === 'readwritePaths') console.error(`boxed: warning: dropping missing ${key} entry ${p}`);
      else if (flags.debug) console.error(`boxed: skipping missing ${key} entry ${p}`);
      return false;
    });
  }

  const home = realOrSelf(os.homedir());
  const self = realOrSelf(fileURLToPath(import.meta.url));

  // The sandbox checks the path a symlink resolves to, so a link inside a granted
  // directory leads nowhere unless its target is granted too. Targets are added before
  // the checks below so a writable one goes through them as well.
  const watched = [];
  const locked = [];
  const denied = [
    ...fs.deniedPaths,
    ...(privateTmp ? sharedTempDirs().filter((shared) => !isWithin(cwd, shared)) : []),
  ];
  for (const arg of flags.allowSymlinks) {
    const [, link, mode = 'ro'] = arg.match(/^(.*?)(?::(ro|rw))?$/s);
    const from = path.resolve(cwd, link);
    const snapshot = pathsBelow(cwd, from).map((p) => [p, linkState(p)]);
    const entry = { link, from, target: null, snapshot };
    watched.push(entry);
    let target;
    try {
      target = realpathSync(from);
    } catch {
      console.error(`boxed: warning: --allow-symlink ${link} does not resolve to anything; skipping it`);
      continue;
    }
    if (target === from) {
      console.error(`boxed: warning: --allow-symlink ${link} is not a symlink; skipping it`);
      continue;
    }
    entry.target = target;
    if (isWithin(home, target)) {
      die(`--allow-symlink ${link} points at ${target}, which covers your whole home directory`);
    }
    const within = denied.find((d) => isWithin(target, d));
    if (within) {
      console.error(`boxed: warning: --allow-symlink ${link}: ${target} is inside ${within}, ` +
                    'which is denied; skipping it');
      continue;
    }
    const covers = (paths) => paths.some((p) => isWithin(target, realOrSelf(p)));
    const writable = covers(fs.readwritePaths);
    const readonly = covers(fs.readonlyPaths);
    // A target the config already grants is left alone: listing it read-only here would
    // take away write access it has through readwritePaths, and a read-only grant in
    // the config is not something a launch flag should widen.
    let note = 'already granted';
    if (mode === 'rw' && readonly) {
      note = 'read-only in the config, and stays that way';
    } else if (!writable && !readonly) {
      fs[mode === 'rw' ? 'readwritePaths' : 'readonlyPaths'].push(target);
      note = mode === 'rw' ? 'read-write' : 'read-only';
    }
    // Printed on every run, not only with --debug: the link may not lead where it did
    // the last time this command line was used.
    console.error(`boxed: --allow-symlink ${link} -> ${target} (${note})`);
    // Seatbelt matches these rules against the link's own path, which stops the program
    // replacing the link. Bubblewrap would bind the target over the link instead.
    if (seatbelt) locked.push(...snapshot.filter(([, state]) => state.startsWith('link:')).map(([p]) => p));
  }
  for (const p of locked) {
    if (!fs.readonlyPaths.includes(p)) fs.readonlyPaths.push(p);
  }

  for (const p of fs.readwritePaths) {
    const real = realOrSelf(p);
    const what = real === cwd ? `the current directory (${p})` : p;
    if (isWithin(home, real)) {
      die(`${file}: readwritePaths would make ${what} writable, which covers your whole home directory`);
    }
    for (const [target, label] of [[realOrSelf(file), 'this config'], [self, 'boxed itself']]) {
      if (isWithin(target, real)) {
        console.error(`boxed: warning: ${what} is writable and contains ${label} (${target}); ` +
                      'the program can change how later runs are sandboxed');
      }
    }
  }

  if (privateTmp) {
    // A program that can reach the shared temp directories can connect to other programs'
    // sockets there (tmux, editors, ssh-askpass), so it gets its own and those are denied.
    fs.readwritePaths.push(tmp);
    for (const shared of sharedTempDirs()) {
      if (isWithin(tmp, shared)) {
        die(`the run directory ${runDir} is inside the shared temp directory ${shared}; ` +
            'point XDG_CACHE_HOME somewhere else');
      }
      if (isWithin(cwd, shared)) {
        console.error(`boxed: warning: the current directory is inside ${shared}, so that ` +
                      'shared temp directory is not denied');
      } else if (!fs.deniedPaths.includes(shared)) {
        fs.deniedPaths.push(shared);
      }
    }
  }

  // Where to look afterwards for symlinks the program left behind: what the config made
  // writable, and not the temp directory, which is deleted anyway.
  const scan = {
    roots: fs.readwritePaths.filter((p) => p !== tmp).map(realOrSelf),
    granted: [...fs.readwritePaths, ...fs.readonlyPaths].map(realOrSelf),
    skip: new Set(watched.flatMap(({ snapshot }) => snapshot.map(([p]) => p))),
  };

  const summary = { file, privateTmp, tmp, hostEnv, configEnv, shown, shownCommandLine };
  return { request: merged, proxy: activeProxy, watched, scan, summary };
}

// The --show-config view: what the program may touch, in words, with the request's
// remaining MXC settings listed as they are. Variable values are left out because they
// can hold secrets: process.env is listed by name, and elsewhere ${env:NAME} is printed
// unexpanded. Paths are the exception, since what they lead to is the point.
function showConfig(request, proxy, { file, privateTmp, tmp, hostEnv, configEnv, shown, shownCommandLine }) {
  const home = os.homedir();
  const tilde = (p) => (isWithin(p, home) && p !== home ? `~/${path.relative(home, p)}` : p);
  const lines = [];
  const row = (label, values) => {
    const list = [values].flat();
    if (!list.length) list.push('(none)');
    list.forEach((value, i) => lines.push(`  ${(i ? '' : label).padEnd(13)}${value}`));
  };

  const { filesystem: fs, network = {}, process: proc } = request;
  const {
    version, containment = 'process', filesystem: shownFs = {}, network: shownNet = {},
    process: shownProc = {}, runtimeConfig, ...other
  } = shown;
  lines.push('program');
  row('config', tilde(file));
  row('command', shownCommandLine);
  row('directory', tilde(proc.cwd));

  lines.push('', 'filesystem');
  row('read-write', fs.readwritePaths.map((p) => {
    if (privateTmp && p === tmp) {
      return `${path.join(tilde(path.dirname(path.dirname(p))), 'run-*', 'tmp')}  (private temp directory, new for each run)`;
    }
    return existsSync(p) ? tilde(p) : `${tilde(p)}  (does not exist yet)`;
  }));
  row('read-only', fs.readonlyPaths.map((p) => (existsSync(p) ? tilde(p) : `${tilde(p)}  (does not exist, and cannot be created)`)));
  row('denied', fs.deniedPaths.map(tilde));
  const { readwritePaths, readonlyPaths, deniedPaths, ...otherFs } = shownFs;
  if (Object.keys(otherFs).length) row('other', JSON.stringify(otherFs));

  lines.push('', 'network');
  const { egress = {}, ingress = {} } = network;
  const { egress: shownEgress = {}, ingress: shownIngress = {}, ...otherNet } = shownNet;
  if (proxy) {
    const external = proxy.external ?? 'allow';
    row('route', 'only through the boxed proxy, for programs that honour HTTP_PROXY');
    if (proxy.allowHosts?.length) row('internet', proxy.allowHosts.map((h, i) => (i ? h : `only ${h}`)));
    else row('internet', external === 'allow' ? 'any host' : 'none');
    if (proxy.denyHosts?.length) row('blocked', proxy.denyHosts);
    row('local', proxy.loopbackPorts?.length ? `ports ${proxy.loopbackPorts.join(', ')}` : 'none');
  } else {
    const { default: egressDefault = 'deny' } = egress;
    const { default: _, ...egressRules } = shownEgress;
    row('internet', egressDefault === 'allow' ? 'any host' : 'none');
    if (Object.keys(egressRules).length) row('rules', JSON.stringify(egressRules));
    row('local', ingress.hostLoopback === 'allow' ? 'every port' : 'none');
  }
  const { hostLoopback, ...otherIngress } = shownIngress;
  if (Object.keys(otherIngress).length) row('ingress', JSON.stringify(otherIngress));
  if (Object.keys(otherNet).length) row('other', JSON.stringify(otherNet));

  lines.push('', 'environment (names only)');
  // A config entry replaces the host's value, so each name is listed where it comes from.
  row('from host', hostEnv.filter((key) => !configEnv.has(key)).join(' ') || []);
  row('from config', [...configEnv].join(' ') || []);
  row('from boxed', ['BOXED_RUN_ID (identifies this run)',
    ...(proxy ? ['HTTP_PROXY HTTPS_PROXY ALL_PROXY (the boxed proxy, set by MXC)'] : [])]);
  if (!configEnv.has('TMPDIR')) {
    row('TMPDIR', privateTmp ? 'the private temp directory' : `${tilde(tmp)} (shared with the host)`);
  }

  const { commandLine, cwd, env, ...otherProc } = shownProc;
  const rest = Object.entries({
    containment, ...other, ...(Object.keys(otherProc).length ? { process: otherProc } : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
  });
  lines.push('', 'other MXC settings');
  for (const [key, value] of rest) row(key, typeof value === 'string' ? value : JSON.stringify(value));
  console.log(lines.join('\n'));
}

async function main() {
  const { flags, name, programArgs } = parseArgs(process.argv.slice(2));
  try {
    process.cwd();
  } catch {
    // The shell is still sitting in a directory that has since been deleted, or deleted
    // and created again under the same name.
    die('the current directory no longer exists; cd into it again (cd "$PWD") and retry');
  }
  const runDir = createRunDir();
  const { request, proxy, watched, scan, summary } = buildRequest(name, programArgs, flags, runDir);
  if (flags.showConfig) {
    showConfig(request, proxy, summary);
    return;
  }

  let running;
  if (proxy) {
    try {
      running = await startProxy({
        ...proxy,
        log: flags.debug ? (message) => console.error(`boxed: ${message}`) : undefined,
      });
    } catch (error) {
      die(`cannot start the proxy: ${error.message}`);
    }
    request.runtimeConfig = { ...request.runtimeConfig, networkProxy: running.url };
  }
  // Lets boxed recognise what the program leaves running; see watchProcesses.
  const marker = `BOXED_RUN_ID=${randomBytes(8).toString('hex')}`;
  request.process.env.push(marker);
  const json = JSON.stringify(request, null, 2);

  if (flags.printConfig) {
    console.log(json);
    running?.close();
    return;
  }

  const executor = findExecutor();
  const args = [];
  if (flags.debug) {
    console.error(`boxed: executor ${executor}`);
    console.error(`boxed: request ${json}`);
    args.push('--debug');
  }
  if (flags.dryRun) args.push('--dry-run');
  // The request can carry secrets in process.env, so it goes in a private file rather
  // than on the executor's command line, where any local user could read it.
  const requestFile = path.join(runDir, 'request.json');
  writeFileSync(requestFile, json, { mode: 0o600 });
  args.push('--config', requestFile);

  // The executor inherits our stdio, so the program talks to the terminal directly.
  // To the second, because that is as fine as ps reports a start time.
  const started = Math.floor(Date.now() / 1000) * 1000;
  const child = spawn(executor, args, { stdio: 'inherit' });
  const processes = !flags.dryRun && child.pid ? watchProcesses(child.pid, marker, started) : null;
  for (const signal of ['SIGINT', 'SIGQUIT']) process.on(signal, () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => die(`failed to start ${executor}: ${error.message}`, 126));
  child.on('exit', async (code, signal) => {
    if (!flags.dryRun) {
      // First, so that nothing is left to undo what the checks below put right.
      const stopped = await processes?.stopLeftovers() ?? [];
      if (stopped.length) {
        console.error(`boxed: stopped ${stopped.length} process${stopped.length === 1 ? '' : 'es'} ` +
                      `the program left running: ${stopped.slice(0, 10).join(', ')}` +
                      (stopped.length > 10 ? ` and ${stopped.length - 10} more` : ''));
      }
      const planted = newOutsideSymlinks(scan.roots, scan.granted, started, scan.skip);
      restoreSymlinks(watched);
      if (planted.length) {
        console.error('boxed: warning: the program left symlinks that lead outside the sandbox:');
        for (const line of planted.slice(0, 10)) console.error(`boxed:   ${line}`);
        if (planted.length > 10) console.error(`boxed:   and ${planted.length - 10} more`);
      }
    }
    process.exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 1);
  });
}

main();
