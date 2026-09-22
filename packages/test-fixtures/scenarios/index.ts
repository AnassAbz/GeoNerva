/**
 * Scenario datasets for the E2E suite (docs/TESTING.md §5).
 *
 * `docs/TESTING.md` names the path `test-fixtures/scenarios/*.sql`. The directory is the one it
 * names; the files are TypeScript rather than SQL, and `marrakech.ts` explains why in full — the
 * short version is that raw SQL would be a second implementation of the ingestion write path, and
 * a seeded row no run could have produced proves nothing.
 *
 * Only tests and `scripts/` may import this package.
 */

export {
  MARRAKECH_PLACE,
  MARRAKECH_REF,
  SCENARIO_ANCHOR,
  SCENARIO_GEOMETRY,
  SCENARIO_IDS,
  SCENARIO_NAMES,
  isScenarioName,
  rowCounts,
  seedMarrakechScenario,
} from './marrakech.ts';
export type { ScenarioDb, ScenarioName, SeedOptions, SeedResult } from './marrakech.ts';
