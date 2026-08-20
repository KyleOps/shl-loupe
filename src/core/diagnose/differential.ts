/**
 * The differential diagnosis for an opaque fetch failure.
 *
 * When a cross-origin request fails, the browser hands JavaScript a bare
 * `TypeError`. There are five or six things that could have caused it, and no
 * client-side code can tell which. Guessing one and stating it as fact is what
 * every other viewer does, and it is why senders conclude their link is fine.
 *
 * So SHLoupe does the thing a competent engineer does at a whiteboard: lists the
 * candidate causes, ranks them by what else it knows about the URL and the
 * probes it was allowed to run, gives each a discriminating test, and says
 * plainly that the browser is withholding the answer. A ranked differential with
 * a next step per branch is more useful than a confident wrong answer, and it is
 * also honest.
 */
import { classifyHost, DEV_SERVER_PORTS } from './host';
import type { DiagnosisContext } from './context';

export type CauseId =
  | 'cors-missing'
  | 'cors-preflight-unimplemented'
  | 'dns-nxdomain'
  | 'connection-refused'
  | 'tls-untrusted'
  | 'tls-name-mismatch'
  | 'mixed-content'
  | 'firewall-or-captive-portal'
  | 'extension-or-tracking-protection'
  | 'server-hung'
  | 'host-unreachable-from-here';

export interface Cause {
  id: CauseId;
  /** 0 to 100. Relative plausibility given everything known, not a probability. */
  likelihood: number;
  title: string;
  /** Why this is or is not plausible here, in one or two sentences. */
  reasoning: string;
  /** The single cheapest test that would confirm or eliminate it. */
  discriminator: string;
  /** Who would have to fix it. */
  owner: 'sender' | 'server' | 'you' | 'network';
}

export interface ProbeResults {
  /**
   * A `mode: 'no-cors'` GET reached something. Proves a server answered, and
   * therefore that DNS, TCP and TLS all worked. Proves nothing about CORS.
   */
  opaqueGetSucceeded?: boolean;
  /** How long the failing request took before it gave up. */
  failureDurationMs?: number;
  /** A DNS-over-HTTPS lookup, if the user opted in. */
  dns?: { resolved: boolean; addresses?: string[]; status?: number };
  /** navigator.onLine at the time. False is conclusive; true means little. */
  online?: boolean;
}

/**
 * Rank the candidate causes.
 *
 * The scores are deliberately coarse. Their job is to order a list and to make
 * the reasoning visible, not to claim a precision no client-side tool has.
 */
export function differentialFor(context: DiagnosisContext, probes: ProbeResults): Cause[] {
  const { url, viewer } = context;
  const host = classifyHost(url.hostname);
  const causes: Cause[] = [];
  const crossOrigin = url.origin !== viewer.origin;
  const serverAnswered = probes.opaqueGetSucceeded === true;
  const fastFailure = (probes.failureDurationMs ?? 0) < 350;
  const devPort = url.port !== '' && DEV_SERVER_PORTS[url.port] !== undefined;

  if (probes.online === false) {
    causes.push({
      id: 'firewall-or-captive-portal',
      likelihood: 100,
      title: 'This device is offline.',
      reasoning: 'The browser reports no network connection at all.',
      discriminator: 'Load any other site.',
      owner: 'you',
    });
    return causes;
  }

  if (viewer.protocol === 'https:' && url.protocol === 'http:') {
    causes.push({
      id: 'mixed-content',
      likelihood: 100,
      title: 'The browser blocked the request before it left, as mixed content.',
      reasoning:
        'This page is https and the target is http. No request was made, so nothing about the server is being tested here.',
      discriminator: 'None needed: this is decided inside the browser, and it is certain.',
      owner: 'sender',
    });
    return causes;
  }

  if (serverAnswered) {
    // A no-cors probe that returned means DNS, TCP and TLS all worked, which
    // leaves CORS as very nearly the only explanation.
    causes.push({
      id: 'cors-missing',
      likelihood: 92,
      title: 'The server is up, but does not allow this page to read its responses.',
      reasoning:
        'A probe request reached the server and came back, so name resolution, the TCP connection and the TLS handshake all succeeded. What failed is the browser handing the result to this page, which is exactly what a missing Access-Control-Allow-Origin does.',
      discriminator: `Run the OPTIONS preflight from a shell and look for Access-Control-Allow-Origin in the response. curl succeeds either way, because CORS is enforced only by browsers.`,
      owner: 'server',
    });
    causes.push({
      id: 'cors-preflight-unimplemented',
      likelihood: 70,
      title: 'The server may answer POST but not the OPTIONS preflight before it.',
      reasoning:
        'A manifest POST carries Content-Type: application/json, so the browser sends OPTIONS first. Frameworks routinely route POST and leave OPTIONS to fall through to a 404 or a 405, which fails the whole request before the POST is ever sent.',
      discriminator: 'The OPTIONS curl below: a 404 or 405 there is conclusive.',
      owner: 'server',
    });
    return sortCauses(causes);
  }

  if (probes.dns?.resolved === false) {
    causes.push({
      id: 'dns-nxdomain',
      likelihood: 95,
      title: 'That host name does not resolve.',
      reasoning: `A DNS-over-HTTPS lookup for ${url.hostname} returned no address, so there is nothing to connect to from anywhere on the public internet.`,
      discriminator: `dig +short ${url.hostname}`,
      owner: 'sender',
    });
    return sortCauses(causes);
  }

  // Nothing conclusive: build the ranked list from static signals.
  if (host.reach === 'loopback' || host.reach === 'private-network') {
    causes.push({
      id: 'host-unreachable-from-here',
      likelihood: 99,
      title: 'The address is not reachable from this machine at all.',
      reasoning: `${host.because} Nothing was ever going to answer, so the other causes below are moot.`,
      discriminator: `curl -v ${url.origin}/ from this machine will fail the same way.`,
      owner: 'sender',
    });
    return sortCauses(causes);
  }

  causes.push({
    id: 'cors-missing',
    likelihood: crossOrigin ? 55 : 5,
    title: 'The server answered, but without the CORS headers a browser needs.',
    reasoning: crossOrigin
      ? 'The most common cause by a wide margin for a request that works in curl and fails in every browser. The specification for SMART Health Links does not mandate CORS, so plenty of conformant servers simply have not configured it.'
      : 'The request is same-origin, so CORS does not apply.',
    discriminator: 'Run the OPTIONS preflight below and look for Access-Control-Allow-Origin.',
    owner: 'server',
  });

  causes.push({
    id: 'connection-refused',
    likelihood: devPort ? 60 : fastFailure ? 45 : 25,
    title: 'Nothing is listening on that port.',
    reasoning: devPort
      ? `Port ${url.port} is ${DEV_SERVER_PORTS[url.port]}, so the target is probably a development server that is not running right now.`
      : fastFailure
        ? `The request failed in ${probes.failureDurationMs} ms. A refused connection fails almost immediately, whereas DNS and TLS problems usually take longer.`
        : 'Possible, though the timing does not particularly suggest it.',
    discriminator: `curl -v --connect-timeout 5 ${url.origin}/`,
    owner: 'sender',
  });

  causes.push({
    id: 'tls-untrusted',
    likelihood: devPort ? 50 : host.isIpLiteral ? 55 : 20,
    title: 'The certificate is not trusted by this browser.',
    reasoning: devPort
      ? 'A development server serving https usually presents a self-signed or locally generated certificate. It is trusted on the machine that created it and nowhere else, which is why the link opens for its author and for nobody else.'
      : host.isIpLiteral
        ? 'The host is a bare IP address, and publicly trusted certificates for IPs are rare, so a name mismatch is likely.'
        : 'Possible if the certificate has expired or is issued by a private authority.',
    discriminator: `Open ${url.origin} directly in a new tab. A certificate problem shows an interstitial you can read, which fetch never does.`,
    owner: 'sender',
  });

  causes.push({
    id: 'dns-nxdomain',
    likelihood: probes.dns?.resolved === true ? 2 : 25,
    title: 'The host name does not resolve.',
    reasoning:
      probes.dns?.resolved === true
        ? 'Ruled out: a DNS-over-HTTPS lookup found an address for this name.'
        : 'Not yet tested. Enable the DNS check to settle this without leaving the page.',
    discriminator: `dig +short ${url.hostname}`,
    owner: 'sender',
  });

  causes.push({
    id: 'extension-or-tracking-protection',
    likelihood: 12,
    title: 'A browser extension or tracking protection blocked it.',
    reasoning:
      'Content blockers and enterprise policy extensions cancel requests in a way indistinguishable from a network failure to the page.',
    discriminator: 'Retry in a private window with extensions disabled.',
    owner: 'you',
  });

  causes.push({
    id: 'firewall-or-captive-portal',
    likelihood: 10,
    title: 'The network you are on blocks it.',
    reasoning:
      'Conference and hospital networks intercept or drop traffic to unusual ports and unfamiliar hosts, and a captive portal will silently swallow anything until you sign in.',
    discriminator: 'Retry on a phone hotspot.',
    owner: 'network',
  });

  return sortCauses(causes);
}

function sortCauses(causes: Cause[]): Cause[] {
  return [...causes].sort((a, b) => b.likelihood - a.likelihood);
}

/** The sentence the UI leads with above the differential. */
export function differentialPreamble(browserMessage: string | undefined, engine?: string): string {
  const quoted = browserMessage === undefined ? 'a bare failure' : `"${browserMessage}"`;
  return `The browser reported ${quoted}${engine === undefined ? '' : `, which is ${engine}'s wording for a transport-level failure`}, and that is genuinely all it will say. Browsers withhold the cause of a cross-origin failure on purpose, because a page that could tell the difference between "refused" and "no such host" would be a port scanner. So the cause has to be narrowed by other means.`;
}
