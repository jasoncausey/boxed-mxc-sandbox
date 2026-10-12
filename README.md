# boxed

Run a program inside an [MXC](https://github.com/microsoft/mxc) sandbox using a stored per-program config.

Requires Node 24+ on macOS or Linux.

```
npm install
```

## Usage

```
boxed [options] <name> [program args...]
boxed [options] --config FILE [program args...]
```

The first form loads `<name>.json` from the config directory. The second loads `FILE` directly and takes no `<name>`.

| Option | Effect |
| --- | --- |
| `--config FILE` | Load `FILE` instead of a named config. |
| `--print-config` | Print the resolved MXC request JSON and exit. |
| `--dry-run` | Have MXC validate the request without running the program. |
| `--debug` | Print the resolved request and enable MXC diagnostics. |

Options go before `<name>`. With `--config`, put program args that start with `-` after `--`:

```
boxed claude -p 'hello'
boxed --config examples/claude.json -- -p 'hello'
```

The config directory is `$BOXED_CONFIG_DIR`, else `$XDG_CONFIG_HOME/boxed`, else `~/.config/boxed`.

Set `BOXED_MXC_EXEC` to use an MXC executor binary other than the one shipped in `@microsoft/mxc-sdk`.

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

| Key | Meaning |
| --- | --- |
| `command` | Program to run. Defaults to `<name>`, or to the basename of the `--config` file without `.json`. |
| `passEnv` | Host environment variables to pass through. Defaults to a short list: `PATH`, `HOME`, `TERM`, `LANG` and similar. |
| `privateTmp` | Give the program its own temp directory and deny the shared ones (see below). Defaults to `true`. |
| `proxy` | Route the program's network traffic through a filtering proxy that `boxed` runs (see below). Off unless set. |
| `darwin`, `linux` | Request fragment merged in on that platform. Objects merge key by key, arrays concatenate, other values replace. |

### What boxed fills in

- `version` defaults to `1.0.0`, `containment` to `process`, and `process.cwd` to the current directory.
- `process.commandLine` defaults to `exec <command> <program args>`. If you set it, the program args are appended to it.
- `process.env` entries (`"KEY=VALUE"`) are applied on top of the `passEnv` variables. Nothing else from the host environment reaches the program.

### Temp directory

Each run gets a private directory under `$XDG_CACHE_HOME/boxed` (else `~/.cache/boxed`), removed when the program exits. Its `tmp` subdirectory is granted read-write, `TMPDIR` is set to it, and `${TMPDIR}` in the config expands to it.

The shared temp directories (`/tmp`, `/var/tmp` and the host's own `$TMPDIR`) are added to `deniedPaths`. Other programs keep sockets there, such as tmux, editors and ssh-askpass, and a sandboxed program that can connect to one of those can run commands outside the sandbox. A deny wins over a grant, so listing `/tmp` in `readwritePaths` has no effect. If the current directory is itself inside a shared temp directory, that one is left open and `boxed` warns.

A program that hardcodes `/tmp` needs to be told where to write instead. For Claude Code that is `CLAUDE_CODE_TMPDIR`, which the example config sets.

`"privateTmp": false` turns all of this off: `${TMPDIR}` is then the host temp directory and nothing is denied for you.

### Proxy

MXC's `network.ingress.hostLoopback` opens every port on localhost or none, and on macOS it also has to open inbound connections. `boxed.proxy` is for a program that needs one local service, such as a model server, and the internet:

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

- The proxy runs inside the `boxed` process, so it stops when `boxed` does, however that happens.
- `network.egress.default` must be `deny` or absent (`boxed` sets it), and the config cannot also set `egress` rules, `hostLoopback: "allow"` or `runtimeConfig.networkProxy`.
- Only traffic that honours the proxy variables gets through. A program that opens sockets directly, such as `ssh`, has no network.
- The proxy does not chain to a proxy the host itself needs.

See [`examples/opencode.json`](examples/opencode.json) and [`examples/opencode-locked.json`](examples/opencode-locked.json).

### Paths and variables

- `${CWD}`, `${HOME}` and `${TMPDIR}` expand in any string, and `${env:NAME}` expands to that host environment variable (empty if unset).
- In `process.commandLine` each expanded value is shell-quoted, so write `cd ${CWD}`, not `cd "${CWD}"`.
- A leading `~/` expands in `filesystem` path lists.
- Every `filesystem` path must be absolute once expanded. A relative path, an unknown `${NAME}` or an unset `${env:NAME}` is an error, so a mistyped `deniedPaths` entry cannot silently protect nothing.
- `readonlyPaths` entries that do not exist are dropped, so one config can list locations for several machines. `--debug` reports each one skipped.
- A missing `readonlyPaths` entry that sits inside a `readwritePaths` entry is kept on macOS, so the program cannot create it. On Linux it is dropped like the rest.
- `readwritePaths` entries that do not exist are kept on macOS, so the program can create them on first run. On Linux they are dropped with a warning, because Bubblewrap cannot bind a path that is not there.
- `boxed` refuses to run if a `readwritePaths` entry covers your home directory, which is what `${CWD}` does when you start it from `~`. It warns if one covers the config file or `boxed` itself.

### Notes on the Claude example

- `seatbelt.keychainAccess` is on because Claude Code keeps its login in the macOS Keychain. It makes `~/Library/Keychains` and the per-user cache directories under `/private/var/folders` writable. To do without it, remove the key and pass an API key instead by adding `"ANTHROPIC_API_KEY=${env:ANTHROPIC_API_KEY}"` to `process.env`.
- `~/.claude` has to be writable, and anything Claude loads from there also runs when you start it outside the sandbox. The example makes `settings.json`, `settings.local.json`, `CLAUDE.md`, `hooks`, `commands`, `agents` and `skills` read-only, so changing those from inside a sandboxed session fails. `~/.claude.json` and `~/.claude/plugins` stay writable.
