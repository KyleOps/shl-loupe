/**
 * The one seam between the pipeline and the network.
 *
 * Everything the pipeline knows about HTTP goes through this interface, which
 * buys three things that matter more than the indirection costs:
 *
 *  - Offline mode is a transport, not a special case. Paste a manifest and the
 *    pipeline runs unchanged against a transport that serves it from memory.
 *  - A test is a transport. No mocking of globals, no network in CI.
 *  - Every request is recorded in one place, so nothing can quietly reach the
 *    network without appearing in the trace. That is a privacy guarantee this
 *    tool makes to its user, and a seam is how you keep it true.
 */

export interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Sent as fetch's `mode`. 'no-cors' is only used by probes. */
  mode?: RequestMode;
  /** Abort after this many milliseconds. */
  timeoutMs?: number;
  /** What this request is for, used in the trace label. */
  purpose: 'manifest' | 'direct-file' | 'manifest-file' | 'jwks' | 'probe';
}

export interface TransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Only the headers script is allowed to read. See `readableHeaderNote`. */
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  responseType: string;
  redirected: boolean;
  finalUrl: string;
  durationMs: number;
}

export type NetworkFailureKind =
  | 'blocked-by-browser' // an opaque failure: CORS, DNS, TLS, refused, extension
  | 'timeout'
  | 'aborted'
  | 'mixed-content' // we knew before trying
  | 'invalid-url'
  | 'too-large'
  | 'offline'; // navigator.onLine said so, or the offline transport refused

export class NetworkFailure extends Error {
  constructor(
    message: string,
    readonly kind: NetworkFailureKind,
    readonly durationMs: number,
    /** The browser's own message, verbatim, because it differs per engine. */
    readonly browserMessage?: string,
  ) {
    super(message);
    this.name = 'NetworkFailure';
  }
}

export interface Transport {
  readonly name: string;
  send(request: TransportRequest): Promise<TransportResponse>;
}

/**
 * What a browser lets script read from a cross-origin response.
 *
 * Worth stating in the UI every time, because a reader who sees three headers
 * where curl shows twenty will otherwise conclude the server sent three.
 */
export const CORS_SAFELISTED_RESPONSE_HEADERS = [
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',
] as const;

export function readableHeaderNote(sameOrigin: boolean): string {
  return sameOrigin
    ? 'Same-origin response: every header is readable.'
    : 'Cross-origin response. A browser only exposes the seven CORS-safelisted headers plus any the server names in Access-Control-Expose-Headers, so the server almost certainly sent more than is shown here.';
}
