/**
 * @geonerva/ai — Optional runtime AI: briefing packets, structured outputs, deterministic
 * validation, fallback (ADR-012, ARCHITECTURE §11).
 *
 * `AI_MODE=disabled` is the default and a first-class mode. Nothing in this package is required
 * for a complete briefing, and nothing in it decides what is true: the model is pushed a bounded
 * packet with no tools, and the **deterministic validator** decides what may be shown.
 *
 * See docs/ARCHITECTURE.md §3 for this package's allowed dependencies.
 */

export {
  MAX_PACKET_BYTES,
  MAX_PACKET_CHANGES,
  MAX_PACKET_ITEMS,
  MAX_PACKET_MANIFEST,
  MAX_PACKET_QUOTES,
  MAX_PACKET_SOURCE_HEALTH,
  PacketRefusedError,
  buildPacket,
  renderPacket,
} from './packet.ts';
export type {
  BriefingPacket,
  PacketChange,
  PacketFamily,
  PacketItem,
  PacketSourceHealth,
} from './packet.ts';

export {
  PROBLEM_CODES,
  interpreterOutputSchema,
  parseInterpreterOutput,
  parseSkepticOutput,
  skepticOutputSchema,
} from './schema.ts';
export type { InterpreterOutput, ProblemCode, SkepticOutput } from './schema.ts';

export {
  MAX_FAILED_CLAIM_FRACTION,
  MAX_SUMMARY_WORDS,
  extractNumbers,
  extractTimestamps,
  extractWordNumerals,
  validateInterpreterOutput,
} from './validate.ts';
export type { ValidationFinding, ValidationResult } from './validate.ts';

export {
  AiClientError,
  DEFAULT_CALL_TIMEOUT_MS,
  FALLBACK_REASONS,
  generateAiBriefing,
} from './generate.ts';
export type {
  AiCallResult,
  AiClient,
  FallbackReason,
  GenerateOptions,
  GenerateOutcome,
} from './generate.ts';
