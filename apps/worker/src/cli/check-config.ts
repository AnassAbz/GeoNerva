import { ConfigError, loadWorkerConfig, type WorkerConfig } from '@geonerva/config';

/** Summarises configuration without revealing secrets or connection strings. */
export function describeWorkerConfig(config: WorkerConfig): string[] {
  return [
    `NODE_ENV            ${config.NODE_ENV}`,
    `RETENTION_PROFILE   ${config.RETENTION_PROFILE}`,
    `DATABASE_URL_WORKER set (${new URL(config.DATABASE_URL_WORKER).hostname})`,
    `FIRMS_MAP_KEY       ${config.FIRMS_MAP_KEY === undefined ? 'absent (keyless FIRMS mode)' : 'set'}`,
    `WORKER_TRIGGER      ${config.WORKER_TRIGGER_SECRET === undefined ? 'disabled' : 'enabled'}`,
    `AI_MODE             ${config.AI_MODE}${config.AI_MODE === 'anthropic' ? ` (${config.AI_MODEL}, budget US$${config.AI_DAILY_BUDGET_USD}/day)` : ''}`,
  ];
}

/** `geonerva-worker check-config` — validates the environment and prints a redacted summary. */
export function checkConfig(env: NodeJS.ProcessEnv): number {
  try {
    const config = loadWorkerConfig(env);
    console.log('✓ worker configuration is valid');
    for (const line of describeWorkerConfig(config)) console.log(`  ${line}`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ ${error.message}`);
      return 1;
    }
    throw error;
  }
}
