/**
 * The static rule set: everything Loupe can tell you before it touches the
 * network.
 *
 * Each rule has a stable id, because ids are what a report quotes and what a
 * conversation can refer to ("your link trips SHL-URL-LOOPBACK") without
 * re-litigating the wording. Wording is still the product: every `title` is one
 * plain sentence a non-specialist can act on, and every `audience` names who
 * has to do something, since the argument at an event is always about whose
 * problem it is.
 */
import { CITATIONS } from '../citations';
import type { Finding } from '../trace';
import type { DiagnosisContext } from './context';
import { classifyHost, DEV_SERVER_PORTS, reachIsUnreachableByOthers } from './host';

export type RuleOutput = Omit<Finding, 'id' | 'stepId'>;

export interface Rule {
  id: string;
  /** One line describing what the rule looks for, shown in the Learn screen. */
  about: string;
  evaluate(context: DiagnosisContext): RuleOutput | undefined;
}

const relative = (seconds: number): string => {
  const abs = Math.abs(seconds);
  const units: Array<[number, string]> = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const count = Math.round(abs / size);
      return `${count} ${name}${count === 1 ? '' : 's'}`;
    }
  }
  return `${Math.round(abs)} seconds`;
};

/**
 * Characters that are invisible or illegal in a URL. Written as escapes rather
 * than literals so the rule itself cannot be broken by an editor helpfully
 * normalising whitespace.
 */
const INVISIBLE = new RegExp(
  `[${[
    0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x20, 0xa0, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff,
  ]
    .map((code) => `\\u${code.toString(16).padStart(4, '0')}`)
    .join('')}]`,
);

export const STATIC_RULES: Rule[] = [
  // -------------------------------------------------------------------------
  // Reachability. The rules that end arguments.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-URL-LOOPBACK',
    about: 'The manifest URL points at the loopback interface.',
    evaluate: ({ url, viewer }) => {
      const host = classifyHost(url.hostname);
      if (host.reach !== 'loopback') return undefined;
      const viewerIsLocal = viewer.hostname === 'localhost' || viewer.hostname.startsWith('127.');
      return {
        ruleId: 'SHL-URL-LOOPBACK',
        severity: 'fatal',
        audience: 'sender',
        title: 'This link points at the sender’s own machine, so nobody else can open it.',
        detail: `The manifest URL is ${url.origin}. ${host.because} "localhost" always means the computer running the browser, so this link resolves to ${viewerIsLocal ? 'this machine, which is not where the data is' : 'your machine, not the sender’s'}. Three separate things then stop it, and any one of them is fatal on its own. Nothing is listening: on your machine that port is almost certainly closed, so the connection is refused before anything else is attempted. The browser blocks it anyway: since Chrome 142, a page on a public site may not reach a loopback or private-network address without an explicit permission prompt, and Chrome reports that refusal as a CORS error, which sends people looking for a missing server header that would not help. And the certificate cannot be trusted: a local development server presents a certificate signed by a root that exists only on the machine that made it, so even with a server listening and the permission granted the TLS handshake fails for everybody else. That is why it works for its author and for nobody else. It is not a viewer defect, and no viewer can work around it.`,
        remedy:
          'The link has to be re-issued with a manifest URL that is reachable from the internet: a deployed relay, or a tunnel such as cloudflared or ngrok if it is only needed today, remembering that a tunnel URL dies with the tunnel. Meanwhile you can still see what is in this link: run the manifest request yourself with the command below and paste the result into Offline mode.',
        citation: CITATIONS.payloadUrl,
      };
    },
  },
  {
    id: 'SHL-URL-PRIVATE-NETWORK',
    about: 'The manifest URL points at a private, link-local or carrier-NAT address.',
    evaluate: ({ url }) => {
      const host = classifyHost(url.hostname);
      if (
        host.reach !== 'private-network' &&
        host.reach !== 'link-local' &&
        host.reach !== 'carrier-nat'
      ) {
        return undefined;
      }
      return {
        ruleId: 'SHL-URL-PRIVATE-NETWORK',
        severity: 'fatal',
        audience: 'sender',
        title:
          'The manifest address is on a private network, reachable only from the sender’s network.',
        detail: `${url.hostname} is not routable across the internet. ${host.because} If you are on the same office network or VPN as the sender it may work; from anywhere else it cannot.`,
        remedy:
          'Either both parties join the same network, or the sender publishes the manifest on a public host.',
        citation: CITATIONS.payloadUrl,
      };
    },
  },
  {
    id: 'SHL-URL-UNRESOLVABLE-NAME',
    about:
      'The host name cannot resolve outside one network (mDNS, a single label, or a special-use suffix).',
    evaluate: ({ url }) => {
      const host = classifyHost(url.hostname);
      if (host.reach !== 'mdns-or-single-label' && host.reach !== 'special-use') return undefined;
      return {
        ruleId: 'SHL-URL-UNRESOLVABLE-NAME',
        severity: 'fatal',
        audience: 'sender',
        title: 'That host name does not exist on the public internet.',
        detail: `${url.hostname} cannot be looked up from outside the sender’s own network. ${host.because}`,
        remedy: 'Re-mint the link against a publicly resolvable name.',
        citation: CITATIONS.payloadUrl,
      };
    },
  },
  {
    id: 'SHL-URL-OVERLAY-NETWORK',
    about: 'The host resolves publicly but only routes inside an overlay network.',
    evaluate: ({ url }) => {
      const host = classifyHost(url.hostname);
      if (host.reach !== 'overlay-network') return undefined;
      return {
        ruleId: 'SHL-URL-OVERLAY-NETWORK',
        severity: 'fatal',
        audience: 'sender',
        title: `This address only routes inside the sender’s ${host.provider ?? 'overlay'} network.`,
        detail: `${url.hostname} looks like an ordinary name and may even resolve for you, but the address behind it is reachable only from devices joined to the same ${host.provider ?? 'overlay'} network. ${host.because}`,
        remedy: `Either you join that ${host.provider ?? 'overlay'} network, or the sender exposes the manifest on the public internet.`,
      };
    },
  },
  {
    id: 'SHL-URL-EPHEMERAL-TUNNEL',
    about: 'The host is a temporary tunnel that will stop resolving.',
    evaluate: ({ url }) => {
      const host = classifyHost(url.hostname);
      if (host.reach !== 'ephemeral-tunnel') return undefined;
      return {
        ruleId: 'SHL-URL-EPHEMERAL-TUNNEL',
        severity: 'warning',
        audience: 'sender',
        title: `This link depends on a temporary ${host.provider ?? 'tunnel'} address.`,
        detail: `${url.hostname} is a ${host.provider ?? 'tunnel'} host. It works while the tunnel is up and the sender’s process is running, and it dies with either. A link like this is fine for a live demo and useless as something to send and open later.`,
        remedy:
          'For a link that must survive the session, publish the manifest on a stable host. For a live demo, keep the tunnel open and expect the link to expire with it.',
      };
    },
  },
  {
    id: 'SHL-URL-PREVIEW-DEPLOYMENT',
    about: 'The host is a per-commit preview deployment.',
    evaluate: ({ url }) => {
      const host = classifyHost(url.hostname);
      if (host.reach !== 'preview-deployment') return undefined;
      return {
        ruleId: 'SHL-URL-PREVIEW-DEPLOYMENT',
        severity: 'info',
        audience: 'sender',
        title: `This is a ${host.provider ?? 'per-commit'} preview deployment, not a stable address.`,
        detail: `${url.hostname} carries a build identifier, so it names one deployment rather than the service. It stays up for now, but the next deploy gets a different name, and a link minted against this one keeps pointing at the old build.`,
        remedy: 'Mint links against the production alias instead.',
      };
    },
  },

  // -------------------------------------------------------------------------
  // Scheme, port and mixed content.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-URL-NOT-HTTPS',
    about: 'The manifest URL is not https.',
    evaluate: ({ url, viewer }) => {
      if (url.protocol === 'https:') return undefined;
      const blockedByMixedContent = viewer.protocol === 'https:' && url.protocol === 'http:';
      return {
        ruleId: 'SHL-URL-NOT-HTTPS',
        severity: blockedByMixedContent ? 'fatal' : 'error',
        audience: 'sender',
        title:
          url.protocol === 'http:'
            ? 'The manifest URL is plain http, which carries health data in the clear.'
            : `The manifest URL uses the ${url.protocol} scheme, which is not http or https.`,
        detail: blockedByMixedContent
          ? 'This page is served over https, and a browser blocks an https page from making an http request (mixed content). The request is refused inside the browser and never reaches the network, so nothing the sender configures on their server can fix it while this viewer runs on https.'
          : 'SMART Health Links carry health data, and the specification requires https. Over http the manifest, and every encrypted file it names, crosses the network readable by anything on the path.',
        remedy: blockedByMixedContent
          ? 'Ask the sender for an https URL. As a local workaround, run this viewer over http on localhost, where the browser permits http requests.'
          : 'Serve the manifest over https.',
        citation: CITATIONS.payloadUrl,
      };
    },
  },
  {
    id: 'SHL-URL-DEV-PORT',
    about: 'The URL uses a well-known development server port.',
    evaluate: ({ url }) => {
      const description = url.port ? DEV_SERVER_PORTS[url.port] : undefined;
      if (!description) return undefined;
      // On loopback this adds nothing: the loopback rule already said it all.
      if (classifyHost(url.hostname).reach === 'loopback') return undefined;
      return {
        ruleId: 'SHL-URL-DEV-PORT',
        severity: 'info',
        audience: 'sender',
        title: `Port ${url.port} is ${description}.`,
        detail:
          'The link points at a development server rather than a published endpoint. That is normal at a testing event, and worth knowing because such a server usually runs on somebody’s laptop, restarts often, and rarely carries the CORS headers a browser-based viewer needs.',
      };
    },
  },
  {
    id: 'SHL-URL-IP-LITERAL',
    about: 'The URL uses a public IP address rather than a host name.',
    evaluate: ({ url }) => {
      const host = classifyHost(url.hostname);
      if (!host.isIpLiteral || host.reach !== 'public') return undefined;
      return {
        ruleId: 'SHL-URL-IP-LITERAL',
        severity: 'warning',
        audience: 'sender',
        title: 'The manifest is addressed by IP, which https certificates rarely cover.',
        detail: `${url.hostname} is an address, not a name. A publicly trusted certificate for a bare IP is unusual, so the TLS handshake will probably fail on a name mismatch, and a browser reports that as an ordinary connection failure with no detail.`,
        remedy: 'Use the DNS name the certificate was issued for.',
      };
    },
  },

  // -------------------------------------------------------------------------
  // URL hygiene.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-URL-USERINFO',
    about: 'The URL embeds credentials.',
    evaluate: ({ url }) => {
      if (!url.username && !url.password) return undefined;
      return {
        ruleId: 'SHL-URL-USERINFO',
        severity: 'error',
        audience: 'sender',
        title: 'The manifest URL has a username and password embedded in it.',
        detail:
          'Browsers refuse to fetch a URL that carries credentials, so this link cannot be opened by any browser-based viewer regardless of what the server would have done with it.',
        remedy:
          'Move authentication out of the URL, or make the manifest endpoint unauthenticated and rely on the link key and passcode as the specification intends.',
      };
    },
  },
  {
    id: 'SHL-URL-FRAGMENT',
    about: 'The manifest URL carries a fragment.',
    evaluate: ({ url }) => {
      if (!url.hash) return undefined;
      return {
        ruleId: 'SHL-URL-FRAGMENT',
        severity: 'warning',
        audience: 'sender',
        title: 'The manifest URL has a fragment, which is never sent to the server.',
        detail: `Everything from the "#" onwards (${url.hash}) stays in the client. If the sender put an identifier there, the server never sees it, and the request looks to it like a request for something else entirely.`,
        remedy: 'Move that value into the path or the query string.',
      };
    },
  },
  {
    id: 'SHL-URL-INVISIBLE-CHARACTER',
    about: 'The raw URL contains whitespace or an invisible character.',
    evaluate: ({ rawUrl }) => {
      const hit = INVISIBLE.exec(rawUrl);
      if (!hit) return undefined;
      const codePoint = hit[0].codePointAt(0) ?? 0;
      return {
        ruleId: 'SHL-URL-INVISIBLE-CHARACTER',
        severity: 'error',
        audience: 'sender',
        title: 'The manifest URL contains an invisible or illegal character.',
        detail: `The character at position ${hit.index} is U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}, which is not printable. A zero-width space or a non-breaking space picked up from a document, a slide or a chat client breaks the request while the URL looks perfectly normal on screen.`,
        remedy: 'Re-mint the link from a clean string.',
      };
    },
  },

  // -------------------------------------------------------------------------
  // Time.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-EXP-PAST',
    about: 'The link expired.',
    evaluate: ({ link, now }) => {
      if (link?.exp === undefined) return undefined;
      const seconds = link.exp - now / 1000;
      if (seconds >= 0) return undefined;
      return {
        ruleId: 'SHL-EXP-PAST',
        severity: 'fatal',
        audience: 'sender',
        title: `This link expired ${relative(seconds)} ago.`,
        detail: `The payload sets exp to ${link.exp}, which is ${new Date(link.exp * 1000).toISOString()}. A conformant sharing server refuses the manifest request from that moment on, so the link is dead regardless of everything else in it. Loupe reads this from the link itself, with no request made and no clock involved but yours.`,
        remedy:
          'Ask for a fresh link. If the sender believes it is current, compare clocks: an expiry set in the wrong timezone, or in milliseconds, is the usual cause.',
        citation: CITATIONS.payloadExp,
      };
    },
  },
  {
    id: 'SHL-EXP-IMMINENT',
    about: 'The link expires within the hour.',
    evaluate: ({ link, now }) => {
      if (link?.exp === undefined) return undefined;
      const seconds = link.exp - now / 1000;
      if (seconds < 0 || seconds > 3600) return undefined;
      return {
        ruleId: 'SHL-EXP-IMMINENT',
        severity: 'warning',
        audience: 'you',
        title: `This link expires in ${relative(seconds)}.`,
        detail:
          'Open it now. If you plan to demonstrate from it later, ask for one with a longer life.',
        citation: CITATIONS.payloadExp,
      };
    },
  },
  {
    id: 'SHL-EXP-MILLISECONDS',
    about: 'exp looks like milliseconds rather than seconds.',
    evaluate: ({ link }) => {
      if (link?.exp === undefined || link.exp < 1e11) return undefined;
      return {
        ruleId: 'SHL-EXP-MILLISECONDS',
        severity: 'error',
        audience: 'sender',
        title: 'The expiry is in milliseconds, but the specification counts seconds.',
        detail: `exp is ${link.exp}. Read as seconds, that is ${new Date(link.exp * 1000).toISOString()}, thousands of years out. The sender almost certainly passed Date.now() where Date.now()/1000 was wanted, so the link never expires and every receiver reads a different intent from it.`,
        remedy: 'Divide by 1000 when minting.',
        citation: CITATIONS.payloadExp,
      };
    },
  },
  {
    id: 'SHL-EXP-LONG-LIVED',
    about: 'A long expiry without the L flag.',
    evaluate: ({ link, now }) => {
      if (link?.exp === undefined) return undefined;
      const seconds = link.exp - now / 1000;
      if (seconds < 31_536_000 || link.flags.includes('L')) return undefined;
      return {
        ruleId: 'SHL-EXP-LONG-LIVED',
        severity: 'info',
        audience: 'sender',
        title: 'This link lives for more than a year but is not flagged long-term.',
        detail:
          'The L flag tells a receiving app the link is worth storing and polling for updates. Without it, a wallet may treat a year-long link as a one-off.',
        citation: CITATIONS.flagL,
      };
    },
  },

  // -------------------------------------------------------------------------
  // The two constraints on the URL itself that almost nobody implements.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-URL-TOO-LONG',
    about: 'The manifest URL exceeds the 128-character cap.',
    evaluate: ({ link }) => {
      if (link === undefined || link.url.length <= 128) return undefined;
      return {
        ruleId: 'SHL-URL-TOO-LONG',
        severity: 'warning',
        audience: 'sender',
        title: `The manifest URL is ${link.url.length} characters, and the cap is 128.`,
        detail:
          'The specification caps the url member (not the whole link) at 128 characters, so that a link stays inside a QR code that scans comfortably. Nothing will refuse this link over it, but it makes the QR denser than intended and the constraint exists for a reason.',
        remedy:
          'Shorten the manifest path, or put the identifier in the path rather than a long query.',
        citation: CITATIONS.payloadUrl,
      };
    },
  },
  {
    id: 'SHL-URL-LOW-ENTROPY',
    about: 'The manifest URL looks guessable, where 256 bits of entropy are required.',
    evaluate: ({ url, link }) => {
      if (link === undefined) return undefined;
      const secret = guessableSecretPart(url);
      if (secret === undefined) return undefined;
      return {
        ruleId: 'SHL-URL-LOW-ENTROPY',
        severity: 'error',
        audience: 'sender',
        title: 'The manifest URL is guessable, so other people’s links can be enumerated.',
        detail: `The specification requires the url to carry at least 256 bits of entropy, because the URL is the only thing standing between a stranger and the manifest: there is no authentication in this protocol. Here the identifying part is ${secret.description}, which is ${secret.reason}. Anyone who has seen one link from this server can walk the range and pull the manifests for links that were never shared with them. This is a privacy defect rather than a connectivity one, so it will not stop the link working, and it matters more.`,
        remedy:
          'Mint the identifier from a cryptographically random 32-byte value, base64url encoded, rather than from a database key or a counter.',
        citation: CITATIONS.payloadUrl,
      };
    },
  },
  {
    id: 'SHL-VERSION-UNSUPPORTED',
    about: 'The payload declares a protocol version this viewer does not implement.',
    evaluate: ({ link }) => {
      if (link?.version === undefined) return undefined;
      const value = Number(link.version);
      if (Number.isFinite(value) && value <= 1) return undefined;
      return {
        ruleId: 'SHL-VERSION-UNSUPPORTED',
        severity: 'error',
        audience: 'you',
        title: `This link declares protocol version ${String(link.version)}, and Loupe implements version 1.`,
        detail:
          'The specification tells a receiver that meets a version it does not know to say so and to stop, rather than to make a manifest request and guess at the response. Loupe will show you everything it can read statically and will not proceed on assumptions.',
        citation: CITATIONS.payloadV,
      };
    },
  },

  // -------------------------------------------------------------------------
  // Flags.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-FLAG-P',
    about: 'The link requires a passcode.',
    evaluate: ({ link }) => {
      if (!link?.flags.includes('P')) return undefined;
      return {
        ruleId: 'SHL-FLAG-P',
        severity: 'info',
        audience: 'you',
        title: 'This link needs a passcode, sent separately by whoever shared it.',
        detail:
          'The P flag means the sharing server refuses the manifest request until the right passcode accompanies it. The passcode is not in the link and cannot be derived from it, and the specification requires the server to enforce a total lifetime count of wrong attempts and then disable the link permanently. So guessing does not cost you a retry, it costs the patient their link.',
        citation: CITATIONS.flagP,
      };
    },
  },
  {
    id: 'SHL-FLAG-U-AND-P',
    about: 'U and P together, which cannot work.',
    evaluate: ({ link }) => {
      if (!link?.flags.includes('U') || !link.flags.includes('P')) return undefined;
      return {
        ruleId: 'SHL-FLAG-U-AND-P',
        severity: 'error',
        audience: 'sender',
        title: 'The U and P flags contradict each other.',
        detail:
          'U means the URL is fetched directly with a GET and there is no manifest exchange at all. P means a passcode is submitted in the manifest request. With no manifest request, there is nowhere to put the passcode.',
        remedy: 'Drop one of the two flags.',
        citation: CITATIONS.flagU,
      };
    },
  },
  {
    id: 'SHL-FLAG-U',
    about: 'The link is a direct file link.',
    evaluate: ({ link }) => {
      if (!link?.flags.includes('U')) return undefined;
      return {
        ruleId: 'SHL-FLAG-U',
        severity: 'info',
        audience: 'nobody',
        title: 'This is a direct link: one file, fetched with a GET, no manifest.',
        detail:
          'The U flag says the url points straight at a single encrypted file rather than at a manifest endpoint. Loupe issues a GET instead of a POST, which also means no recipient string and no embeddedLengthMax are sent.',
        citation: CITATIONS.flagU,
      };
    },
  },

  // -------------------------------------------------------------------------
  // What is about to happen on the network.
  // -------------------------------------------------------------------------
  {
    id: 'SHL-CORS-PREFLIGHT-EXPECTED',
    about: 'A cross-origin manifest POST needs a CORS preflight.',
    evaluate: ({ url, viewer, link }) => {
      if (url.origin === viewer.origin) return undefined;
      // No point explaining what the browser will ask of a server that will
      // never be reached: a reachability rule has already said the request is
      // not going to happen, and stacking a second explanation on top of it
      // dilutes the one that matters.
      if (reachIsUnreachableByOthers(classifyHost(url.hostname).reach)) return undefined;
      const direct = link?.flags.includes('U') === true;
      return {
        ruleId: 'SHL-CORS-PREFLIGHT-EXPECTED',
        severity: 'info',
        audience: 'server',
        title: `${url.host} has to allow this browser to read its response.`,
        detail: direct
          ? `This is a cross-origin GET from ${viewer.origin || 'this page'} to ${url.origin}. The browser hands the body to this page only if the response carries Access-Control-Allow-Origin.`
          : `A manifest request is a POST with Content-Type: application/json, which is not a simple request, so the browser sends an OPTIONS preflight to ${url.origin} first. The server has to answer that preflight with Access-Control-Allow-Origin, Access-Control-Allow-Methods including POST, and Access-Control-Allow-Headers including content-type. If it does not, the browser blocks the request and reports nothing beyond a generic failure. Native apps are unaffected, which is why one link can work in a phone app and fail in every browser.`,
        citation: CITATIONS.cors,
      };
    },
  },
];

/**
 * Decide whether anything in a manifest URL could plausibly carry 256 bits of
 * entropy, and if not, name the part that is failing to.
 *
 * This matters more than it looks. A SMART Health Link manifest endpoint has no
 * authentication of any kind: the unguessability of the URL IS the access
 * control. A sequential database id in a query parameter therefore exposes every
 * other link the same server has ever issued, and it is a very common shape
 * because it is the natural thing to write.
 *
 * The question asked is "does ANY component look big enough", not "is the
 * longest component big enough". Getting that backwards makes a structural path
 * segment like "shl-manifest" outrank the actual identifier and hides the
 * finding, which is exactly the bug the first version of this had. And when
 * reporting, a decimal counter is called out ahead of a merely short token, even
 * when the counter is the shorter of the two: "the neighbouring values are other
 * people's links" is a sharper thing to be told.
 *
 * 256 bits needs about 43 base64url characters. The threshold here is
 * deliberately lower (22 characters, about 128 bits) so that the rule fires only
 * on URLs that are definitely guessable rather than on ones that merely fall
 * short of the letter of the specification.
 */
const ENTROPY_FLOOR_CHARACTERS = 22;

function guessableSecretPart(url: URL): { description: string; reason: string } | undefined {
  const candidates: Array<{ where: string; value: string }> = [];
  for (const [name, value] of url.searchParams) {
    candidates.push({ where: `the "${name}" query parameter`, value });
  }
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    candidates.push({ where: `the path segment "${segment}"`, value: segment });
  }

  if (candidates.length === 0) {
    return {
      description: 'absent: the URL carries no identifier at all',
      reason: 'a manifest URL with nothing unguessable in it is the same manifest for every reader',
    };
  }

  // If anything in the URL is long enough to be a real random identifier, the
  // link is fine, whatever else is alongside it.
  if (candidates.some((candidate) => candidate.value.length >= ENTROPY_FLOOR_CHARACTERS)) {
    return undefined;
  }

  const counter = candidates.find((candidate) => /^\d{1,12}$/.test(candidate.value));
  if (counter !== undefined) {
    return {
      description: `${counter.where}, the decimal number ${counter.value}`,
      reason:
        'a decimal counter, so the neighbouring values are almost certainly other people\u2019s links',
    };
  }

  const longest = [...candidates].sort((a, b) => b.value.length - a.value.length)[0];
  if (longest === undefined) return undefined;
  return {
    description: `${longest.where}, ${longest.value.length} characters long`,
    reason: `far short of the roughly 43 base64url characters that 256 bits of entropy needs`,
  };
}

const SEVERITY_ORDER: Record<RuleOutput['severity'], number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3,
  good: 4,
};

/** Run every static rule and return the findings, worst first. */
export function runStaticRules(context: DiagnosisContext): RuleOutput[] {
  return STATIC_RULES.map((rule) => rule.evaluate(context))
    .filter((finding): finding is RuleOutput => finding !== undefined)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** True when nothing further can usefully be attempted. */
export function isBlocking(findings: readonly RuleOutput[]): boolean {
  return findings.some((f) => f.severity === 'fatal');
}
