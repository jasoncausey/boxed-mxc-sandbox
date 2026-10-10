#!/usr/bin/env node
// boxed — run a program inside an MXC sandbox using a stored per-program config.
//
//   boxed [--debug] [--dry-run] [--print-config] <name> [program args...]
//   boxed [--debug] [--dry-run] [--print-config] --config FILE [program args...]
//
// Configs live in $BOXED_CONFIG_DIR, else $XDG_CONFIG_HOME/boxed, else ~/.config/boxed,
// one file per program: <name>.json. Each file is an MXC request JSON
// (https://github.com/microsoft/mxc/blob/main/docs/schema.md) plus an optional
// "boxed" key that this wrapper consumes and strips before handing off to MXC.
// --config FILE loads that file instead of looking <name> up in the config dir;
// <name> is then omitted and the program defaults to FILE's basename.
//
// Each run gets a private directory under $XDG_CACHE_HOME/boxed (else ~/.cache/boxed)
// that holds the request handed to MXC and the program's TMPDIR; it is removed on exit.

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const flags = { debug: false, dryRun: false, printConfig: false, config: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--debug') flags.debug = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--print-config') flags.printConfig = true;
    else if (arg === '--config') {
      if (++i >= argv.length) die('--config requires a file path');
      flags.config = argv[i];
    }
    else if (arg.startsWith('--config=')) flags.config = arg.slice('--config='.length);
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
  if (flags.config) return { flags, name: null, programArgs: argv.slice(i) };
  if (i >= argv.length) usage(2);
  return { flags, name: argv[i], programArgs: argv.slice(i + 1) };
}

function usage(code) {
  const text = [
    'Usage: boxed [--debug] [--dry-run] [--print-config] <name> [program args...]',
    '       boxed [--debug] [--dry-run] [--print-config] --config FILE [program args...]',
    '',
    `  <name>          loads ${path.join(configDir(), '<name>.json')}`,
    '  --debug         print the resolved request and enable MXC diagnostics (generated profile, etc.)',
    '  --dry-run       have MXC validate the request without running the program',
    '  --print-config  print the resolved MXC request JSON and exit',
    '  --config FILE   load FILE instead of a named config; the program to run defaults to',
    '                  FILE\'s basename, and program args starting with "-" go after "--"',
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

// quote, if given, is applied to each substituted value. onMissing, if given, is called
// for a variable with no value; otherwise ${env:NAME} becomes empty and ${NAME} is left alone.
function expand(value, vars, { quote, onMissing } = {}) {
  if (Array.isArray(value)) return value.map((v) => expand(v, vars, { quote, onMissing }));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expand(v, vars, { quote, onMissing })]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, isEnv, key) => {
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
    privateTmp = true, darwin, linux, ...unknown
  } = boxed;
  if (Object.keys(unknown).length) die(`${file}: unknown "boxed" keys: ${Object.keys(unknown).join(', ')}`);
  validate(file, typeof command === 'string' && command !== '', '"boxed.command" must be a non-empty string');
  validate(file, isStringArray(passEnv), '"boxed.passEnv" must be an array of strings');
  validate(file, typeof privateTmp === 'boolean', '"boxed.privateTmp" must be true or false');
  for (const [key, value] of Object.entries({ darwin, linux })) {
    validate(file, value === undefined || isObject(value), `"boxed.${key}" must be an object`);
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

  const argv = programArgs.map(shellQuote).join(' ');
  merged.process.commandLine = merged.process.commandLine
    ? [merged.process.commandLine, argv].filter(Boolean).join(' ')
    : ['exec', shellQuote(command), argv].filter(Boolean).join(' ');

  // MXC never inherits the host environment, so pass through an explicit allowlist.
  const env = new Map();
  for (const key of passEnv) {
    if (process.env[key] !== undefined) env.set(key, process.env[key]);
  }
  if (privateTmp) env.set('TMPDIR', tmp);
  for (const entry of merged.process.env ?? []) {
    const eq = entry.indexOf('=');
    if (eq < 1) die(`${file}: process.env entries must be "KEY=VALUE", got ${JSON.stringify(entry)}`);
    env.set(entry.slice(0, eq), entry.slice(eq + 1));
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

  return merged;
}

function main() {
  const { flags, name, programArgs } = parseArgs(process.argv.slice(2));
  const runDir = createRunDir();
  const request = buildRequest(name, programArgs, flags, runDir);
  const json = JSON.stringify(request, null, 2);

  if (flags.printConfig) {
    console.log(json);
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
  const child = spawn(executor, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGQUIT']) process.on(signal, () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => die(`failed to start ${executor}: ${error.message}`, 126));
  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 1);
  });
}

main();
