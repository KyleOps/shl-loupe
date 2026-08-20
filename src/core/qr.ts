/**
 * QR, in both directions.
 *
 * Three things here are easy to get wrong and each has cost somebody an hour at
 * a table:
 *
 *  - **An SHL QR is just the URI text in byte mode.** There is no numeric-mode
 *    trick, no chunking and no ordinal prefix. All of that machinery belongs to
 *    SMART Health *Cards* (`shc:/`), which is why both codecs live in this one
 *    file: telling them apart is most of the job when someone hands you a QR.
 *  - **The output is an SVG string, not a canvas.** A QR at an event is either
 *    projected or printed, and both want vectors. The SVG is also plain enough
 *    to paste into a slide deck, which is what people actually do with it.
 *  - **The colours come from two custom properties, not from the encoder.**
 *    `qrcode`'s own SVG renderer writes hex fills, which would pin the code to
 *    one theme; this renderer emits `var(--qr-ink)` and `var(--qr-paper)` and
 *    lets the component supply them from the active theme's darkest and
 *    lightest tokens. A QR needs real contrast in one fixed direction, so that
 *    pairing is a deliberate choice rather than a token lookup.
 */
import { create as createQr } from 'qrcode';

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * Total data bits in a Version 22 symbol, per the SMART Health Cards FAQ's own
 * table. Version 22 is the size both specifications treat as the practical
 * ceiling: 105x105 modules, printed at 40mm square.
 */
export const V22_DATA_BITS = { L: 8048, M: 6256, Q: 4544, H: 3536 } as const;

/**
 * The version the specification asks a sender to aim at, with error correction
 * level M, which the SHL spec names explicitly ("Create the QR with Error
 * Correction Level M").
 */
export const SHL_QR_VERSION_TARGET = 22;
export const SHL_QR_ECC = 'M' as const;

/**
 * Byte-mode capacity of a V22 symbol at ECC M.
 *
 * 20 bits of overhead: a 4-bit mode indicator plus a 16-bit character count,
 * which is the count length byte mode uses from version 10 upwards.
 */
export const SHL_QR_COMFORTABLE_CHARS = Math.floor((V22_DATA_BITS.M - 20) / 8);

export interface QrCapacityVerdict {
  characters: number;
  version: number;
  /** Modules per side, which is what decides how big it has to be projected. */
  modules: number;
  /** 'pass' while it fits the target version, 'warn' past it, 'fail' past 40. */
  tone: 'pass' | 'warn' | 'fail';
  /** One plain sentence. Empty string when there is nothing to say. */
  note: string;
}

/**
 * What a payload of this length costs in QR terms.
 *
 * Version, not character count, is the number that matters: it decides the
 * module count, and a symbol past Version 22 needs either a bigger projection
 * or a better camera than the room has.
 */
export function describeQrCapacity(characters: number, version: number, modules: number): QrCapacityVerdict {
  if (version > SHL_QR_VERSION_TARGET) {
    return {
      characters,
      version,
      modules,
      tone: 'warn',
      note: `This is a Version ${version} symbol, ${modules} modules per side, past the Version ${SHL_QR_VERSION_TARGET} the specifications treat as the practical ceiling. It still scans from a screen held close; it will not scan reliably from a projector or a printed page at 40mm. A long label and a long viewer prefix are usually what pushed it up: ${characters} characters at error correction M fits Version ${SHL_QR_VERSION_TARGET} up to about ${SHL_QR_COMFORTABLE_CHARS}.`,
    };
  }
  return {
    characters,
    version,
    modules,
    tone: 'pass',
    note: `Version ${version}, ${modules} modules per side, error correction M. Comfortably inside the Version ${SHL_QR_VERSION_TARGET} ceiling.`,
  };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export interface QrEncodeResult {
  /** A complete, self-contained SVG element. Scales, prints, pastes. */
  svg: string;
  version: number;
  modules: number;
  capacity: QrCapacityVerdict;
  /** The exact text encoded, so a reader can check it is what they expected. */
  text: string;
}

export interface QrEncodeOptions {
  /** Quiet zone in modules. The standard is 4 and going below it breaks scans. */
  margin?: number;
}

/**
 * Encode a link (or any text) as a QR, at error correction level M.
 *
 * `qrcode`'s `create` is used for the matrix only, and the SVG is written here.
 * That is not reinvention: the library's renderer takes colours as hex strings
 * and emits a fixed-size image, and both of those are wrong for a themed,
 * projected tool.
 */
export function encodeShlQr(link: string, options: QrEncodeOptions = {}): QrEncodeResult {
  const text = link.trim();
  if (text.length === 0) throw new Error('There is nothing to encode.');
  const symbol = createQr(text, { errorCorrectionLevel: SHL_QR_ECC });
  const size = symbol.modules.size;
  const margin = options.margin ?? 4;
  const span = size + margin * 2;

  // One path for every dark module, as a run of absolute rectangles. A single
  // path keeps the SVG small enough to paste into a slide, and crispEdges stops
  // a fractional scale factor blurring the module boundaries on a projector.
  let path = '';
  for (let row = 0; row < size; row += 1) {
    let run = 0;
    for (let column = 0; column <= size; column += 1) {
      const dark = column < size && symbol.modules.data[row * size + column] === 1;
      if (dark) {
        run += 1;
        continue;
      }
      if (run > 0) {
        path += `M${column - run + margin} ${row + margin}h${run}v1h-${run}z`;
        run = 0;
      }
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}"`,
    ` width="100%" height="100%" shape-rendering="crispEdges" role="img"`,
    ` aria-label="QR code, Version ${symbol.version}, ${size} modules per side">`,
    `<rect width="${span}" height="${span}" fill="var(--qr-paper)"/>`,
    `<path d="${path}" fill="var(--qr-ink)"/>`,
    `</svg>`,
  ].join('');

  return {
    svg,
    version: symbol.version,
    modules: size,
    capacity: describeQrCapacity(text.length, symbol.version, size),
    text,
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export interface QrDecodeResult {
  /** The decoded text, verbatim. */
  text: string;
  /** The barcode symbology, so a Data Matrix does not get called a QR. */
  format: string;
}

/**
 * Decode the first barcode in an image.
 *
 * The zxing import is dynamic, and so is the WASM URL, for two separate
 * reasons. Dynamic keeps a WASM binary and its glue out of the main bundle, so
 * the page that only pastes a link never pays for the scanner. The `?url`
 * import makes Vite emit the binary as a local asset: zxing-wasm's default
 * `locateFile` pulls it from a CDN, and this tool promises to render with the
 * network unplugged.
 */
export async function decodeQrFromImage(image: Blob | ImageData): Promise<QrDecodeResult> {
  const [{ prepareZXingModule, readBarcodes }, wasm] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({ overrides: { locateFile: () => wasm.default } });

  const results = await readBarcodes(image, {
    formats: ['QRCode', 'MicroQRCode', 'RMQRCode', 'DataMatrix', 'Aztec'],
    tryHarder: true,
    maxNumberOfSymbols: 1,
  });
  const first = results.find((result) => result.isValid && result.text.length > 0);
  if (!first) throw new QrNotFoundError();
  return { text: first.text, format: first.format };
}

/**
 * Thrown when an image carries no readable barcode.
 *
 * Its own class because a scanning loop hits this on almost every frame, and
 * "no code in this frame yet" must never be presented to a person as an error.
 */
export class QrNotFoundError extends Error {
  constructor() {
    super('No barcode was found in this image.');
    this.name = 'QrNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// The shc:/ numeric encoding, and its chunked form
// ---------------------------------------------------------------------------

/**
 * The lowest character that can appear in a compact JWS is `-` (ordinal 45), so
 * subtracting 45 puts the whole JWS alphabet in the range 0 to 77, which is two
 * base-ten digits per character. That constant is the entire trick.
 */
const SHC_ORDINAL_OFFSET = 45;

/** Any JWS longer than this cannot fit a Version 22 symbol at ECC level L. */
export const SHC_SINGLE_QR_MAX = 1195;
/** The per-chunk cap the specification sets once chunking is used at all. */
export const SHC_CHUNK_MAX = 1191;

export function shcNumericEncode(jws: string): string {
  let digits = '';
  for (const character of jws) {
    const value = character.codePointAt(0);
    if (value === undefined || value < 45 || value > 122) {
      throw new Error(
        `"${character}" cannot appear in a compact JWS, so it has no two-digit numeric encoding.`,
      );
    }
    digits += (value - SHC_ORDINAL_OFFSET).toString().padStart(2, '0');
  }
  return digits;
}

export function shcNumericDecode(digits: string): string {
  if (!/^\d*$/.test(digits)) throw new Error('The numeric segment contains something other than digits.');
  if (digits.length % 2 !== 0) {
    throw new Error('The numeric segment has an odd number of digits, so the scan lost a character.');
  }
  let jws = '';
  for (let index = 0; index < digits.length; index += 2) {
    const pair = digits.slice(index, index + 2);
    const code = Number(pair) + SHC_ORDINAL_OFFSET;
    if (code > 122) {
      throw new Error(
        `The digit pair "${pair}" at position ${index} maps to ${code}, outside the compact JWS alphabet. Pairs run 00 to 77; anything above that is corruption or a numeric payload that is not a health card.`,
      );
    }
    jws += String.fromCharCode(code);
  }
  return jws;
}

/**
 * Split a JWS into `shc:/` QR payloads.
 *
 * A JWS that fits one symbol gets the unchunked form, because chunking is
 * deprecated and a single-chunk `shc:/1/1/` prefix is a shape some scanners
 * have never seen. Past that, chunks are balanced rather than greedy: the
 * specification asks for two 600-character chunks over a 1191 and a 9, and an
 * unbalanced set fails on the small symbol nobody framed properly.
 */
export function splitShcQrChunks(jws: string): string[] {
  const digits = shcNumericEncode(jws);
  if (jws.length <= SHC_SINGLE_QR_MAX) return [`shc:/${digits}`];

  const total = Math.ceil(jws.length / SHC_CHUNK_MAX);
  const per = Math.ceil(jws.length / total);
  const chunks: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const slice = jws.slice(index * per, (index + 1) * per);
    chunks.push(`shc:/${index + 1}/${total}/${shcNumericEncode(slice)}`);
  }
  return chunks;
}

export interface ShcJoinResult {
  jws: string;
  /** How many chunks the set declared. 1 for the unchunked form. */
  total: number;
  /** Deviations worth reporting, in plain words. Never fatal on its own. */
  notes: string[];
}

/**
 * Reassemble a scanned `shc:/` chunk set, in any order.
 *
 * Order-independence is required of a consumer ("SHOULD allow for scanning the
 * multiple QR codes in any order"), and it is also the only usable behaviour:
 * nobody scans three codes taped to a laptop lid in the order the producer
 * numbered them.
 */
export function joinShcQrChunks(scans: readonly string[]): ShcJoinResult {
  if (scans.length === 0) throw new Error('No chunks were supplied.');
  const notes: string[] = [];
  const parsed = scans.map((scan) => parseShcQr(scan.trim()));

  const totals = new Set(parsed.map((chunk) => chunk.total));
  if (totals.size > 1) {
    throw new Error(
      `These scans disagree on how many chunks there are (${[...totals].sort().join(' and ')}), so they are from different cards.`,
    );
  }
  const total = parsed[0]?.total ?? 1;
  if (total > 1) {
    notes.push(
      'Chunked QRs were deprecated in December 2022. A card this size is better shared as a SMART Health Link.',
    );
  }

  const byIndex = new Map<number, string>();
  for (const chunk of parsed) {
    const existing = byIndex.get(chunk.index);
    if (existing !== undefined && existing !== chunk.digits) {
      throw new Error(`Two different scans both claim to be chunk ${chunk.index} of ${total}.`);
    }
    byIndex.set(chunk.index, chunk.digits);
  }

  const missing: number[] = [];
  for (let index = 1; index <= total; index += 1) if (!byIndex.has(index)) missing.push(index);
  if (missing.length > 0) {
    throw new Error(
      `Chunk ${missing.join(', ')} of ${total} ${missing.length === 1 ? 'is' : 'are'} still missing, so the card cannot be assembled yet.`,
    );
  }

  let jws = '';
  const lengths: number[] = [];
  for (let index = 1; index <= total; index += 1) {
    const part = shcNumericDecode(byIndex.get(index) as string);
    lengths.push(part.length);
    jws += part;
  }

  const longest = Math.max(...lengths);
  const shortest = Math.min(...lengths);
  if (total > 1 && longest > shortest * 2) {
    notes.push(
      `The chunks are unbalanced (${lengths.join(', ')} characters). The specification asks a producer to even them out, because the smallest symbol is the one that fails to scan.`,
    );
  }
  if (!jws.startsWith('eyJ')) {
    notes.push(
      'The assembled value does not start with "eyJ", so it is not a base64url-encoded JSON header. Either a chunk is in the wrong place or this is not a compact JWS.',
    );
  }
  return { jws, total, notes };
}

interface ParsedShcChunk {
  index: number;
  total: number;
  digits: string;
}

export function parseShcQr(scan: string): ParsedShcChunk {
  if (!scan.toLowerCase().startsWith('shc:/')) {
    throw new Error('This is not an "shc:/" QR payload.');
  }
  let body = scan.slice('shc:/'.length);
  let index = 1;
  let total = 1;
  const ordinal = /^(\d+)\/(\d+)\//.exec(body);
  if (ordinal) {
    index = Number(ordinal[1]);
    total = Number(ordinal[2]);
    body = body.slice(ordinal[0].length);
    if (index < 1 || index > total) {
      throw new Error(`The ordinal says chunk ${index} of ${total}, which cannot be right. Chunks are numbered from 1.`);
    }
  }
  if (!/^\d+$/.test(body)) {
    throw new Error('The part after "shc:/" is not all digits, so this is not the numeric encoding.');
  }
  return { index, total, digits: body };
}

/**
 * Recognise what a scanned QR actually contains.
 *
 * A scanner that only knows one form is where "this QR does not work" comes
 * from, and the honest answer is usually "that is a health card, not a link".
 */
export type ScannedKind = 'shlink' | 'shlink-in-text' | 'shc' | 'other';

export interface ScanClassification {
  kind: ScannedKind;
  /** The extracted payload text for the recognised kinds. */
  value: string;
  /** Text surrounding the payload, when the QR carried more than the link. */
  context?: string;
}

/**
 * The extraction rule generalises the one KTC states: find the `shlink:/`
 * substring and ignore whatever surrounds it. That makes a QR reading
 * "Patient summary for J. Argonaut https://viewer.example/#shlink:/ey…" work,
 * and reports the prose rather than choking on it.
 */
export function classifyScan(text: string): ScanClassification {
  const trimmed = text.trim();
  const shlink = /shlink:\/{1,2}[A-Za-z0-9_-]+/.exec(trimmed);
  if (shlink) {
    const matched = shlink[0];
    const surrounding = (trimmed.slice(0, shlink.index) + trimmed.slice(shlink.index + matched.length))
      .replace(/^https?:\/\/\S*#$/, '')
      .trim();
    const isBare = trimmed === matched || /^https?:\/\/\S*#$/.test(trimmed.slice(0, shlink.index));
    return {
      kind: isBare ? 'shlink' : 'shlink-in-text',
      value: trimmed.slice(0, shlink.index).endsWith('#')
        ? trimmed.slice(0, shlink.index) + matched
        : matched,
      ...(surrounding === '' || isBare ? {} : { context: surrounding }),
    };
  }
  if (/^shc:\//i.test(trimmed)) return { kind: 'shc', value: trimmed };
  return { kind: 'other', value: trimmed };
}
