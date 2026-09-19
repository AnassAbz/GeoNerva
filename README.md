# GeoNerva

**Understand what's changing around you.**

GeoNerva is an open-source web application for **explainable, location-specific natural-hazard
intelligence**. For any place, it answers: _what is changing around here, how unusual is it, how
relevant is it to this location, how confident can we be, and where did the information come
from?_

> **Status: early development.** The architecture is defined; the foundation is being built.
> No live hazard data is served yet. GeoNerva is not an emergency-warning system. It will always
> point to official warnings rather than replace them.

## What it will do (v1)

- Ingest public hazard data from **USGS**, **EMSC**, **GDACS** and **NASA FIRMS**.
- Correlate duplicate reports deterministically, and never count a republished copy as
  independent confirmation.
- Tell you **what changed** over a chosen window, with every statement traceable to evidence.
- Give **honest historical context**, or say plainly when the data cannot support it.
- Surface **stale, missing, uncovered and conflicting** data instead of hiding it.
- Work fully **without AI**. Optional Claude-based explanations come later, grounded in validated
  data only.

## Documentation

| Document                                                   | Contents                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [docs/PRODUCT.md](docs/PRODUCT.md)                         | Product definition, v1 scope, information architecture, language rules          |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)               | System design: ingestion, correlation, geospatial, baselines, What Changed, API |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)               | Verified provider contracts, limits, licences, attribution                      |
| [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md)               | Entities, time semantics, database design                                       |
| [docs/DECISIONS.md](docs/DECISIONS.md)                     | Architecture decision records                                                   |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phases, gates, dependency graph                                                 |
| [docs/TESTING.md](docs/TESTING.md)                         | Test strategy and invariants                                                    |
| [docs/SECURITY.md](docs/SECURITY.md)                       | Threat model and reliability analysis                                           |

## Development

Node.js 24 LTS, pnpm 12 and Docker. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
corepack enable && pnpm install
pnpm db:up && pnpm db:check
pnpm check
```

## Licence

[Apache License 2.0](LICENSE). Third-party data remains subject to its providers' terms; see
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
