/**
 * Probes that narrow an opaque fetch failure, and honest accounting of the ones
 * that do not work.
 *
 * Every probe here was chosen from measurement rather than plausibility. Three
 * findings shaped the module:
 *
 *  1. The `no-cors` GET paired with the real CORS request is the one genuinely
 *     diagnostic probe available to a page with no backend. A manifest POST
 *     carries `content-type: application/json`, which is not CORS-safelisted, so
 *     it always takes the preflight branch. A `no-cors` GET does not. When the
 *     GET resolves and the POST rejects, the server is reachable and is not
 *     sending CORS headers, which is the most common real defect after loopback.
 *  2. Element probes (`<img>`, `<script>`, `<link>`) discriminate nothing. In
 *     measurement, `onerror` fired identically for a missing host, a refused
 *     port, an untrusted certificate and a 200 with the wrong content type.
 *     They are strictly dominated by the `no-cors` fetch, so they are not here.
 *  3. Chrome's Local Network Access check, on by default since Chrome 142,
 *     refuses a public page's request to loopback or a private address before it
 *     leaves the browser, and `no-cors` does not bypass it. So the probe pair is
 *     unavailable for exactly the targets it would be most tempting to use it
 *     on, and the tool has to say that rather than report "unreachable".
 */
import type { Transport, TransportResponse } from './transport';
import { NetworkFailure } from './transport';

export type TimingBand = 'immediate' | 'short' | 'long';

/**
 * Timing is only ever a confidence adjustment on a hypothesis formed some other
 * way, never primary evidence, and raw milliseconds are never presented as a
 * finding. A refused connection returns in single-digit milliseconds; a DNS or
 * TLS failure takes noticeably longer.
 */
export function timingBand(ms: number): TimingBand {
  if (ms < 50) return 'immediate';
  if (ms < 600) return 'short';
  return 'long';
}

export function describeTimingBand(band: TimingBand): string {
  switch (band) {
    case 'immediate':
      return 'The failure came back in under 50 milliseconds, which is the signature of something refused locally: a closed port, or a browser policy that stopped the request before it left.';
    case 'short':
      return 'The failure took long enough to have reached the network, which fits a connection that was made and then rejected.';
    default:
      return 'The failure took long enough to suggest a name lookup or a TLS handshake that did not complete, rather than an immediate refusal.';
  }
}

// ---------------------------------------------------------------------------
// Local Network Access
// ---------------------------------------------------------------------------

export type LnaSupport = 'enforced' | 'not-enforced' | 'unknown';

/**
 * Whether this browser enforces the Local Network Access check.
 *
 * Feature detection rather than a user-agent sniff: `targetAddressSpace` exists
 * on a Request only in the engine that implements the gate. Worth detecting
 * because Chromium delivers the refusal as a CORS policy error, so anybody
 * grepping the console for "CORS" concludes the server is missing a header,
 * when in fact no server header can fix it.
 */
export function detectLnaEnforcement(): LnaSupport {
  try {
    if ('targetAddressSpace' in new Request('https://example.org/')) return 'enforced';
    return 'not-enforced';
  } catch {
    return 'unknown';
  }
}

/** True for the address sets the Local Network Access check gates. */
export function isLnaGatedTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export type ReachabilityVerdict =
  | 'server-answered' // something responded: DNS, TCP and TLS all worked
  | 'nothing-answered' // nothing came back, and this probe cannot say why
  | 'blocked-by-policy' // the browser refused before the request left
  | 'not-attempted';

export interface ReachabilityResult {
  verdict: ReachabilityVerdict;
  durationMs: number;
  band: TimingBand;
  /** One sentence, honest about what this does and does not prove. */
  interpretation: string;
}

/**
 * A `no-cors` GET at the target origin.
 *
 * What a success proves: a server answered. Name resolution, the TCP connection
 * and the TLS handshake all completed. It says nothing about the status code,
 * nothing about the body (an opaque response has none readable), and nothing at
 * all about CORS.
 *
 * What a failure proves: nothing on its own. It narrows the field only in
 * combination with the real request having also failed.
 */
export async function probeReachability(
  transport: Transport,
  url: string,
): Promise<ReachabilityResult> {
  const target = new URL(url);
  if (isLnaGatedTarget(target.hostname) && detectLnaEnforcement() === 'enforced') {
    return {
      verdict: 'blocked-by-policy',
      durationMs: 0,
      band: 'immediate',
      interpretation:
        'This browser enforces the Local Network Access check, which refuses a request from a public page to a loopback or private address before it reaches the network. A no-cors probe does not bypass it, so there is nothing to learn by trying: the answer would be "refused" regardless of whether anything is listening.',
    };
  }

  const started = performance.now();
  try {
    const response = await transport.send({
      method: 'GET',
      url: target.origin + target.pathname,
      mode: 'no-cors',
      purpose: 'probe',
      timeoutMs: 6000,
    });
    const durationMs = Math.round(performance.now() - started);
    return {
      verdict: 'server-answered',
      durationMs,
      band: timingBand(durationMs),
      interpretation: `Something at ${target.origin} answered, so the host resolves, the port is open and the TLS handshake succeeded. The response is opaque by design, so its status and body are unreadable, and this says nothing about whether the server sends CORS headers. ${describeOpaqueResponse(response)}`,
    };
  } catch (error) {
    const durationMs =
      error instanceof NetworkFailure ? error.durationMs : Math.round(performance.now() - started);
    const band = timingBand(durationMs);
    return {
      verdict: 'nothing-answered',
      durationMs,
      band,
      interpretation: `Nothing at ${target.origin} answered a plain GET either. On its own that rules nothing in: this probe is only conclusive when it SUCCEEDS while the real request fails, which is what points at CORS. ${describeTimingBand(band)}`,
    };
  }
}

function describeOpaqueResponse(response: TransportResponse): string {
  return response.responseType === 'opaque'
    ? 'The browser marked the response opaque, which is the expected outcome for a no-cors request.'
    : `The response type was reported as "${response.responseType}".`;
}

/**
 * The verdict from the probe pair, which is the whole reason the probe exists.
 *
 * Measured truth table:
 *   probe resolves, real request rejects  -> reachable, and not sending CORS headers
 *   probe rejects,  real request rejects  -> nothing reached the server, or policy blocked it
 *   probe resolves, real request resolves -> working; any failure is above the transport
 */
export function combineProbePair(
  probe: ReachabilityVerdict,
  realRequestFailed: boolean,
): { conclusion: string; confidence: 'high' | 'medium' | 'low' } {
  if (probe === 'blocked-by-policy') {
    return {
      conclusion:
        'The browser refused both the probe and the request under its Local Network Access policy, so no conclusion about the server is available, and none is needed: a link that requires a stranger to grant a local-network permission is not a shareable link.',
      confidence: 'high',
    };
  }
  if (probe === 'server-answered' && realRequestFailed) {
    return {
      conclusion:
        'The server is up and answering, and the real request still failed. That combination is what a missing Access-Control-Allow-Origin looks like from inside a browser, and it is the most common defect in a sharing server after an unreachable host.',
      confidence: 'high',
    };
  }
  if (probe === 'nothing-answered' && realRequestFailed) {
    return {
      conclusion:
        'Neither the probe nor the request got an answer, so the failure is below CORS: the name, the port, the certificate or the network. The candidates below are ordered by what the URL itself suggests.',
      confidence: 'medium',
    };
  }
  return {
    conclusion: 'The probe found the server reachable and the request itself succeeded.',
    confidence: 'high',
  };
}

// ---------------------------------------------------------------------------
// DNS over HTTPS
// ---------------------------------------------------------------------------

export interface DnsResult {
  resolved: boolean;
  /** The DNS RCODE. 0 is NOERROR, 3 is NXDOMAIN. */
  status?: number;
  addresses?: string[];
  resolver: string;
  interpretation: string;
}

export const DOH_RESOLVERS = {
  cloudflare: {
    label: 'Cloudflare (1.1.1.1)',
    build: (name: string) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`,
    headers: { accept: 'application/dns-json' },
  },
  google: {
    label: 'Google (8.8.8.8)',
    build: (name: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`,
    headers: {},
  },
} as const;

export type DohResolver = keyof typeof DOH_RESOLVERS;

/**
 * Resolve a host name from the page, through a public DNS-over-HTTPS resolver.
 *
 * This is the one probe that talks to a third party, so it is opt-in, the
 * resolver is named in the UI, and the trace records the request like any other.
 * The host name being looked up is disclosed to that resolver, which is a real
 * (if small) privacy cost and is stated rather than buried.
 *
 * The `accept` header is CORS-safelisted, so this triggers no preflight.
 */
export async function probeDns(
  transport: Transport,
  hostname: string,
  which: DohResolver = 'cloudflare',
): Promise<DnsResult> {
  const resolver = DOH_RESOLVERS[which];
  try {
    const response = await transport.send({
      method: 'GET',
      url: resolver.build(hostname),
      headers: resolver.headers,
      purpose: 'probe',
      timeoutMs: 6000,
    });
    const body = JSON.parse(response.body) as {
      Status?: number;
      Answer?: Array<{ data?: string; type?: number }>;
    };
    const addresses = (body.Answer ?? [])
      .filter((answer) => answer.type === 1 || answer.type === 28)
      .map((answer) => answer.data)
      .filter((data): data is string => typeof data === 'string');
    const resolved = body.Status === 0 && addresses.length > 0;
    return {
      resolved,
      ...(body.Status === undefined ? {} : { status: body.Status }),
      ...(addresses.length > 0 ? { addresses } : {}),
      resolver: resolver.label,
      interpretation: resolved
        ? `${hostname} resolves publicly to ${addresses.join(', ')}, so the name exists and the failure is later in the chain: the port, the certificate, or CORS.`
        : body.Status === 3
          ? `${hostname} does not exist in public DNS (NXDOMAIN). Nobody outside the sender's own network can look this name up, whatever else is configured.`
          : `The resolver answered with DNS status ${String(body.Status)} and no address, so the name did not resolve.`,
    };
  } catch (error) {
    return {
      resolved: false,
      resolver: resolver.label,
      interpretation: `The DNS check itself could not be completed (${
        error instanceof Error ? error.message : String(error)
      }), so this says nothing about the host. On a captive-portal or filtered network the resolver is often the first thing blocked.`,
    };
  }
}

/**
 * `navigator.onLine`, which is worth exactly one thing.
 *
 * False is conclusive: there is no network. True means only that an interface is
 * up, which on a conference network with a captive portal is nearly meaningless.
 */
export function onlineHint(): { online: boolean; interpretation: string } {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  return {
    online,
    interpretation: online
      ? 'The browser reports a network connection, which only means an interface is up. It does not mean traffic is getting out, which on venue wifi behind a sign-in page is a distinction that matters.'
      : 'The browser reports no network connection at all, which explains every failure above and is the first thing to fix.',
  };
}
