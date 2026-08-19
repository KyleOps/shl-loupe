/**
 * The browser transport, and the honest accounting of what it cannot see.
 *
 * A cross-origin `fetch` that fails gives JavaScript one thing: a `TypeError`
 * whose message differs per engine and says nothing about the cause. That is
 * deliberate on the browsers' part (a readable cause would be a port scanner),
 * so the correct behaviour for a diagnostic tool is not to guess, but to record
 * the exact message, say what the candidate causes are, and rank them using
 * everything else it knows.
 */
import { formatBytes } from '../bytes';
import type { HttpRequestRecord, HttpResponseRecord } from '../trace';
import {
  NetworkFailure,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/**
 * Verbatim first-failure messages from each engine, so the UI can say "this is
 * Safari's wording for a transport-level failure" instead of leaving the user to
 * search for it.
 */
export const OPAQUE_FETCH_MESSAGES: Record<string, string> = {
  'Failed to fetch': 'Chromium (Chrome, Edge, Brave, Arc)',
  'Load failed': 'WebKit (Safari, and every browser on iOS)',
  'NetworkError when attempting to fetch resource.': 'Gecko (Firefox)',
  'Network request failed': 'React Native and some embedded WebViews',
};

export function describeFetchEngine(message: string): string | undefined {
  for (const [needle, engine] of Object.entries(OPAQUE_FETCH_MESSAGES)) {
    if (message.includes(needle)) return engine;
  }
  return undefined;
}

export class BrowserTransport implements Transport {
  readonly name = 'browser';

  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        signal: controller.signal,
        // Nothing here is authenticated by cookie, and sending credentials to a
        // third-party manifest endpoint would be a needless privacy leak.
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new NetworkFailure(
          `The response declares ${formatBytes(declared)}, over the ${formatBytes(MAX_BODY_BYTES)} ceiling this viewer reads.`,
          'too-large',
          performance.now() - startedAt,
        );
      }
      // An opaque (`no-cors`) response has an unreadable body by design; reading
      // it yields the empty string rather than throwing.
      const body = response.type === 'opaque' ? '' : await response.text();
      if (body.length > MAX_BODY_BYTES) {
        throw new NetworkFailure(
          `The response body is ${formatBytes(body.length)}, over the ${formatBytes(MAX_BODY_BYTES)} ceiling this viewer reads.`,
          'too-large',
          performance.now() - startedAt,
        );
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        bodyBytes: new TextEncoder().encode(body).byteLength,
        responseType: response.type,
        redirected: response.redirected,
        finalUrl: response.url,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (error instanceof NetworkFailure) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        throw new NetworkFailure(
          `No response within ${(timeoutMs / 1000).toFixed(0)} seconds.`,
          'timeout',
          durationMs,
          message,
        );
      }
      throw new NetworkFailure(
        'The browser refused or could not complete the request, and will not say why.',
        'blocked-by-browser',
        durationMs,
        message,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The transport used by offline mode and by tests: it serves what it was given
 * and refuses everything else, out loud.
 *
 * This is what makes "paste the manifest you got from curl" a first-class path
 * rather than a special case bolted onto the side of the pipeline.
 */
export class OfflineTransport implements Transport {
  readonly name = 'offline';

  constructor(private readonly canned: Map<string, TransportResponse | string>) {}

  static withBodies(entries: Record<string, string>): OfflineTransport {
    return new OfflineTransport(new Map(Object.entries(entries)));
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const hit = this.canned.get(request.url) ?? this.canned.get(request.purpose);
    if (hit === undefined) {
      throw new NetworkFailure(
        `Offline: nothing was supplied for the ${request.purpose} step.`,
        'offline',
        0,
      );
    }
    if (typeof hit !== 'string') return hit;
    return {
      ok: true,
      status: 200,
      statusText: 'OK (supplied offline)',
      headers: { 'content-type': 'application/json' },
      body: hit,
      bodyBytes: new TextEncoder().encode(hit).byteLength,
      responseType: 'basic',
      redirected: false,
      finalUrl: request.url,
      durationMs: 0,
    };
  }
}

export function toRequestRecord(request: TransportRequest): HttpRequestRecord {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers ?? {},
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}

export function toResponseRecord(response: TransportResponse): HttpResponseRecord {
  const preview = response.body.slice(0, 2000);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    responseType: response.responseType,
    redirected: response.redirected,
    finalUrl: response.finalUrl,
    ...(preview.length > 0 ? { bodyPreview: preview } : {}),
    bodyBytes: response.bodyBytes,
    durationMs: response.durationMs,
  };
}

export function failureToResponseRecord(failure: NetworkFailure): HttpResponseRecord {
  return {
    status: 0,
    headers: {},
    responseType: 'error',
    durationMs: failure.durationMs,
    ...(failure.browserMessage === undefined ? {} : { networkError: failure.browserMessage }),
  };
}
