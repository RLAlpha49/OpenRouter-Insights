/**
 * sqliteReader — zero-dependency SQLite file reader for extracting
 * key-value pairs from VS Code's state.vscdb database.
 *
 * Implements only the minimal SQLite on-disk format needed to resolve
 * `SELECT value FROM ItemTable WHERE key = ?` queries. This replaces
 * the ~1.2 MB sql.js WASM dependency, reducing the VSIX by >90%.
 *
 * Supported: standard SQLite db files (journal modes: delete, truncate,
 * persist) and WAL mode (reads the main-file snapshot merged with the
 * companion `-wal` file so the newest committed values are observed).
 * Not supported: encrypted databases, zipvfs, full-text indexes.
 *
 * Based on the SQLite file format spec:
 * https://www.sqlite.org/fileformat.html
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";

export type SqliteReadDiagnostic =
	| "ok"
	| "not-found"
	| "busy"
	| "unreadable"
	| "unsupported-schema"
	| "corrupt"
	| "no-match"
	| "wal-unreadable"
	| "wal-incomplete";

export interface SqliteReadResult {
	value?: string;
	diagnostic: SqliteReadDiagnostic;
}

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_VISITED_PAGES = 8192;
const MAX_OVERFLOW_PAGES = 256;
/** Maximum number of WAL frames to merge (bounds memory on huge WALs). */
const MAX_WAL_FRAMES = 4096;

// ── SQLite header ──────────────────────────────────────────────

/** Parsed SQLite database header (first 100 bytes of page 1). */
interface SqliteHeader {
	pageSize: number;
	/** Always 1 for standard journal modes; 2 for WAL. */
	fileFormatVersion: number;
	/** Reserved bytes at the end of each page (almost always 0). */
	reservedBytes: number;
}

function parseHeader(buffer: Buffer): SqliteHeader {
	if (buffer.length < 100) throw new Error("SQLite header is truncated");
	const magic = buffer.toString("utf8", 0, 16);
	if (magic !== "SQLite format 3\u0000") {
		throw new Error("Not a valid SQLite 3 database file");
	}

	const pageSizeRaw = buffer.readUInt16BE(16);
	const pageSize = pageSizeRaw === 1 ? 65536 : pageSizeRaw;
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
		throw new Error(`Invalid page size: ${pageSizeRaw}`);
	}

	return {
		pageSize,
		fileFormatVersion: buffer.readUInt8(18),
		reservedBytes: buffer.readUInt8(20),
	};
}

// ── Varint decoding ────────────────────────────────────────────

/** Read a SQLite variable-length integer starting at `offset` in `buffer`. */
function readVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
	let value = 0;
	let bytesRead = 0;
	for (let i = 0; i < 9 && offset + i < buffer.length; i++) {
		const byte = buffer.readUInt8(offset + i);
		bytesRead++;
		value = (value << 7) | (byte & 0x7f);
		if ((byte & 0x80) === 0) break;
	}
	if (bytesRead === 0 || (bytesRead === 9 && (buffer[offset + 8] & 0x80) !== 0)) {
		throw new Error("Malformed SQLite varint");
	}
	return { value, bytesRead };
}

// ── Page I/O ───────────────────────────────────────────────────

/**
 * Extract a full page from the file buffer.
 * Page 1 includes the 100-byte file header at byte 0.
 * Subsequent pages begin at `pageSize * (pageNum - 1)`.
 *
 * The returned buffer always contains the complete page (pageSize bytes,
 * minus reservedBytes at the end). Cell offsets within the page are
 * relative to byte 0 of the returned buffer.
 */
function readPage(buffer: Buffer, pageNum: number, header: SqliteHeader): Buffer {
	const offset = (pageNum - 1) * header.pageSize;
	const usableSize = header.pageSize - header.reservedBytes;
	const end = offset + usableSize;
	// Clamp to file bounds; pages beyond the file are silently treated as empty
	if (offset < 0 || offset + usableSize > buffer.length) return Buffer.alloc(0);
	const actualEnd = Math.min(end, buffer.length);
	return buffer.subarray(offset, actualEnd);
}

// ── B-tree page parsing ────────────────────────────────────────

/** B-tree page type flags (byte 0 of the page data). */
const BTREE_INTERIOR_TABLE = 0x05;
const BTREE_INTERIOR_INDEX = 0x02;
const BTREE_LEAF_TABLE = 0x0d;
const BTREE_LEAF_INDEX = 0x0a;

interface BtreePage {
	type: "interior" | "leaf";
	pageNum: number;
	/** Right-most child page (interior pages only). */
	rightMostPtr: number;
	cells: BtreeCell[];
}

interface BtreeCell {
	/** Offset of this cell's content within the page data (relative to byte 0 of the page buffer). */
	offset: number;
	/** For interior cells: the left-child page number. */
	leftChild?: number;
}

/**
 * Parse a B-tree page from its raw data.
 *
 * For page 1, the file header (bytes 0-99) precedes the b-tree page
 * content, so the b-tree header fields are at data[100], data[103], etc.
 * Cell offsets are always relative to the start of the page buffer.
 *
 * @returns null if the page type is unrecognised.
 */
function parseBtreePage(data: Buffer, pageNum: number): BtreePage | null {
	if (data.length === 0) return null;

	const hdrOffset = pageNum === 1 ? 100 : 0;
	if (data.length <= hdrOffset) return null;

	const pageType = data.readUInt8(hdrOffset);
	if (
		pageType !== BTREE_INTERIOR_TABLE &&
		pageType !== BTREE_LEAF_TABLE &&
		pageType !== BTREE_INTERIOR_INDEX &&
		pageType !== BTREE_LEAF_INDEX
	) {
		return null;
	}

	const isInterior = pageType === BTREE_INTERIOR_TABLE || pageType === BTREE_INTERIOR_INDEX;
	const numCells = data.readUInt16BE(hdrOffset + 3);
	const cellPointerArrayStart = hdrOffset + (isInterior ? 12 : 8);
	const rightMostPtr = isInterior ? data.readUInt32BE(hdrOffset + 8) : 0;

	const cells: BtreeCell[] = [];
	const maxCellOffset = data.length;
	for (let i = 0; i < numCells; i++) {
		const ptrOffset = cellPointerArrayStart + i * 2;
		if (ptrOffset + 2 > data.length) break;
		const cellOffset = data.readUInt16BE(ptrOffset);
		// Cell offset must point within the page (leaves room for at least 2 varints)
		if (cellOffset < hdrOffset || cellOffset + 2 > maxCellOffset) continue;
		const cell: BtreeCell = { offset: cellOffset };
		if (isInterior) {
			cell.leftChild = data.readUInt32BE(cellOffset);
		}
		cells.push(cell);
	}

	return { type: isInterior ? "interior" : "leaf", pageNum, rightMostPtr, cells };
}

// ── Record (payload) decoding ──────────────────────────────────

/** SQLite serial type constants. */
const SERIAL_NULL = 0;
const SERIAL_INT8 = 1;
const SERIAL_INT16 = 2;
const SERIAL_INT24 = 3;
const SERIAL_INT32 = 4;
const SERIAL_INT48 = 5;
const SERIAL_INT64 = 6;
const SERIAL_FLOAT64 = 7;
const SERIAL_INT0 = 8;
const SERIAL_INT1 = 9;

/** Width in bytes for each serial type. */
function serialTypeWidth(serialType: number): number {
	switch (serialType) {
		case SERIAL_NULL:
		case SERIAL_INT0:
		case SERIAL_INT1:
			return 0;
		case SERIAL_INT8:
			return 1;
		case SERIAL_INT16:
			return 2;
		case SERIAL_INT24:
			return 3;
		case SERIAL_INT32:
			return 4;
		case SERIAL_INT48:
			return 6;
		case SERIAL_INT64:
			return 8;
		case SERIAL_FLOAT64:
			return 8;
		default:
			return serialType >= 13 ? (serialType - 13) / 2 : (serialType - 12) / 2;
	}
}

// ── Cell payload extraction ────────────────────────────────────

interface CellPayload {
	payload: Buffer;
	rowId: number;
}

/** Read a cell's payload, including overflow page assembly if needed. */
function readCellPayload(
	pageData: Buffer,
	cell: BtreeCell,
	fullFile: Buffer,
	header: SqliteHeader,
): CellPayload | null {
	let cursor = cell.offset;

	if (cell.leftChild !== undefined) {
		cursor += 4;
	}

	// Bounds: need at least 2 bytes for the two varints (payload size + rowid)
	if (cursor < 0 || cursor + 2 > pageData.length) return null;

	const payloadSize = readVarint(pageData, cursor);
	if (payloadSize.value < 0 || payloadSize.value > MAX_PAYLOAD_BYTES) return null;
	cursor += payloadSize.bytesRead;

	if (cursor >= pageData.length) return null;
	const rowIdResult = readVarint(pageData, cursor);
	cursor += rowIdResult.bytesRead;

	const usableSize = header.pageSize - header.reservedBytes;
	const maxLocal = usableSize - 35;

	let localSize: number;
	if (payloadSize.value <= maxLocal) {
		localSize = payloadSize.value;
	} else {
		const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
		const remainder = (payloadSize.value - minLocal) % (usableSize - 4);
		localSize = minLocal + remainder;
	}

	// Clamp local payload to what's actually available on this page
	const available = pageData.length - cursor;
	if (available <= 0) return null;
	const actualLocal = Math.min(localSize, available);
	const localPayload = pageData.subarray(cursor, cursor + actualLocal);

	if (payloadSize.value <= localSize) {
		// All inline — no overflow
		return { payload: Buffer.from(localPayload), rowId: rowIdResult.value };
	}

	// Overflow: first 4 bytes of stored portion = next overflow page number.
	// Need at least 4 bytes for the overflow pointer.
	if (localPayload.length < 4) return null;
	const overflowStart = localPayload.readUInt32BE(0);
	const result = Buffer.alloc(payloadSize.value);
	const payloadStart = localPayload.subarray(4);
	payloadStart.copy(result, 0, 0, payloadStart.length);

	let bytesCopied = payloadStart.length;
	let nextOverflowPage = overflowStart;
	let overflowPages = 0;

	while (bytesCopied < payloadSize.value && nextOverflowPage !== 0) {
		if (++overflowPages > MAX_OVERFLOW_PAGES) return null;
		const ovPage = readPage(fullFile, nextOverflowPage, header);
		// Overflow page: bytes 0-3 = next overflow page, bytes 4+ = payload content
		if (ovPage.length < 4) break;
		const nextOv = ovPage.readUInt32BE(0);
		const ovData = ovPage.subarray(4);
		const toCopy = Math.min(ovData.length, payloadSize.value - bytesCopied);
		ovData.copy(result, bytesCopied, 0, toCopy);
		bytesCopied += toCopy;
		nextOverflowPage = nextOv;
	}

	return { payload: result, rowId: rowIdResult.value };
}

// ── Column decoding ────────────────────────────────────────────

/**
 * Decode a single column from a SQLite record.
 * Record format: [header-size varint] [serial-type*] [body bytes...]
 */
function decodeColumn(record: Buffer, columnIndex: number): string | null {
	const headerSizeResult = readVarint(record, 0);
	const headerSize = headerSizeResult.value;
	let cursor = headerSizeResult.bytesRead;
	const bodyStart = cursor + headerSize - headerSizeResult.bytesRead;

	let bodyOffset = bodyStart;
	for (let colIdx = 0; cursor < bodyStart && colIdx <= columnIndex; colIdx++) {
		const stResult = readVarint(record, cursor);
		cursor += stResult.bytesRead;
		const width = serialTypeWidth(stResult.value);

		if (colIdx === columnIndex) {
			return decodeColumnValue(record, stResult.value, bodyOffset, width);
		}

		bodyOffset += width;
	}

	return null;
}

/** Decode a single column value given its serial type, offset, and width. */
function decodeColumnValue(
	record: Buffer,
	serialType: number,
	offset: number,
	width: number,
): string | null {
	if (serialType === SERIAL_NULL) return null;

	// TEXT or BLOB (serial types >= 12)
	if (serialType >= 12) {
		return record.toString("utf8", offset, offset + width);
	}

	// Special zero-width ints
	if (width === 0) {
		return serialType === SERIAL_INT0 ? "0" : "1";
	}

	// Float
	if (serialType === SERIAL_FLOAT64) {
		return String(record.readDoubleBE(offset));
	}

	// Integer (1, 2, 3, 4, 6, or 8 bytes)
	let intVal = 0;
	for (let b = 0; b < width; b++) {
		intVal = (intVal << 8) | record.readUInt8(offset + b);
	}
	return String(intVal);
}

/** Push valid child page numbers of an interior page onto the stack. */
function pushChildPages(stack: number[], page: BtreePage, maxPage: number): void {
	for (const cell of page.cells) {
		if (cell.leftChild !== undefined && cell.leftChild > 0 && cell.leftChild <= maxPage) {
			stack.push(cell.leftChild);
		}
	}
	if (page.rightMostPtr > 0 && page.rightMostPtr <= maxPage) {
		stack.push(page.rightMostPtr);
	}
}

// ── WAL support ────────────────────────────────────────────────

/** WAL magic values. 0x377f0682 = little-endian checksums, 0x377f0683 = big-endian. */
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;

/** Parsed WAL header (first 32 bytes). */
interface WalHeader {
	/** True when frame checksums are computed in little-endian byte order. */
	littleEndian: boolean;
	pageSize: number;
	salt1: number;
	salt2: number;
}

/**
 * Parse the WAL header. Returns undefined when the file is not a valid
 * WAL (missing, empty, wrong magic, or unsupported page size).
 */
function parseWalHeader(wal: Buffer): WalHeader | undefined {
	if (wal.length < WAL_HEADER_SIZE) return undefined;
	const magic = wal.readUInt32BE(0);
	if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) return undefined;
	const pageSize = wal.readUInt32BE(8);
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
		return undefined;
	}
	return {
		littleEndian: magic === WAL_MAGIC_LE,
		pageSize,
		salt1: wal.readUInt32BE(16),
		salt2: wal.readUInt32BE(20),
	};
}

/**
 * Extend a WAL checksum over `buf` (a multiple of 8 bytes).
 * Mirrors SQLite's walChecksumBytes().
 */
function walChecksumExtend(
	buf: Buffer,
	s1: number,
	s2: number,
	littleEndian: boolean,
): { s1: number; s2: number } {
	for (let i = 0; i < buf.length; i += 8) {
		const w1 = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
		const w2 = littleEndian ? buf.readUInt32LE(i + 4) : buf.readUInt32BE(i + 4);
		s1 = (s1 + w1 + s2) >>> 0;
		s2 = (s2 + w2 + s1) >>> 0;
	}
	return { s1, s2 };
}

/**
 * Merge the companion `-wal` file into the main database buffer.
 *
 * Walks the WAL frames in order, verifying each frame's salt and checksum,
 * and overlays the newest committed page image onto the main buffer. This
 * lets the reader observe the newest committed ItemTable values even when
 * the main file has not yet been checkpointed.
 *
 * Returns the merged buffer when the WAL is fully processed, a
 * `{ buffer, incomplete: true }` result when the frame cap is reached
 * (a valid WAL with more frames than the bound), or `undefined` when
 * the WAL exists but cannot be parsed (malformed or wrong page size).
 */
function mergeWalIntoDatabase(
	dbPath: string,
	dbBuffer: Buffer,
	header: SqliteHeader,
): { buffer: Buffer; incomplete: boolean } | undefined {
	const walPath = `${dbPath}-wal`;
	let wal: Buffer;
	try {
		wal = fs.readFileSync(walPath);
	} catch {
		// No WAL file — main-file snapshot is authoritative.
		return { buffer: dbBuffer, incomplete: false };
	}

	const walHeader = parseWalHeader(wal);
	if (!walHeader) {
		// A WAL file exists but is not a valid WAL — treat as unreadable.
		return undefined;
	}
	if (walHeader.pageSize !== header.pageSize) {
		return undefined;
	}

	const frameSize = walHeader.pageSize + WAL_FRAME_HEADER_SIZE;
	const availableFrames = Math.floor((wal.length - WAL_HEADER_SIZE) / frameSize);
	const capped = availableFrames > MAX_WAL_FRAMES;
	const maxFrames = capped ? MAX_WAL_FRAMES : availableFrames;

	let { s1, s2 } = walChecksumExtend(wal.subarray(0, 24), 0, 0, walHeader.littleEndian);
	if (s1 !== wal.readUInt32BE(24) || s2 !== wal.readUInt32BE(28)) {
		return undefined;
	}

	// Overlay the newest committed page image for each frame.
	const merged = Buffer.from(dbBuffer);
	const ctx: WalMergeContext = {
		wal,
		frameSize,
		walHeader,
		header,
		merged,
	};
	let offset = WAL_HEADER_SIZE;
	for (let frame = 0; frame < maxFrames; frame++) {
		const frameResult = applyWalFrame(ctx, offset, s1, s2);
		if (!frameResult.valid) return undefined;
		s1 = frameResult.s1;
		s2 = frameResult.s2;
		offset += frameSize;
	}

	return { buffer: merged, incomplete: capped };
}

/** Shared state for applying WAL frames to the merged database image. */
interface WalMergeContext {
	wal: Buffer;
	frameSize: number;
	walHeader: WalHeader;
	header: SqliteHeader;
	merged: Buffer;
}

/**
 * Apply a single WAL frame to the merged database image.
 * Returns the updated checksum state, or `valid: false` when the frame
 * fails its salt or checksum validation (stop merging).
 */
function applyWalFrame(
	ctx: WalMergeContext,
	frameStart: number,
	s1: number,
	s2: number,
): { valid: boolean; s1: number; s2: number } {
	const { wal, frameSize, walHeader, header, merged } = ctx;
	const pgno = wal.readUInt32BE(frameStart);
	const dbSize = wal.readUInt32BE(frameStart + 4);
	const salt1 = wal.readUInt32BE(frameStart + 8);
	const salt2 = wal.readUInt32BE(frameStart + 12);
	const storedC1 = wal.readUInt32BE(frameStart + 16);
	const storedC2 = wal.readUInt32BE(frameStart + 20);

	// Frame is valid only when salts match the WAL header.
	if (salt1 !== walHeader.salt1 || salt2 !== walHeader.salt2) {
		return { valid: false, s1, s2 };
	}

	const input = Buffer.concat([
		wal.subarray(frameStart, frameStart + 8),
		wal.subarray(frameStart + WAL_FRAME_HEADER_SIZE, frameStart + frameSize),
	]);
	const ck = walChecksumExtend(input, s1, s2, walHeader.littleEndian);
	if (ck.s1 !== storedC1 || ck.s2 !== storedC2) {
		return { valid: false, s1, s2 };
	}

	// Overlay the page image (respecting the reserved-byte tail).
	if (pgno >= 1) {
		const pageOffset = (pgno - 1) * header.pageSize;
		const usableSize = header.pageSize - header.reservedBytes;
		if (pageOffset + usableSize <= merged.length) {
			wal
				.subarray(
					frameStart + WAL_FRAME_HEADER_SIZE,
					frameStart + WAL_FRAME_HEADER_SIZE + usableSize,
				)
				.copy(merged, pageOffset);
		}
	}

	// A commit frame (dbSize != 0) may shrink the database image.
	if (dbSize !== 0 && dbSize * header.pageSize < merged.length) {
		merged.fill(0, dbSize * header.pageSize);
	}

	return { valid: true, s1: ck.s1, s2: ck.s2 };
}

// ── Snapshot identity ──────────────────────────────────────────

/**
 * Compute a stable identity for a database snapshot.
 *
 * The identity combines the file path, size, mtime, and a content hash of
 * the first page (which contains the schema root). This guards against a
 * database replacement that preserves the path and metadata values but
 * points at a different file — the schema cache is invalidated when the
 * identity changes.
 */
function computeSnapshotIdentity(dbPath: string, buffer: Buffer, stat: fs.Stats): string {
	const firstPage = buffer.subarray(0, Math.min(buffer.length, 4096));
	const hash = crypto.createHash("sha1").update(firstPage).digest("hex").slice(0, 16);
	return `${dbPath}:${stat.size}:${stat.mtimeMs}:${hash}`;
}

/**
 * Compute a WAL-aware snapshot identity that also reflects the companion
 * `-wal` file. The main-file identity alone is insufficient because a WAL
 * frame can overlay a later page without changing the first-page hash.
 */
function computeWalAwareIdentity(dbPath: string, merged: Buffer, stat: fs.Stats): string {
	const base = computeSnapshotIdentity(dbPath, merged, stat);
	let walStat: fs.Stats | undefined;
	try {
		walStat = fs.statSync(`${dbPath}-wal`);
	} catch {
		return base;
	}
	return `${base}:wal:${walStat.size}:${walStat.mtimeMs}`;
}

// ── Public API ─────────────────────────────────────────────────

/** Cached ItemTable root page, keyed by snapshot identity. */
let _itemTableRootPage: number | undefined;
let _cachedIdentity: string | undefined;

/** Per-snapshot decoded key/value index. */
interface SnapshotIndex {
	identity: string;
	/** key → decoded value (column 1). */
	values: Map<string, string>;
	/** True when the index was built from a WAL-merged snapshot. */
	walMerged: boolean;
	/** True when the WAL was truncated at the frame cap and the snapshot may not contain the newest committed values. */
	incomplete: boolean;
}
let _snapshotIndex: SnapshotIndex | undefined;

/**
 * Read a single key's value from the `ItemTable` in a SQLite database file.
 *
 * Schema lookup (sqlite_master → ItemTable root page) happens once per
 * snapshot identity and is cached for subsequent calls on the same file.
 *
 * @param dbPath - Absolute path to the .vscdb file
 * @param key - The exact key to look up in ItemTable
 * @returns The value as a string, or undefined if the key doesn't exist
 */
export function readItemTableValue(dbPath: string, key: string): string | undefined {
	return readItemTableValueDetailed(dbPath, key).value;
}

/** Read a value and preserve the operational reason when no value is returned. */
export function readItemTableValueDetailed(
	dbPath: string,
	key: string,
	snapshot?: Buffer,
): SqliteReadResult {
	let buffer: Buffer;
	let identity: string | undefined;
	if (snapshot) {
		buffer = snapshot;
		identity = computeSnapshotIdentity(dbPath, buffer, {
			size: buffer.length,
			mtimeMs: 0,
		} as fs.Stats);
	} else {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(dbPath);
			buffer = fs.readFileSync(dbPath);
		} catch {
			return { diagnostic: "not-found" };
		}
		identity = computeSnapshotIdentity(dbPath, buffer, stat);
	}

	let header: SqliteHeader;
	try {
		header = parseHeader(buffer);
	} catch {
		return { diagnostic: "corrupt" };
	}

	// Resolve ItemTable root page (cached per snapshot identity).
	if (_itemTableRootPage === undefined || _cachedIdentity !== identity) {
		_itemTableRootPage = findItemTableRootPage(buffer, header);
		_cachedIdentity = identity;
	}

	if (_itemTableRootPage === undefined) return { diagnostic: "unsupported-schema" };

	// Per-snapshot index: decode every ItemTable row once per stable snapshot
	// instead of rescanning the B-tree for each requested key.
	if (_snapshotIndex?.identity !== identity) {
		const index = buildSnapshotIndex(buffer, _itemTableRootPage, header);
		if (!index) return { diagnostic: "corrupt" };
		_snapshotIndex = { identity, values: index, walMerged: false, incomplete: false };
	}

	const value = _snapshotIndex.values.get(key);
	if (value === undefined) return { diagnostic: "no-match" };
	return { value, diagnostic: "ok" };
}

/**
 * Read a value from a WAL-aware snapshot.
 *
 * Reads the main file, merges the companion `-wal` file (when present and
 * valid), and resolves the key against the merged snapshot. Returns a
 * distinct `wal-unreadable` diagnostic when a WAL file exists but cannot
 * be parsed, so callers can retry after a short delay.
 */
export function readItemTableValueWalAware(
	dbPath: string,
	key: string,
	snapshot?: Buffer,
): SqliteReadResult {
	let buffer: Buffer;
	let stat: fs.Stats | undefined;
	if (snapshot) {
		buffer = snapshot;
	} else {
		try {
			stat = fs.statSync(dbPath);
			buffer = fs.readFileSync(dbPath);
		} catch {
			return { diagnostic: "not-found" };
		}
	}

	let header: SqliteHeader;
	try {
		header = parseHeader(buffer);
	} catch {
		return { diagnostic: "corrupt" };
	}

	const merged = mergeWalIntoDatabase(dbPath, buffer, header);
	if (merged === undefined) {
		// A WAL file exists but could not be read — surface a distinct diagnostic.
		return { diagnostic: "wal-unreadable" };
	}

	const { buffer: mergedBuffer, incomplete: walIncomplete } = merged;

	const identity = computeWalAwareIdentity(
		dbPath,
		mergedBuffer,
		stat ?? ({ size: mergedBuffer.length, mtimeMs: 0 } as fs.Stats),
	);

	// Resolve ItemTable root page (cached per snapshot identity).
	if (_itemTableRootPage === undefined || _cachedIdentity !== identity) {
		_itemTableRootPage = findItemTableRootPage(mergedBuffer, header);
		_cachedIdentity = identity;
	}

	if (_itemTableRootPage === undefined) return { diagnostic: "unsupported-schema" };

	// Per-snapshot index.
	if (_snapshotIndex?.identity !== identity) {
		const index = buildSnapshotIndex(mergedBuffer, _itemTableRootPage, header);
		if (!index) return { diagnostic: "corrupt" };
		_snapshotIndex = { identity, values: index, walMerged: true, incomplete: walIncomplete };
	}

	const value = _snapshotIndex.values.get(key);
	if (value === undefined) return { diagnostic: "no-match" };
	return { value, diagnostic: _snapshotIndex.incomplete ? "wal-incomplete" : "ok" };
}

/**
 * Decode every ItemTable row into a key → value map.
 * Bounded by the same payload and visited-page limits as single-key reads.
 */
function buildSnapshotIndex(
	buffer: Buffer,
	rootPage: number,
	header: SqliteHeader,
): Map<string, string> | undefined {
	const maxPage = Math.ceil(buffer.length / header.pageSize);
	const visited = new Set<number>();
	const stack: number[] = [rootPage];
	const index = new Map<string, string>();

	while (stack.length > 0) {
		const pageNum = stack.pop();
		if (pageNum === undefined) continue;
		if (pageNum < 1 || pageNum > maxPage || visited.has(pageNum)) continue;
		visited.add(pageNum);
		if (visited.size > MAX_VISITED_PAGES) return undefined;

		const pageData = readPage(buffer, pageNum, header);
		const page = parseBtreePage(pageData, pageNum);
		if (!page) continue;

		if (page.type === "interior") {
			pushChildPages(stack, page, maxPage);
			continue;
		}

		if (!scanLeafIntoIndex(pageData, page.cells, buffer, header, index)) {
			return undefined;
		}
	}

	return index;
}

/**
 * Decode every cell on a leaf page into the index.
 * Returns false when a cell payload cannot be decoded (corrupt snapshot).
 */
function scanLeafIntoIndex(
	pageData: Buffer,
	cells: BtreeCell[],
	buffer: Buffer,
	header: SqliteHeader,
	index: Map<string, string>,
): boolean {
	for (const cell of cells) {
		const cp = readCellPayload(pageData, cell, buffer, header);
		if (!cp) continue;
		const cellKey = decodeColumn(cp.payload, 0);
		if (cellKey === null) continue;
		let value: string | undefined;
		try {
			value = decodeColumn(cp.payload, 1) ?? undefined;
		} catch {
			return false;
		}
		if (value !== undefined) {
			index.set(cellKey, value);
		}
	}
	return true;
}

/** Invalidate cached schema info so the next call re-reads sqlite_master. */
export function invalidateSchemaCache(): void {
	_itemTableRootPage = undefined;
	_cachedIdentity = undefined;
	_snapshotIndex = undefined;
}

/**
 * Scan sqlite_master (always page 1) for ItemTable's root page.
 * sqlite_master schema: type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT
 */
function findItemTableRootPage(buffer: Buffer, header: SqliteHeader): number | undefined {
	const page1Data = readPage(buffer, 1, header);
	const page1 = parseBtreePage(page1Data, 1);
	if (!page1) return undefined;

	for (const cell of page1.cells) {
		const cp = readCellPayload(page1Data, cell, buffer, header);
		if (!cp) continue;

		const type = decodeColumn(cp.payload, 0); // column 0: type
		const name = decodeColumn(cp.payload, 1); // column 1: name
		if (type === "table" && name === "ItemTable") {
			const rootPageStr = decodeColumn(cp.payload, 3); // column 3: rootpage
			if (rootPageStr !== null) {
				return Number.parseInt(rootPageStr, 10);
			}
		}
	}

	return undefined;
}
