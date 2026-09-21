/**
 * @geonerva/db — migrations, the typed client, repositories, the as-of query layer and spatial
 * SQL. **The only package that contains SQL or imports a Postgres driver**
 * (docs/ARCHITECTURE.md §3, rule 3; enforced by `.dependency-cruiser.cjs`).
 *
 * The shape of this package follows the two decisions it exists to serve:
 *
 *  - facts are append-only and bitemporal, so reads go through `asof.ts` and writes go through
 *    `repositories/` (ADR-003);
 *  - everything spatial is `geography(4326)` and lives in `spatial/`, which is a mandatory
 *    security-review surface (ADR-002).
 */

export {
  createDatabase,
  createDb,
  createPool,
  webPoolOptions,
  workerPoolOptions,
  GEONERVA_SCHEMA,
  SEARCH_PATH,
} from './client.ts';
export type { CreatePoolOptions, DatabaseHandle } from './client.ts';

export {
  DatabaseUrlError,
  assertConnectionUrlPolicy,
  databaseNameOf,
  describeConnectionTarget,
  hostOf,
  isLoopbackHost,
  sslConfigFor,
  sslModeOf,
} from './connection-url.ts';
export type { ConnectionPolicyOptions, DriverSslConfig } from './connection-url.ts';

export type { DB } from './generated/database.ts';

export {
  MIGRATIONS_DIR,
  MigrationLoadError,
  checksumOf,
  loadMigrations,
} from './migrator/migrations.ts';
export type { MigrationFile } from './migrator/migrations.ts';

export {
  MIGRATION_LOCK_KEY,
  MigrationFailedError,
  MigrationIntegrityError,
  migrateUp,
  migrationStatus,
} from './migrator/runner.ts';
export type {
  AppliedMigration,
  MigrateResult,
  MigrationStatus,
  MigrationStatusEntry,
} from './migrator/runner.ts';

export {
  attributionsFor,
  clusterVersionsAsOf,
  clusterVersionsNow,
  derivationsAsOf,
  evidenceItemsAsOf,
  healthAsOf,
  linksAsOf,
  observationsAsOf,
  newestDetectionIngestAt,
  observationsNow,
  clusterEvidenceAsOf,
  correlationEvidenceAsOf,
  observationEvidenceAsOf,
  productCoverageFor,
  runEvidenceAsOf,
  runSummariesAsOf,
  runTally24hAsOf,
  sourceCatalog,
  sourceCutoffsAsOf,
  workerHeartbeatAsOf,
} from './asof.ts';
export type {
  AttributionRow,
  ClusterVersionRow,
  DerivationStatusAsOf,
  EvidenceRow,
  LinkRow,
  ObservationRow,
  ObservationsAsOfOptions,
  ClusterEvidenceRow,
  CorrelationEvidenceRow,
  ObservationEvidenceRow,
  ProductCoverageRow,
  RunEvidenceRow,
  RunSummaryRow,
  RunTallyRow,
  SourceHealthAsOf,
  SourceProductRow,
  SourceRow,
  WorkerHeartbeatRow,
} from './asof.ts';

export * from './repositories/index.ts';
export * from './spatial/index.ts';

export { generateFireClusterPublicId, generatePublicId, publicIdPrefixFor } from './public-id.ts';

export {
  MAX_TARGET_POSTGIS_VERSION,
  MIN_SUPPORTED_POSTGIS_VERSION,
  MIN_SUPPORTED_POSTGRES_VERSION_NUM,
  REQUIRED_POSTGIS_FUNCTIONS,
  compareVersions,
  functionsBeyondTarget,
  isAtLeastVersion,
} from './postgis-requirements.ts';
export type { PostgisFunctionRequirement } from './postgis-requirements.ts';
