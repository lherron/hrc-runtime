# Wave B local registry (Verdaccio)

Reference doc produced for **T-01529 / Wave B0**. Other Wave B sub-tasks (B2, B4,
and the new HRC/ACP repos) consume from this registry.

## What it is

A loopback-only Verdaccio instance on `max3` used to ship the cross-repo
boundary packages — the 10 ASP packages and 4 HRC packages — between the
agent-spaces, HRC, and ACP repositories during the split.

**Uplinks are intentionally disabled.** If a downstream `bun install` /
`npm install` resolves a cross-repo package and the local registry doesn't
have it yet, we want a hard 404 — not a silent proxy fallthrough to
`registry.npmjs.org`.

## Endpoint

| Field          | Value                              |
| -------------- | ---------------------------------- |
| URL            | `http://127.0.0.1:4873/`           |
| Host scope     | loopback only (`max3` localhost)   |
| Publish user   | `lherron-local`                    |
| Email          | `lherron@gmail.com`                |
| Auth file      | `~/.config/verdaccio/htpasswd` (bcrypt) |
| Storage        | `~/.local/share/verdaccio/storage` |
| Config         | `~/.config/verdaccio/config.yaml`  |
| Daemon         | launchd — `com.lherron.verdaccio`  |
| Plist          | `~/Library/LaunchAgents/com.lherron.verdaccio.plist` |
| Stdout log     | `~/praesidium/var/logs/verdaccio.out.log` |
| Stderr log     | `~/praesidium/var/logs/verdaccio.err.log` |

The launchd job has `KeepAlive=true` and `RunAtLoad=true`, so it survives
shell exit and respawns on logout/login.

### Lifecycle commands

```sh
# load (one-time)
launchctl load -w ~/Library/LaunchAgents/com.lherron.verdaccio.plist

# stop / start (after first load)
launchctl unload ~/Library/LaunchAgents/com.lherron.verdaccio.plist
launchctl load  ~/Library/LaunchAgents/com.lherron.verdaccio.plist

# status
launchctl list | grep verdaccio
curl -s http://127.0.0.1:4873/-/ping  # → "{}", HTTP 200
```

## `.npmrc` snippet for consumers

The Wave B cross-repo packages are **unscoped** (`agent-scope`, `hrc-core`,
etc.), so consumers must route by **URL pattern**, not by `@scope`. Put this in
the new HRC/ACP repos' `.npmrc`:

```ini
# Route the named cross-repo packages through the local Verdaccio.
# Unscoped packages can't be redirected per-name in npm config, so we route
# the entire default registry to the local mirror for these repos.
registry=http://127.0.0.1:4873/

# Auth for publish (read is open on loopback, but publish/unpublish require it).
//127.0.0.1:4873/:_authToken=<TOKEN>

# Belt-and-braces: refuse to silently fall through to npmjs.org for missing pkgs.
# (Verdaccio is also configured with uplinks disabled — see config.yaml.)
fetch-retries=0
```

Replace `<TOKEN>` with the value of the
`//127.0.0.1:4873/:_authToken=` line in `~/.npmrc` on `max3`.

If a repo also needs to install third-party packages from public npm, do **not**
set `registry=` repo-wide. Instead, scope third-party deps explicitly:

```ini
@types:registry=https://registry.npmjs.org/
@anthropic-ai:registry=https://registry.npmjs.org/
# ... etc.
```

or invert and keep public npm as the default and add an entry per cross-repo
package via a publish wrapper. The B2/B4 task owner picks the strategy that
matches the consumer repo's dependency footprint.

## Verification (T-01529 acceptance)

```
$ verdaccio --version
v6.7.1

$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4873/-/ping
200

$ npm whoami --registry http://127.0.0.1:4873/
lherron-local

# round-trip
$ cd /tmp/verdaccio-smoke && npm publish --registry http://127.0.0.1:4873/
+ praesidium-verdaccio-smoke@0.0.1
$ npm view praesidium-verdaccio-smoke --registry http://127.0.0.1:4873/
praesidium-verdaccio-smoke@0.0.1 ...
$ npm unpublish praesidium-verdaccio-smoke@0.0.1 --registry http://127.0.0.1:4873/ --force
- praesidium-verdaccio-smoke

# uplink really is disabled — a known-public package 404s
$ npm view lodash --registry http://127.0.0.1:4873/
npm error 404 Not Found - GET http://127.0.0.1:4873/lodash
```

## Out of scope

- Publishing the real ASP/HRC boundary packages (B2/B4).
- TLS — loopback only, no remote consumers, no certs needed.
- Mirroring across hosts — `mini.lan` is not a consumer of this registry.
