# GeoNerva

**Understand what's changing around you.**

GeoNerva is an open-source web application for **explainable, location-specific natural-hazard
intelligence**. For any place, it answers: _what is changing around here, how unusual is it, how
relevant is it to this location, how confident can we be, and where did the information come
from?_

> **Status: code complete, not yet publicly deployed.** Every v1 capability is built, tested and
> running against live provider data locally. No public URL exists yet; cloud provisioning and a
> production soak are release activities rather than engineering ones.
>
> GeoNerva is **not an emergency-warning system**. It always points to official warnings rather
> than replacing them.

## What it does (v1)

- Ingests public hazard data from **USGS**, **EMSC**, **GDACS** and **NASA FIRMS**.
- Correlates duplicate reports deterministically, and never counts a republished copy as
  independent confirmation — a GDACS copy of a USGS earthquake is two links and **one** independent
  source.
- Clusters NASA FIRMS thermal detections into areas of activity, which are **never** called
  confirmed wildfires.
- Tells you **what changed** over a chosen window, with every statement traceable to evidence.
- Gives **honest historical context**, or says plainly when the data cannot support it.
- Surfaces **stale, missing, uncovered and conflicting** data instead of hiding it. "We have no
  source here", "the feed is down", "we have not processed it yet" and "nothing is happening" are
  five different answers and never collapse into one.
- Works fully **without AI**. Optional Claude-based explanations are grounded in validated data
  only and are disabled by default.

## Current limitations

These are deliberate and documented rather than hidden. None of them is a defect.

| Limitation                                        | What it means                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Not publicly deployed**                         | Runs locally against live providers. No cloud environment is provisioned and no 24-hour production soak has been run.                                                                            |
| **Weather warnings are not sourced**              | The only enabled candidate (ECCC) is Canada-only and switched off, so `WEATHER_ALERTS` reports `NOT_COVERED` everywhere rather than an empty list.                                               |
| **Cyclone relevance uses track distance only**    | No wind-radii or uncertainty-cone geometry is held, so a cyclone is banded on distance to the track and the card says so.                                                                        |
| **GDACS wildfire events have no relevance model** | They are counted, never dropped, so the fire card withholds its zero and states that the list is incomplete instead of implying quiet.                                                           |
| **NASA FIRMS runs keyless**                       | No `FIRMS_MAP_KEY` is configured, so ingestion reads the public 24-hour global files: no backfill and no area narrowing.                                                                         |
| **The fire trend needs history**                  | Daily aggregates only finalise days at least two days old, so a fresh deployment refuses the trend honestly until it has enough covered days.                                                    |
| **Fire clustering has 72-hour scaling headroom**  | A steady-state pass takes ~181 s against a 300 s interval at present volumes. As the window fills to a full 72 hours this narrows; batching the summary writes is the known future optimisation. |
| **AI explanations are off**                       | `AI_MODE=disabled` is the v1 production default. Deterministic templates produce every sentence.                                                                                                 |

## Documentation

| Document                                                   | Contents                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [docs/PRODUCT.md](docs/PRODUCT.md)                         | Product definition, v1 scope, information architecture, language rules          |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)               | System design: ingestion, correlation, geospatial, baselines, What Changed, API |
| [docs/DIAGRAMS.md](docs/DIAGRAMS.md)                       | Mermaid diagrams: providers, worker, storage, replay, packages, availability    |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)               | Verified provider contracts, limits, licences, attribution                      |
| [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md)               | Entities, time semantics, database design                                       |
| [docs/DECISIONS.md](docs/DECISIONS.md)                     | Architecture decision records                                                   |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phases, gates, dependency graph                                                 |
| [docs/TESTING.md](docs/TESTING.md)                         | Test strategy and invariants                                                    |
| [docs/SECURITY.md](docs/SECURITY.md)                       | Threat model and reliability analysis                                           |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                   | Deployment runbook, operations and the smoke/soak checks                        |

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
