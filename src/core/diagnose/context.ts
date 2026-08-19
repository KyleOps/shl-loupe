/**
 * What a static rule gets to look at.
 *
 * The viewer's OWN origin is part of the context, and that is not a detail. A
 * page served from `http://localhost:8080` by a port-forward may fetch other
 * `http://` origins; the same code served from `https://viewer.example.org` may
 * not, because the browser blocks mixed content before a request is made. Two
 * people running the same tool therefore get different, and both correct,
 * verdicts. Saying so is more useful than pretending there is one answer.
 */
import type { ShlLink } from '../shlink';

export interface ViewerOrigin {
  protocol: 'http:' | 'https:' | string;
  hostname: string;
  port: string;
  /** True when the browser treats this page as a secure context (WebCrypto works). */
  isSecureContext: boolean;
  origin: string;
}

export interface DiagnosisContext {
  /** The manifest or file URL under judgement, already parsed. */
  url: URL;
  /** The raw URL text, before parsing, so hygiene rules can see what was written. */
  rawUrl: string;
  link?: ShlLink;
  viewer: ViewerOrigin;
  /** Injected so tests are deterministic. */
  now: number;
}

export function viewerOriginFromLocation(location: Location): ViewerOrigin {
  return {
    protocol: location.protocol,
    hostname: location.hostname,
    port: location.port,
    isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : true,
    origin: location.origin,
  };
}

/** A stand-in for tests and for the deployed default. */
export const HTTPS_VIEWER: ViewerOrigin = {
  protocol: 'https:',
  hostname: 'loupe.example.org',
  port: '',
  isSecureContext: true,
  origin: 'https://loupe.example.org',
};
