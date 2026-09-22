/**
 * P9a mock read models. Imported only by `lib/view/data.ts` (the data-access seam P9b replaces)
 * and by tests. Every export is validated against its frozen runtime schema in `fixtures.test.ts`.
 */

export { FIXTURE_NOW, MARRAKECH, MARRAKECH_SLUG } from './common.ts';
export { marrakechBriefing, type BriefingFixtureOptions } from './briefing.ts';
export { earthquakeDetail, floodDetail } from './event.ts';
export { observationEvidence, runEvidence } from './evidence.ts';
export { fireClusterDetail } from './fire.ts';
export { PLACE_SUGGESTIONS, mapFeaturesFixture } from './map.ts';
export { historyFixture, type FixtureScenario } from './metrics.ts';
export { sourceStatusFixture } from './source-status.ts';
export { EQ_PUBLIC_ID, FIRE_PUBLIC_ID, FLOOD_PUBLIC_ID } from './world.ts';
