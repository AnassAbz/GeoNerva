import { ConfigError, loadWorkerConfig, type WorkerConfig } from '@geonerva/config';

/** Host of a connection URL, or a neutral marker; never throws and never returns credentials. */
function hostOf(connectionUrl: string): string {
  return URL.canParse(connectionUrl) ? new URL(connectionUrl).hostname : 'unparseable URL';
}

/** Summarises configuration without revealing secrets or connection strings. */
export function describeWorkerConfig(config: WorkerConfig): string[] {
  const ai =
    config.AI_MODE === 'anthropic'
      ? `anthropic (${config.AI_MODEL}, budget US$${config.AI_DAILY_BUDGET_USD}/day)`
      : config.AI_MODE;
  return [
    `NODE_ENV            ${config.NODE_ENV}`,
    `GEONERVA_BUILD      ${config.GEONERVA_BUILD ?? 'unset (runs will be unattributed)'}`,
    `RETENTION_PROFILE   ${config.RETENTION_PROFILE}`,
    `DATABASE_URL_WORKER set (${hostOf(config.DATABASE_URL_WORKER)})`,
    `FIRMS_MAP_KEY       ${config.FIRMS_MAP_KEY === undefined ? 'absent (keyless FIRMS mode)' : 'set'}`,
    `WORKER_TRIGGER      ${config.WORKER_TRIGGER_SECRET === undefined ? 'disabled' : 'enabled'}`,
    `AI_MODE             ${ai}`,
  ];
}

/** `geonerva-worker check-config` — validates the environment and prints a redacted summary. */
export function checkConfig(env: NodeJS.ProcessEnv): number {
  let summary: string[];
  try {
    summary = describeWorkerConfig(loadWorkerConfig(env));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ ${error.message}`);
      return 1;
    }
    throw error;
  }
  console.log('✓ worker configuration is valid');
  for (const line of summary) console.log(`  ${line}`);
  return 0;
}
