# boxed

Run a program inside an [MXC](https://github.com/microsoft/mxc) sandbox using a stored per-program config.

This was an experiment to try out MXC after it made the Hacker News front page recently.  I don't know if it is the best sandbox, but it is working well for what I needed it to do right now.

I created `boxed` so I can feel more confident in using local-only models on data that must not leave my machine, and more confident in letting frontier run when they can simply bypass their own built-in sandboxes.  It isn't foolproof, but it adds an additional layer of protection between the agent and the filesystem / network.  The entire project was created and audited by LLMs, so use at your own risk (or just build your own).

## Usage

```
boxed [options] <name> [program args...]
boxed [options] --config FILE [program args...]
```

The first form loads `<name>.json` from the config directory: `$BOXED_CONFIG_DIR`, else `$XDG_CONFIG_HOME/boxed`, else `~/.config/boxed`. The second loads `FILE` directly and takes no `<name>`.

| Option                      | Effect                                                                                                                                            |
|-----------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `--config FILE`             | Load `FILE` instead of a named config.                                                                                                            |
| `--allow-symlink PATH[:rw]` | Grant read access to the target of the symlink `PATH` for this run, or read-write access with `:rw` (see [Symlinks](#symlinks)). May be repeated. |
| `--allow-port PORT`         | Let the program reach `PORT` on this machine for this run (see [Proxy](#proxy)). May be repeated.                                                 |
| `--allow-host HOST`         | Let the program reach `HOST` for this run when the proxy otherwise keeps it off the internet (see [Host rules](#host-rules)). May be repeated.     |
| `--deny-host HOST`          | Have the proxy refuse `HOST` for this run (see [Host rules](#host-rules)). May be repeated.                                                       |
| `--print-config`            | Print the resolved MXC request JSON and exit.                                                                                                     |
| `--show-config`             | Summarise what the program would be allowed to read, write and reach, and exit (see [Checking a config](#checking-a-config)).                     |
| `--dry-run`                 | Have MXC validate the request without running the program.                                                                                        |
| `--debug`                   | Print the resolved request and enable MXC diagnostics.                                                                                            |
| `-h`, `--help`              | Print the usage summary and exit.                                                                                                                 |

Options go before `<name>`. With `--config`, put program args that start with `-` after `--`:

```
boxed claude -p 'hello'
boxed --config examples/claude.json -- -p 'hello'
```

Set `BOXED_MXC_EXEC` to use an MXC executor binary other than the one shipped in `@microsoft/mxc-sdk`.

## Installation

Requires Node 24+ on macOS or Linux.  **_Note_**: _Linux is untested at the moment.  If you try it out, let me know how it works (or doesn't)._

Clone the repository, or download and unpack it, then install from inside it:

```
git clone <repo-url> boxed
cd boxed
npm install
npm link
```

`npm install` fetches the dependencies. `npm link` puts the `boxed` command on your `PATH`; without it, run `bin/boxed.js` directly.

### Checking a config

`--show-config` prints what a run would allow, after platform overrides, variable expansion and any `--allow-*` or `--deny-host` flags have been applied. It exits without starting the program:

```
$ boxed --show-config --allow-port 8080 opencode-locked
program
  config       ~/.config/boxed/opencode-locked.json
  command      exec opencode
  directory    ~/src/project

filesystem
  read-write   ~/src/project
               ~/.config/opencode
               ~/.cache/boxed/run-*/tmp  (private temp directory, new for each run)
  read-only    ~/.gitconfig
               ~/.config/opencode/AGENTS.md  (does not exist, and cannot be created)
  denied       ~/.ssh
               /private/tmp

network
  route        only through the boxed proxy, for programs that honour HTTP_PROXY
  internet     none
  local        ports 11434, 8080

environment (names only)
  from host    PATH HOME USER LOGNAME SHELL TERM LANG
  from config  OPENCODE_DISABLE_AUTOUPDATE
  TMPDIR       the private temp directory
...
```

Environment variables are listed by name only, since their values can be secrets. For the same reason `${env:NAME}` is shown as written in the command and in other settings; filesystem paths and the directory are shown expanded. MXC settings that `boxed` does not interpret, such as `seatbelt`, are listed as they are at the end. `--print-config` shows the full request as JSON instead.

## Config format

A config is an [MXC request](https://github.com/microsoft/mxc/blob/main/docs/schema.md) plus an optional `boxed` key, which `boxed` consumes and strips before handing the request to MXC. See [`examples/claude.json`](examples/claude.json).

```json
{
  "filesystem": {
    "readwritePaths": ["${CWD}"],
    "readonlyPaths": ["~/.gitconfig"],
    "deniedPaths": ["~/.ssh"]
  },
  "network": { "egress": { "default": "allow" } },
  "boxed": {
    "command": "claude",
    "darwin": { "filesystem": { "readonlyPaths": ["/opt/homebrew"] } }
  }
}
```

### The `boxed` key

| Key               | Meaning                                                                                                                       |
|-------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `command`         | Program to run. Defaults to `<name>`, or to the basename of the `--config` file without `.json`.                              |
| `passEnv`         | Host environment variables to pass through. Replaces the default, a short list: `PATH`, `HOME`, `TERM`, `LANG` and similar.   |
| `privateTmp`      | Give the program its own temp directory and deny the shared ones (see [Temp directory](#temp-directory)). Defaults to `true`. |
| `proxy`           | Route the program's network traffic through a filtering proxy that `boxed` runs, optionally limited by host (see [Proxy](#proxy)). Off unless set. |
| `darwin`, `linux` | Request fragment merged in on that platform. Objects merge key by key, arrays concatenate, other values replace.              |

Any other key under `boxed` is an error.

### What `boxed` fills in

- `version` defaults to `1.0.0`, `containment` to `process`, and `process.cwd` to the current directory.
- `process.commandLine` defaults to `exec <command> <program args>`. If you set it, the program args are appended to it.
- `process.env` entries (`"KEY=VALUE"`) are applied on top of the `passEnv` variables. Nothing else from the host environment reaches the program.

### Temp directory

Each run gets a private directory under `$XDG_CACHE_HOME/boxed` (else `~/.cache/boxed`), removed when the program exits. Its `tmp` subdirectory is granted read-write, `TMPDIR` is set to it, and `${TMPDIR}` in the config expands to it.

The shared temp directories (`/tmp`, `/var/tmp` and the host's own `$TMPDIR`) are added to `deniedPaths`. Other programs keep sockets there, such as tmux, editors and ssh-askpass, and a sandboxed program that can connect to one can run commands outside the sandbox. A deny wins over a grant, so listing `/tmp` in `readwritePaths` has no effect. If the current directory is itself inside a shared temp directory, that one is left open and `boxed` warns.

A program that hardcodes `/tmp` needs to be told where to write instead. For Claude Code that is `CLAUDE_CODE_TMPDIR`, which the example config sets.

`"privateTmp": false` turns all of this off: `${TMPDIR}` is then the host temp directory and nothing is denied for you.

### Proxy

MXC's `network.ingress.hostLoopback` opens every port on localhost or none, and on macOS it also has to open inbound connections. `boxed.proxy` is for a program that needs one local service, such as a model server (e.g. Ollama), and the internet:

```json
"network": { "egress": { "default": "deny" } },
"boxed": { "proxy": { "loopbackPorts": [11434] } }
```

`boxed` starts an HTTP proxy on a free port on `127.0.0.1` before the program and passes its address to MXC as `runtimeConfig.networkProxy`. MXC then blocks every direct connection except to the proxy and sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` for the program. The proxy forwards anything off this machine. A destination on this machine, meaning loopback or any of its own interface addresses, is forwarded only on the ports in `loopbackPorts`, and refused with a 403 otherwise. `--debug` reports each refusal.

`"external": "deny"` in `boxed.proxy` makes the proxy refuse everything off this machine as well, leaving only the listed local ports:

```json
"boxed": { "proxy": { "loopbackPorts": [11434], "external": "deny" } }
```

A hostname is then refused without being looked up, since the lookup would itself leave the machine. Only IP addresses and `localhost` names are accepted. The default is `"allow"`.

`--allow-port PORT` adds a port to `loopbackPorts` for one run:

```
boxed --allow-port 8080 --allow-port 5432 opencode
```

If the config has no `boxed.proxy`, the flag starts the proxy for that run and says so. `external` is then `"allow"` if the config's `network.egress.default` is `"allow"`, otherwise `"deny"`. If the config sets `hostLoopback: "allow"`, every local port is already open and the flag is ignored with a warning.

- The proxy runs inside the `boxed` process, so it stops when `boxed` does, however that happens.
- With `boxed.proxy`, `network.egress.default` must be `deny` or absent (`boxed` sets it). With `boxed.proxy` or any of `--allow-port`, `--allow-host` and `--deny-host`, the config cannot also set `egress` rules, `hostLoopback: "allow"` or `runtimeConfig.networkProxy`.
- Only traffic that honours the proxy variables gets through. A program that opens sockets directly, such as `ssh`, has no network.
- The proxy does not chain to a proxy the host itself needs.

See [`examples/opencode.json`](examples/opencode.json) and [`examples/opencode-locked.json`](examples/opencode-locked.json).

#### Host rules

`allowHosts` and `denyHosts` in `boxed.proxy` filter by destination name:

```json
"boxed": { "proxy": {
  "allowHosts": ["api.anthropic.com", "*.githubusercontent.com", "registry.npmjs.org:443"],
  "denyHosts": ["telemetry.example.com"]
} }
```

- An entry is a host name or IP address, optionally followed by `:PORT`. An IPv6 address with a port goes in brackets, as in `[::1]:8080`. `*.example.com` matches every name under `example.com`, but not `example.com` itself. Case, a trailing dot and the spelling of IP addresses do not matter.
- A host in `denyHosts` is always refused, even when it is also in `allowHosts`.
- Once `allowHosts` has an entry, nothing else off this machine is reached, whatever `external` says. A host in it is reached even with `"external": "deny"`, so the two together mean "only these".
- Rules match the name the program asked for, before it is looked up. A raw IP address therefore only matches an IP address entry. Under `allowHosts` it is refused, but under `denyHosts` alone it gets through. A blocklist is easy to get around (another name, an IP address, a redirect), so use `allowHosts` when it matters.
- Only the host and port are checked. An HTTPS request reveals nothing more to the proxy, so a rule cannot name a path. A server that hosts many sites, such as a CDN, can also be asked for a different site once the connection is open.
- Local destinations still need their port in `loopbackPorts`. Host rules do not open them.

`--allow-host HOST` and `--deny-host HOST` add to these lists for one run, and accept the same forms:

```
boxed --allow-host api.openai.com opencode-locked
boxed --deny-host '*.sentry.io' claude
```

- `--allow-host` only opens things up. If the program can already reach any host (`external` is `"allow"` and there is no `allowHosts`), the flag is ignored with a warning, rather than closing everything else.
- Without `boxed.proxy`, either flag starts the proxy for that run, as `--allow-port` does, with `external` taken from `network.egress.default`.

### Paths and variables

- `${CWD}`, `${HOME}` and `${TMPDIR}` expand in any string of the request, and `${env:NAME}` expands to that host environment variable (empty if unset). They are not expanded in `boxed.command` or `boxed.passEnv`.
- In `process.commandLine` each expanded value is shell-quoted, so write `cd ${CWD}`, not `cd "${CWD}"`.
- A leading `~/` expands in `filesystem` path lists.
- A `deniedPaths` entry that is a symlink is denied at the path it leads to as well.
- Every `filesystem` path must be absolute once expanded. A relative path, an unknown `${NAME}` or an unset `${env:NAME}` is an error, so a mistyped `deniedPaths` entry cannot silently protect nothing.
- `readonlyPaths` entries that do not exist are dropped, so one config can list locations for several machines. `--debug` reports each one skipped.
- A missing `readonlyPaths` entry that sits inside a `readwritePaths` entry is kept on macOS, so the program cannot create it. On Linux it is dropped like the rest.
- `readwritePaths` entries that do not exist are kept on macOS, so the program can create them on first run. On Linux they are dropped with a warning, because Bubblewrap cannot bind a path that is not there.
- `boxed` refuses to run if a `readwritePaths` entry covers your home directory, which is what `${CWD}` does when you start it from `~`. It warns if one covers the config file or `boxed` itself.

### Symlinks

The sandbox checks the path a symlink resolves to, not the link. A symlink inside a granted directory therefore only works if its target is granted as well. Either list the target in the config, or name the link at launch:

```
boxed --allow-symlink data --allow-symlink out/:rw omp
```

- `PATH` is relative to the current directory. It can be the link itself or a path that goes through one, such as `data/2024/report.csv`, which grants only that file.
- The target is granted read-only. Add `:rw` to make it writable, as in `out/:rw`. `:ro` spells out the default, which is the way to name a link that itself ends in `:rw`.
- A target already covered by the config keeps the access it has there. In particular `:rw` does not make a `readonlyPaths` entry writable.
- A writable target gets the same checks as `readwritePaths`: `boxed` warns if it contains the config file or `boxed` itself.
- A path that does not exist or is not a symlink is skipped with a warning, so the same command line works in projects that lack the link. So is a target inside a `deniedPaths` entry or a shared temp directory.
- `boxed` refuses a link whose target covers your home directory. `deniedPaths` still win over the grant.
- Symlinks inside the target that lead somewhere else are not followed; name those too.

The link sits in a directory the program can write to, so the program could point it somewhere else and wait for your next run to grant that. `boxed` guards against this in three ways:

1. Every run prints where each link leads and what was granted, so a change is visible before the program starts.
2. On macOS the link itself is read-only inside the sandbox and cannot be removed, renamed or replaced. A link in a subdirectory is only protected this far: the directories above it can still be moved.
3. When the program exits, `boxed` compares the link and each directory on the way to it with how they were at launch. A link that was changed or removed is put back, and a link that appeared where there was none is removed, each with a warning. A link replaced by a file or directory, or a path that leads somewhere new because of a link further along the chain, gets a warning and is left to you.

Linux has no equivalent of the second. A process that survives the clean-up described under [Leftover processes](#leftover-processes) is still sandboxed but can change a link after the check at exit, so read the line printed at launch.

After every run, with or without `--allow-symlink`, `boxed` also walks the writable paths and lists symlinks created during the run that lead somewhere the program had no access to. The sandbox does not follow these, but a tool you run on the directory afterwards might. They are reported, not removed. `--dry-run` skips these checks.

### Leftover processes

When the program exits, `boxed` stops whatever it left running, such as a dev server or a `nohup` job, and says what it stopped. Each gets `SIGTERM`, then `SIGKILL` if it is still there two seconds later. This runs before the symlink checks, so nothing is left to undo them.

Nothing ties an orphaned process to the run that started it, so `boxed` goes on three signs:

- it descends from the program, as seen by checking the process list twice a second during the run;
- it carries `BOXED_RUN_ID`, a variable `boxed` adds to the program's environment;
- it is an orphan in `boxed`'s own process group that started during the run. This one applies only when `boxed` leads its group, as it does when started from an interactive shell.

A process that sets out to avoid all three can: one that clears its environment, detaches at once and leaves the process group. Treat this as a clean-up, not a guarantee. `--dry-run` skips it.

### Notes on the Claude example

- `seatbelt.keychainAccess` is on because Claude Code keeps its login in the macOS Keychain. It makes `~/Library/Keychains` and the per-user cache directories under `/private/var/folders` writable. To do without it, remove the key and pass an API key instead by adding `"ANTHROPIC_API_KEY=${env:ANTHROPIC_API_KEY}"` to `process.env`.
- `~/.claude` has to be writable, and anything Claude loads from there also runs when you start it outside the sandbox. The example makes `settings.json`, `settings.local.json`, `CLAUDE.md`, `hooks`, `commands`, `agents` and `skills` read-only, so changing those from inside a sandboxed session fails. `~/.claude.json` and `~/.claude/plugins` stay writable.
