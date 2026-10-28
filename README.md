# Musebridge

Musebridge is a Node.js 26 ESM monorepo. The Marketplace MCP service lives in [`services/marketplace`](services/marketplace/README.md); it provides synthetic fixture data by default and an opt-in Facebook backend.

- `package.json` and `package-lock.json` — shared npm workspace root and single lockfile.
- `services/marketplace/` — service package, implementation, tests, scripts, and service documentation; there are no shared app packages.

Run service development checks from the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run lint
npm start
```

### Reproducible bootstrap with mise

For a deterministic environment from a clean checkout, use [mise](https://mise.jdx.dev) per the shared repository bootstrap contract ([misospace/courier#414](https://github.com/misospace/courier/issues/414)). The development Node release is pinned exactly in [`.mise/config.toml`](.mise/config.toml) and enforced against download URLs and checksums in [`.mise/mise.lock`](.mise/mise.lock). The supported version *range* stays owned by the `engines` field in `package.json` (CI floats the latest release in that range); this file states neither, to avoid stale duplicates.

```sh
# One command, from a fresh non-root checkout; requires the mise CLI.
# No sudo, no global config changes, no interactive shell.
# The config declares no hooks and no environment mutation; still, read any
# fork's or unfamiliar config before letting tooling execute it.
mise run bootstrap
```

Explicit follow-up tasks: `mise run check` (typecheck, lint, build), `mise run test`, and optional `mise run browser-install` (Playwright Chromium for the CI-parity browser pass). Setup is noninteractive, never installs Git hooks, never contacts live social providers, and requires no credentials; live integration validation stays a separately authorized operation (see the [Marketplace service README](services/marketplace/README.md)).

The plain `npm` commands above remain authoritative and work without mise; CI (`.github/workflows/ci.yml`) is the final gate.

The service package retains its own `dist/index.js` runtime entry. See the [Marketplace service README](services/marketplace/README.md) for tools, configuration, safety constraints, and container instructions.

Before write-capable provider tools, actions are governed by the [provider action boundary contract](docs/provider-action-boundaries.md): session scopes per provider/account/surface, action risk classes, and single-use approval grants enforced by the service. Consumer-surface research and integration-path decisions are recorded in the [capability inventory](docs/capability-inventory.md) (#39).
