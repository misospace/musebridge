# Musebridge monorepo

- Node.js 24 ESM monorepo. Service packages live under `services/*`; root scripts delegate to the relevant workspace.
- Keep service implementation, tests, scripts, package metadata, and TypeScript configuration inside their owning service. Coordinate Dockerfile, CI, release, image, profile, and tag changes with their owner; do not rewrite unrelated files.
- Marketplace-specific contracts and safety invariants are documented in `services/marketplace/AGENTS.md`; follow them for all work in that service.
- Marketplace PR-review checklists live in `.agents/skills/marketplace-action-safety/SKILL.md` and `.agents/skills/marketplace-provider-contracts/SKILL.md`; load the relevant one for action authorization, browser/session handling, provider schemas, or returned-data behavior.
- Run dependency installation and root-level build, typecheck, test, and lint checks from the repository root.
- Reproducible development bootstrap uses mise: `.mise/config.toml` pins Node exactly and defines `bootstrap`, `check`, `test`, and optional `browser-install` tasks; `.mise/mise.lock` pins download URLs and checksums. Bootstrap stays idempotent, installs no Git hooks, mutates no global config, and needs no provider credentials; the plain `npm` commands above remain authoritative.
