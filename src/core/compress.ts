/**
 * DEFLATE, as JOSE and SHC use it.
 *
 * Both `zip: "DEF"` in a JWE header and the SHC JWS payload are RAW deflate, no
 * zlib header and no gzip wrapper. Getting that wrong produces a decode failure
 * that looks exactly like a wrong key, which is why this module reports which
 * of the three framings it found rather than just failing.
 */
import { inflateSync, unzlibSync, gunzipSync, deflateSync } from 'fflate';

export type CompressionFraming = 'raw-deflate' | 'zlib' | 'gzip' | 'none';

export interface InflateResult {
  bytes: Uint8Array;
  framing: CompressionFraming;
  /** Set when the framing was not the raw DEFLATE the specs require. */
  deviation?: string;
}

/**
 * Inflate a payload that is supposed to be raw DEFLATE, falling back through
 * zlib and gzip framings so the trace can name the actual mistake.
 */
export function inflateForgiving(data: Uint8Array): InflateResult {
  try {
    return { bytes: inflateSync(data), framing: 'raw-deflate' };
  } catch {
    // fall through
  }
  try {
    return {
      bytes: unzlibSync(data),
      framing: 'zlib',
      deviation:
        'The payload is zlib-framed DEFLATE (it starts with a 0x78 header). JOSE `zip:"DEF"` and SMART Health Cards both require RAW DEFLATE with no zlib header.',
    };
  } catch {
    // fall through
  }
  try {
    return {
      bytes: gunzipSync(data),
      framing: 'gzip',
      deviation:
        'The payload is gzip-framed. JOSE `zip:"DEF"` and SMART Health Cards both require raw DEFLATE, not gzip.',
    };
  } catch {
    throw new Error('The payload is not DEFLATE-compressed in any recognised framing.');
  }
}

export function deflateRawBytes(data: Uint8Array, level: 0 | 1 | 9 = 9): Uint8Array {
  return deflateSync(data, { level });
}
