/**
 * Centralized API timeout constants.
 *
 * Single source of truth for all outbound HTTP request timeouts.
 * Values are in milliseconds and should be tuned based on real-world
 * latency data from the OpenRouter API.
 *
 * Rationale:
 *   - models (30s):  Large payload (300+ models), may be slow on first fetch
 *   - key/keys/credits (15s): Small JSON payloads
 *   - activity (20s): 30 days of activity data, moderate payload
 *   - analytics (20s): Aggregation query, moderate payload
 */

export const API_TIMEOUTS_MS = {
	models: 30_000,
	key: 15_000,
	keys: 15_000,
	credits: 15_000,
	activity: 20_000,
	analytics: 20_000,
} as const;
