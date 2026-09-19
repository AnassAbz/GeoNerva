/**
 * Database platform requirements shared by `pnpm db:check` and the integration suite:
 * PostgreSQL ≥ 15 with the PostGIS and pg_trgm extensions available (docs/DOMAIN_MODEL.md §6).
 *
 * Read-only: inspects catalogs, never creates extensions or objects (migrations own that).
 */
import type pg from 'pg';

export const LOCAL_COMPOSE_URL = 'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva';
export const REQUIRED_EXTENSIONS = ['pg_trgm', 'postgis'] as const;
export const MIN_SERVER_VERSION_NUM = 150000;

export interface DatabaseRequirementsReport {
  readonly serverVersion: string;
  readonly serverVersionNum: number;
  readonly serverVersionOk: boolean;
  readonly extensions: readonly { name: string; availableVersion: string | null }[];
  readonly ok: boolean;
}

/** Connection string precedence: worker URL, then web URL, then the local compose database. */
export function resolveDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  return env['DATABASE_URL_WORKER'] ?? env['DATABASE_URL'] ?? LOCAL_COMPOSE_URL;
}

export async function checkDatabaseRequirements(
  client: pg.ClientBase,
): Promise<DatabaseRequirementsReport> {
  const versionResult = await client.query<{ server_version_num: string; version: string }>(
    "SELECT current_setting('server_version_num') AS server_version_num, version() AS version",
  );
  const row = versionResult.rows[0];
  if (row === undefined) throw new Error('the server returned no version information');
  const serverVersionNum = Number(row.server_version_num);

  const extensionResult = await client.query<{ name: string; default_version: string }>(
    'SELECT name, default_version FROM pg_available_extensions WHERE name = ANY($1::text[])',
    [REQUIRED_EXTENSIONS],
  );
  const available = new Map(extensionResult.rows.map((ext) => [ext.name, ext.default_version]));
  const extensions = REQUIRED_EXTENSIONS.map((name) => ({
    name,
    availableVersion: available.get(name) ?? null,
  }));

  const serverVersionOk = serverVersionNum >= MIN_SERVER_VERSION_NUM;
  return {
    serverVersion: row.version.split(',')[0] ?? row.version,
    serverVersionNum,
    serverVersionOk,
    extensions,
    ok: serverVersionOk && extensions.every((ext) => ext.availableVersion !== null),
  };
}
