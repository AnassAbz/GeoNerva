# Contributing to GeoNerva

Thanks for your interest. GeoNerva is built around a few non-negotiable principles. Please read
[docs/PRODUCT.md](docs/PRODUCT.md) (what GeoNerva must and must not claim) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before proposing substantial changes.

## Development setup

Requirements: **Node.js 24 LTS** (see `.nvmrc`), **pnpm 12** (via Corepack) and **Docker**.

```bash
corepack enable
pnpm install
pnpm db:up        # local PostgreSQL 17 + PostGIS 3.5 on 127.0.0.1:54320
pnpm db:check     # verifies connectivity and required extensions
cp .env.example .env
pnpm dev          # web app on http://localhost:3000
```

## Checks

`pnpm check` runs what CI runs on every pull request, except integration and end-to-end tests:

| Command                       | What it does                                               |
| ----------------------------- | ---------------------------------------------------------- |
| `pnpm typecheck`              | TypeScript strict mode across all workspaces               |
| `pnpm lint`                   | ESLint with type-aware rules (zero warnings allowed)       |
| `pnpm format:check`           | Prettier                                                   |
| `pnpm depcruise`              | Architecture rules (package dependency direction)          |
| `pnpm test:unit`              | Unit and property tests                                    |
| `pnpm test:integration`       | Tests against a real PostGIS database (`pnpm db:up` first) |
| `pnpm build && pnpm test:e2e` | Production build and Playwright tests                      |

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(ingestion): add USGS earthquake adapter`, `fix(relevance): …`, `test(replay): …`.
  Keep commits small and meaningful.
- **Architecture changes** need an ADR in [docs/DECISIONS.md](docs/DECISIONS.md). The dependency
  rules in `.dependency-cruiser.cjs` encode the architecture and must not be weakened casually.
- **Provider data** is untrusted input: validate it, never render it as HTML, never pass it to an
  LLM as instructions.
- **Language matters**: never call a satellite thermal detection a "wildfire", never say a place is
  "safe", never imply earthquake prediction. See the language rules in `docs/PRODUCT.md` §7.
- **No fake implementations**: if something is not implemented, it must not pretend to be.

## Adding a data source

Every source needs verified official documentation, licence and attribution requirements, recorded
in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md), plus captured fixtures and contract tests. Scraping
HTML when an official API or feed exists is not accepted.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
