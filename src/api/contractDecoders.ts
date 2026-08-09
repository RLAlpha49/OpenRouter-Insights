// Runtime decoders for the OpenRouter response shapes used by the extension.
//
// The API evolves by adding optional fields. These decoders keep that change
// safe by validating the envelope and required fields while allowing unknown
// fields and incomplete collection entries to be reported as partial data.

import type {
	OpenRouterActivityResponse,
	OpenRouterCreditsResponse,
	OpenRouterKeyResponse,
	OpenRouterKeysResponse,
	CreateKeyResponse,
	UpdateKeyResponse,
	DeleteKeyResponse,
} from "../types-usage";
import type { ContractHealth } from "../types";
import type { EndpointId } from "./endpoint/endpointCatalog";
import { getEndpointContract } from "./endpoint/endpointCatalog";
import { OpenRouterHttpError } from "./transport/openRouterError";

export type DecodeStatus = "valid" | "partial" | "invalid";

export interface DecodeIssue {
	path: string;
	message: string;
}

export interface DecodeResult<T> {
	status: DecodeStatus;
	value?: T;
	issues: DecodeIssue[];
}

/** Safe contract health metadata retained after tolerant decoding. */
export interface DecodedResponse<T> {
	value: T;
	health: ContractHealth;
	responseStatus?: number;
	responseHeaders?: Headers;
}

export interface DecodedModelsResponse {
	data: Record<string, unknown>[];
	links?: { next?: string };
}

/** Normalized analytics row retained after required-field validation. */
export interface DecodedAnalyticsRow {
	model: string;
	totalUsage: number;
	requestCount: number;
	tokensTotal: number | null;
	promptTokens: number | null;
	completionTokens: number | null;
	cacheHitRate: number | null;
}

/** Normalized analytics envelope consumed by the analytics service. */
export interface DecodedAnalyticsResponse {
	rows: DecodedAnalyticsRow[];
	metadata?: { queryTimeMs?: number; rowCount?: number; truncated?: boolean };
}

export type DecodeFunction<T> = (_input: unknown) => DecodeResult<T>;

export interface EndpointResponseMap {
	"models.list": DecodedModelsResponse;
	"keys.current": OpenRouterKeyResponse;
	"keys.list": OpenRouterKeysResponse;
	"credits.get": OpenRouterCreditsResponse;
	"activity.list": OpenRouterActivityResponse;
	"analytics.query": DecodedAnalyticsResponse;
	"keys.create": CreateKeyResponse;
	"keys.update": UpdateKeyResponse;
	"keys.delete": DeleteKeyResponse;
}

const ENDPOINT_DECODERS = {
	models: decodeModelsResponse,
	key: decodeKeyResponse,
	keys: decodeKeysResponse,
	credits: decodeCreditsResponse,
	activity: decodeActivityResponse,
	analytics: decodeAnalyticsResponse,
	createKey: decodeCreateKeyResponse,
	updateKey: decodeUpdateKeyResponse,
	deleteKey: decodeDeleteKeyResponse,
} satisfies Record<
	Exclude<import("./endpoint/endpointCatalog").EndpointDecoder, "endpoints">,
	DecodeFunction<unknown>
>;

function record(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined;
}

function stringValue(input: unknown): string | undefined {
	return typeof input === "string" && input.trim() ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
	const value = typeof input === "string" && input.trim() ? Number(input) : input;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(input: unknown): boolean | undefined {
	return typeof input === "boolean" ? input : undefined;
}

function nullableNumberValue(input: unknown): number | null | undefined {
	return input === null ? null : numberValue(input);
}

function nullableStringValue(input: unknown): string | null | undefined {
	return input === null ? null : stringValue(input);
}

function result<T>(
	status: DecodeStatus,
	value: T | undefined,
	issues: DecodeIssue[],
): DecodeResult<T> {
	return { status, value, issues };
}

function collectionStatus(issues: DecodeIssue[], dropped: number): DecodeStatus {
	return issues.length === 0 && dropped === 0 ? "valid" : "partial";
}

function decodeModelEntry(input: unknown): Record<string, unknown> | undefined {
	const item = record(input);
	if (!item) return undefined;
	if (!stringValue(item.id) || !stringValue(item.name)) return undefined;
	const contextLength = numberValue(item.context_length);
	if (contextLength === undefined) return undefined;
	const pricing = record(item.pricing);
	if (!pricing) return undefined;
	const prompt = numberValue(pricing.prompt);
	const completion = numberValue(pricing.completion);
	if (prompt === undefined || completion === undefined) return undefined;
	return { ...item, context_length: contextLength, pricing: { ...pricing, prompt, completion } };
}

export function decodeModelsResponse(input: unknown): DecodeResult<DecodedModelsResponse> {
	const body = record(input);
	if (!body || !Array.isArray(body.data)) {
		return result<DecodedModelsResponse>("invalid", undefined, [
			{ path: "data", message: "Expected an array" },
		]);
	}

	const issues: DecodeIssue[] = [];
	const data: Record<string, unknown>[] = [];
	let dropped = 0;
	body.data.forEach((item, index) => {
		const decoded = decodeModelEntry(item);
		if (decoded) data.push(decoded);
		else {
			dropped++;
			issues.push({
				path: `data[${index}]`,
				message: "Missing model id, name, context_length, or pricing",
			});
		}
	});

	const links = record(body.links);
	const next = links ? stringValue(links.next) : undefined;
	if (links?.next !== undefined && !next) {
		issues.push({ path: "links.next", message: "Expected a non-empty URL string" });
	}
	return result(
		collectionStatus(issues, dropped),
		{ data, links: next ? { next } : undefined },
		issues,
	);
}

export function decodeAnalyticsResponse(input: unknown): DecodeResult<DecodedAnalyticsResponse> {
	const body = record(input);
	if (!body || (!Array.isArray(body.data) && !record(body.data))) {
		return result<DecodedAnalyticsResponse>("invalid", undefined, [
			{ path: "data", message: "Expected an array or data envelope" },
		]);
	}
	const envelope = Array.isArray(body.data) ? body : record(body.data)!;
	const rawRows = Array.isArray(envelope.data) ? envelope.data : undefined;
	if (!rawRows) {
		return result<DecodedAnalyticsResponse>("invalid", undefined, [
			{ path: "data.data", message: "Expected an array" },
		]);
	}
	const issues: DecodeIssue[] = [];
	const rows = rawRows.flatMap((row, index) => {
		const decoded = decodeAnalyticsRow(row, `data[${index}]`, issues);
		return decoded ? [decoded] : [];
	});
	const metadata = Array.isArray(body.data)
		? undefined
		: decodeAnalyticsMetadata(envelope.metadata);
	return result(collectionStatus(issues, rawRows.length - rows.length), { rows, metadata }, issues);
}

function decodeAnalyticsRow(
	input: unknown,
	path: string,
	issues: DecodeIssue[],
): DecodedAnalyticsRow | undefined {
	const row = record(input);
	if (!row) {
		issues.push({ path, message: "Expected an analytics row object" });
		return undefined;
	}
	const model = stringValue(row.model);
	const totalUsage = numberValue(row.total_usage);
	const requestCount = numberValue(row.request_count);
	const missing = [
		...(model ? [] : ["model"]),
		...(totalUsage === undefined ? ["total_usage"] : []),
		...(requestCount === undefined ? ["request_count"] : []),
	];
	if (missing.length > 0 || model === undefined) {
		issues.push({ path, message: `Missing or invalid analytics fields: ${missing.join(", ")}` });
		return undefined;
	}
	return {
		model,
		totalUsage: totalUsage as number,
		requestCount: requestCount as number,
		tokensTotal: optionalMetric(row, "tokens_total", path, issues),
		promptTokens: optionalMetric(row, "tokens_prompt", path, issues),
		completionTokens: optionalMetric(row, "tokens_completion", path, issues),
		cacheHitRate: optionalMetric(row, "cache_hit_rate", path, issues),
	};
}

/** Read an optional numeric metric, reporting present-but-unusable values. */
function optionalMetric(
	row: Record<string, unknown>,
	field: string,
	path: string,
	issues: DecodeIssue[],
): number | null {
	const raw = row[field];
	if (raw === undefined || raw === null) return null;
	const parsed = numberValue(raw);
	if (parsed === undefined) {
		issues.push({ path: `${path}.${field}`, message: "Expected a numeric metric" });
		return null;
	}
	return parsed;
}

function decodeAnalyticsMetadata(input: unknown): DecodedAnalyticsResponse["metadata"] | undefined {
	const metadata = record(input);
	if (!metadata) return undefined;
	return {
		queryTimeMs: numberValue(metadata.query_time_ms),
		rowCount: numberValue(metadata.row_count),
		truncated: booleanValue(metadata.truncated),
	};
}

export function decodeCreditsResponse(input: unknown): DecodeResult<OpenRouterCreditsResponse> {
	const body = record(input);
	const data = body && record(body.data);
	if (
		!data ||
		numberValue(data.total_credits) === undefined ||
		numberValue(data.total_usage) === undefined
	) {
		return result<OpenRouterCreditsResponse>("invalid", undefined, [
			{ path: "data", message: "Expected numeric total_credits and total_usage" },
		]);
	}
	return result(
		"valid",
		{
			data: {
				total_credits: numberValue(data.total_credits) as number,
				total_usage: numberValue(data.total_usage) as number,
			},
		},
		[],
	);
}

export function decodeKeyResponse(input: unknown): DecodeResult<OpenRouterKeyResponse> {
	const data = record(record(input)?.data);
	const required = [
		"label",
		"usage",
		"usage_daily",
		"usage_weekly",
		"usage_monthly",
		"is_free_tier",
	];
	const valid =
		data &&
		required.every((field) => {
			if (field === "label") return typeof data[field] === "string";
			if (field === "is_free_tier") return typeof data[field] === "boolean";
			return numberValue(data[field]) !== undefined;
		});
	if (!valid)
		return result<OpenRouterKeyResponse>("invalid", undefined, [
			{ path: "data", message: "Missing or invalid key fields" },
		]);
	return result(
		"valid",
		{
			data: {
				label: data.label as string,
				usage: numberValue(data.usage) as number,
				usage_daily: numberValue(data.usage_daily) as number,
				usage_weekly: numberValue(data.usage_weekly) as number,
				usage_monthly: numberValue(data.usage_monthly) as number,
				limit: nullableNumberValue(data.limit) as number | null,
				limit_remaining: nullableNumberValue(data.limit_remaining) as number | null,
				limit_reset: nullableStringValue(data.limit_reset) as string | null,
				is_free_tier: data.is_free_tier as boolean,
				...(typeof data.is_management_key === "boolean"
					? { is_management_key: data.is_management_key }
					: {}),
			},
		},
		[],
	);
}

export function decodeKeysResponse(input: unknown): DecodeResult<OpenRouterKeysResponse> {
	const raw = record(input)?.data;
	if (!Array.isArray(raw))
		return result<OpenRouterKeysResponse>("invalid", undefined, [
			{ path: "data", message: "Expected an array" },
		]);
	const issues: DecodeIssue[] = [];
	const data = raw.flatMap((value, index) => {
		const entry = record(value);
		const valid =
			entry &&
			typeof entry.hash === "string" &&
			typeof entry.label === "string" &&
			typeof entry.name === "string" &&
			typeof entry.disabled === "boolean" &&
			["usage", "usage_daily", "usage_weekly", "usage_monthly"].every(
				(f) => numberValue(entry[f]) !== undefined,
			);
		if (!valid) {
			issues.push({ path: `data[${index}]`, message: "Missing or invalid key fields" });
			return [];
		}
		return [
			{
				hash: entry.hash as string,
				label: entry.label as string,
				name: entry.name as string,
				disabled: entry.disabled as boolean,
				usage: numberValue(entry.usage) as number,
				usage_daily: numberValue(entry.usage_daily) as number,
				usage_weekly: numberValue(entry.usage_weekly) as number,
				usage_monthly: numberValue(entry.usage_monthly) as number,
				limit: nullableNumberValue(entry.limit) as number | null,
				limit_remaining: nullableNumberValue(entry.limit_remaining) as number | null,
				limit_reset: nullableStringValue(entry.limit_reset) as string | null,
				created_at: typeof entry.created_at === "string" ? entry.created_at : "",
				updated_at: typeof entry.updated_at === "string" ? entry.updated_at : "",
			},
		];
	});
	return result(collectionStatus(issues, raw.length - data.length), { data }, issues);
}

export function decodeActivityResponse(input: unknown): DecodeResult<OpenRouterActivityResponse> {
	const raw = record(input)?.data;
	if (!Array.isArray(raw))
		return result<OpenRouterActivityResponse>("invalid", undefined, [
			{ path: "data", message: "Expected an array" },
		]);
	const issues: DecodeIssue[] = [];
	const data = raw.flatMap((value, index) => {
		const entry = record(value);
		const valid =
			entry &&
			typeof entry.date === "string" &&
			numberValue(entry.usage) !== undefined &&
			numberValue(entry.requests) !== undefined;
		if (!valid) {
			issues.push({ path: `data[${index}]`, message: "Missing activity date, usage, or requests" });
			return [];
		}
		return [
			{
				date: entry.date as string,
				usage: numberValue(entry.usage) as number,
				requests: numberValue(entry.requests) as number,
				...(typeof entry.model === "string" ? { model: entry.model } : {}),
				...(typeof entry.model_permaslug === "string"
					? { model_permaslug: entry.model_permaslug }
					: {}),
				...(typeof entry.provider_name === "string" ? { provider_name: entry.provider_name } : {}),
				...(typeof entry.endpoint_id === "string" ? { endpoint_id: entry.endpoint_id } : {}),
				...(numberValue(entry.byok_usage_inference) !== undefined
					? { byok_usage_inference: numberValue(entry.byok_usage_inference) }
					: {}),
				...(numberValue(entry.prompt_tokens) !== undefined
					? { prompt_tokens: numberValue(entry.prompt_tokens) }
					: {}),
				...(numberValue(entry.completion_tokens) !== undefined
					? { completion_tokens: numberValue(entry.completion_tokens) }
					: {}),
				...(numberValue(entry.reasoning_tokens) !== undefined
					? { reasoning_tokens: numberValue(entry.reasoning_tokens) }
					: {}),
			},
		];
	});
	return result(collectionStatus(issues, raw.length - data.length), { data }, issues);
}

function decodeCreateKeyResponse(input: unknown): DecodeResult<CreateKeyResponse> {
	const body = record(input);
	const data = body && record(body.data);
	if (
		!data ||
		!stringValue(data.key) ||
		!stringValue(data.hash) ||
		typeof data.name !== "string" ||
		!stringValue(data.label) ||
		booleanValue(data.disabled) === undefined ||
		nullableNumberValue(data.limit) === undefined ||
		nullableNumberValue(data.limit_remaining) === undefined ||
		nullableStringValue(data.limit_reset) === undefined
	) {
		return result<CreateKeyResponse>("invalid", undefined, [
			{ path: "data", message: "Missing or invalid created-key fields" },
		]);
	}
	return result("valid", { data: data as unknown as CreateKeyResponse["data"] }, []);
}

function decodeUpdateKeyResponse(input: unknown): DecodeResult<UpdateKeyResponse> {
	const body = record(input);
	const data = body && record(body.data);
	if (
		!data ||
		!stringValue(data.hash) ||
		typeof data.name !== "string" ||
		!stringValue(data.label) ||
		booleanValue(data.disabled) === undefined ||
		nullableNumberValue(data.limit) === undefined ||
		nullableNumberValue(data.limit_remaining) === undefined ||
		nullableStringValue(data.limit_reset) === undefined
	) {
		return result<UpdateKeyResponse>("invalid", undefined, [
			{ path: "data", message: "Missing or invalid updated-key fields" },
		]);
	}
	return result("valid", { data: data as unknown as UpdateKeyResponse["data"] }, []);
}

function decodeDeleteKeyResponse(input: unknown): DecodeResult<DeleteKeyResponse> {
	const body = record(input);
	const data = body && record(body.data);
	if (!data || typeof data.success !== "boolean") {
		return result<DeleteKeyResponse>("invalid", undefined, [
			{ path: "data.success", message: "Expected a boolean success flag" },
		]);
	}
	return result("valid", { data: { success: data.success } }, []);
}

/** Decode an external response using the endpoint catalog's typed ID. */
export function decodeEndpointResponse<K extends EndpointId>(
	endpointId: K,
	input: unknown,
): DecodeResult<EndpointResponseMap[K]> {
	const decoder = getEndpointContract(endpointId).decoder;
	const decode = ENDPOINT_DECODERS[decoder as keyof typeof ENDPOINT_DECODERS];
	if (!decode) throw new Error(`Unsupported endpoint decoder: ${String(decoder)}`);
	return decode(input) as DecodeResult<EndpointResponseMap[K]>;
}

function healthOf<T>(decoded: DecodeResult<T>): ContractHealth {
	return {
		status: decoded.status === "invalid" ? "partial" : decoded.status,
		issueCount: decoded.issues.length,
		issues: decoded.issues,
	};
}

/** Combine health from several pages or related endpoint responses. */
export function mergeContractHealth(health: readonly ContractHealth[]): ContractHealth {
	const issues = health.flatMap((entry) => entry.issues);
	return {
		status: health.some((entry) => entry.status === "partial") ? "partial" : "valid",
		issueCount: issues.length,
		issues,
	};
}

export function decodeOrThrow<T>(
	endpointId: EndpointId,
	decoder: DecodeFunction<T>,
	input: unknown,
	responseStatus?: number,
): DecodedResponse<T> {
	const decoded = decoder(input);
	if (decoded.status === "invalid" || !decoded.value) {
		const details = decoded.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ");
		throw new OpenRouterHttpError({
			label: endpointId,
			status: 0,
			responseStatus,
			errorClass: "malformed-response",
			envelope: { message: `Invalid response: ${details}` },
		});
	}
	return { value: decoded.value, health: healthOf(decoded) };
}
