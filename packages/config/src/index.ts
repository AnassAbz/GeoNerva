/**
 * @geonerva/config — environment parsing and validation, retention profiles and feature flags.
 *
 * Every process validates its environment at start-up and fails fast with a readable error
 * that names variables but never echoes their values.
 */
export {
  AI_MODES,
  ENV_VAR_NAMES,
  ConfigError,
  DEFAULT_AI_MODEL,
  DEFAULT_MAP_STYLE_URL,
  PUBLIC_ENV_VARS,
  RETENTION_PROFILES,
  SECRET_ENV_VARS,
  isPostgresUrl,
  loadWebConfig,
  loadWorkerConfig,
} from './env.ts';
export type { AiMode, RetentionProfile, WebConfig, WorkerConfig } from './env.ts';
