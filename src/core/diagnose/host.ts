/**
 * Host classification, with no network involved.
 *
 * Most links that fail at an event fail for a reason that is fully visible in
 * the URL. This module is the part of SHLoupe that turns "type load fail" into
 * "this points at your own machine".
 */

export type HostReach =
  | 'public' // anyone on the internet can try
  | 'loopback' // only the machine that minted it
  | 'private-network' // only devices on the same LAN or VPN
  | 'link-local'
  | 'carrier-nat'
  | 'special-use' // reserved by RFC for documentation, testing and the like
  | 'mdns-or-single-label' // resolvable only inside one network's naming
  | 'overlay-network' // resolves publicly but routes only inside an overlay, e.g. Tailscale
  | 'ephemeral-tunnel' // works today, gone tomorrow
  | 'preview-deployment'; // a per-commit deploy URL

export interface HostClassification {
  reach: HostReach;
  /** True when the host is an IP literal rather than a name. */
  isIpLiteral: boolean;
  family?: 'ipv4' | 'ipv6';
  /** The matched rule, for the trace. */
  because: string;
  /** The service or convention that owns this pattern, when there is one. */
  provider?: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Tunnels and cloud dev environments: reachable now, meaningless later. */
const EPHEMERAL_SUFFIXES: Array<{ suffix: string; provider: string }> = [
  { suffix: '.ngrok.io', provider: 'ngrok' },
  { suffix: '.ngrok-free.app', provider: 'ngrok' },
  { suffix: '.ngrok.app', provider: 'ngrok' },
  { suffix: '.ngrok.dev', provider: 'ngrok' },
  { suffix: '.trycloudflare.com', provider: 'Cloudflare quick tunnel' },
  { suffix: '.loca.lt', provider: 'localtunnel' },
  { suffix: '.serveo.net', provider: 'serveo' },
  { suffix: '.telebit.io', provider: 'telebit' },
  { suffix: '.lhr.life', provider: 'localhost.run' },
  { suffix: '.devtunnels.ms', provider: 'Visual Studio dev tunnels' },
  { suffix: '.githubpreview.dev', provider: 'GitHub Codespaces' },
  { suffix: '.app.github.dev', provider: 'GitHub Codespaces' },
  { suffix: '.gitpod.io', provider: 'Gitpod' },
  { suffix: '.repl.co', provider: 'Replit' },
  { suffix: '.replit.dev', provider: 'Replit' },
  { suffix: '.csb.app', provider: 'CodeSandbox' },
  { suffix: '.stackblitz.io', provider: 'StackBlitz' },
  { suffix: '.webcontainer.io', provider: 'StackBlitz' },
  { suffix: '.e2b.dev', provider: 'E2B' },
];

const SPECIAL_USE_SUFFIXES = [
  '.test',
  '.example',
  '.invalid',
  '.localhost',
  '.home.arpa',
  '.internal',
  '.intranet',
  '.lan',
  '.corp',
  '.private',
];

export function classifyHost(hostname: string): HostClassification {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return {
      reach: 'loopback',
      isIpLiteral: host !== 'localhost',
      ...(host === 'localhost' ? {} : { family: 'ipv6' as const }),
      because: 'The host is the loopback interface.',
    };
  }

  const v4 = host.match(IPV4);
  if (v4) {
    const octets = v4.slice(1, 5).map((o) => Number.parseInt(o, 10));
    const [a, b] = octets as [number, number, number, number];
    const base = { isIpLiteral: true, family: 'ipv4' as const };
    if (a === 127) return { ...base, reach: 'loopback', because: '127.0.0.0/8 is loopback.' };
    if (a === 0) return { ...base, reach: 'special-use', because: '0.0.0.0/8 is "this network".' };
    if (a === 10)
      return { ...base, reach: 'private-network', because: '10.0.0.0/8 is private (RFC 1918).' };
    if (a === 172 && b >= 16 && b <= 31)
      return { ...base, reach: 'private-network', because: '172.16.0.0/12 is private (RFC 1918).' };
    if (a === 192 && b === 168)
      return {
        ...base,
        reach: 'private-network',
        because: '192.168.0.0/16 is private (RFC 1918).',
      };
    if (a === 169 && b === 254)
      return { ...base, reach: 'link-local', because: '169.254.0.0/16 is link-local (RFC 3927).' };
    if (a === 100 && b >= 64 && b <= 127)
      return {
        ...base,
        reach: 'carrier-nat',
        because: '100.64.0.0/10 is shared address space for carrier NAT (RFC 6598).',
      };
    if (a === 192 && b === 0 && octets[2] === 2)
      return {
        ...base,
        reach: 'special-use',
        because: '192.0.2.0/24 is reserved for documentation.',
      };
    if (a === 198 && (b === 18 || b === 19))
      return {
        ...base,
        reach: 'special-use',
        because: '198.18.0.0/15 is reserved for benchmarking.',
      };
    if (a === 203 && b === 0 && octets[2] === 113)
      return {
        ...base,
        reach: 'special-use',
        because: '203.0.113.0/24 is reserved for documentation.',
      };
    if (a >= 224)
      return {
        ...base,
        reach: 'special-use',
        because: `${a}.0.0.0/4 and above are multicast or reserved.`,
      };
    return { ...base, reach: 'public', because: 'A public IPv4 literal.' };
  }

  if (host.includes(':')) {
    const base = { isIpLiteral: true, family: 'ipv6' as const };
    if (
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    )
      return { ...base, reach: 'link-local', because: 'fe80::/10 is IPv6 link-local.' };
    if (/^f[cd]/.test(host))
      return {
        ...base,
        reach: 'private-network',
        because: 'fc00::/7 is an IPv6 unique local address.',
      };
    if (host === '::')
      return { ...base, reach: 'special-use', because: ':: is the unspecified address.' };
    return { ...base, reach: 'public', because: 'A public IPv6 literal.' };
  }

  // Tailscale: the name resolves on the public DNS, but the address behind it
  // is a 100.64.0.0/10 tailnet address, so only the sender's devices can reach it.
  if (host.endsWith('.ts.net')) {
    return {
      reach: 'overlay-network',
      isIpLiteral: false,
      because: 'A *.ts.net name is a Tailscale tailnet host.',
      provider: 'Tailscale',
    };
  }

  for (const { suffix, provider } of EPHEMERAL_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return {
        reach: 'ephemeral-tunnel',
        isIpLiteral: false,
        because: `${suffix} names a temporary tunnel.`,
        provider,
      };
    }
  }

  if (host.endsWith('.local')) {
    return {
      reach: 'mdns-or-single-label',
      isIpLiteral: false,
      because: '.local is multicast DNS: it only resolves on the same network segment.',
    };
  }
  if (host.endsWith('.onion') || host.endsWith('.i2p')) {
    return {
      reach: 'overlay-network',
      isIpLiteral: false,
      because: `${host.endsWith('.onion') ? '.onion' : '.i2p'} needs an overlay-network client to resolve.`,
      provider: host.endsWith('.onion') ? 'Tor' : 'I2P',
    };
  }
  for (const suffix of SPECIAL_USE_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return {
        reach: 'special-use',
        isIpLiteral: false,
        because: `${suffix} is a special-use or private-use name, not resolvable on the public internet.`,
      };
    }
  }
  if (!host.includes('.')) {
    return {
      reach: 'mdns-or-single-label',
      isIpLiteral: false,
      because: 'A single-label host name resolves only through a local search domain.',
    };
  }

  // Per-commit deploy hosts. A bare production host on the same platform is
  // fine, so only the shapes that carry a build identifier are called out.
  const preview = classifyPreviewDeployment(host);
  if (preview) return preview;

  return { reach: 'public', isIpLiteral: false, because: 'A public DNS name.' };
}

function classifyPreviewDeployment(host: string): HostClassification | undefined {
  const label = host.split('.')[0] ?? '';
  if (host.endsWith('.vercel.app')) {
    // Production aliases are short and stable; previews carry a git ref or a
    // deployment hash, for example my-app-git-feature-team.vercel.app.
    if (/-git-/.test(label) || /-[a-z0-9]{9,}(-[a-z0-9-]+)?$/.test(label)) {
      return {
        reach: 'preview-deployment',
        isIpLiteral: false,
        because:
          'The subdomain carries a git ref or deployment hash, which is a per-deploy preview URL.',
        provider: 'Vercel',
      };
    }
  }
  if (host.endsWith('.netlify.app') && /^(deploy-preview-\d+|[a-f0-9]{8,})--/.test(label)) {
    return {
      reach: 'preview-deployment',
      isIpLiteral: false,
      because: 'This is a Netlify deploy-preview host.',
      provider: 'Netlify',
    };
  }
  if (host.endsWith('.pages.dev') && /^[a-f0-9]{8}\./.test(host)) {
    return {
      reach: 'preview-deployment',
      isIpLiteral: false,
      because: 'A hashed subdomain on pages.dev is a per-deployment preview.',
      provider: 'Cloudflare Pages',
    };
  }
  return undefined;
}

/** Ports that are somebody's development server rather than a published service. */
export const DEV_SERVER_PORTS: Record<string, string> = {
  '3000': 'Next.js, Create React App and Express default',
  '3001': 'a second Node dev server',
  '4200': 'Angular CLI default',
  '4321': 'Astro default',
  '5000': 'Flask and .NET default',
  '5173': 'Vite default',
  '5174': 'a second Vite server',
  '5183': 'Vite, incremented',
  '7071': 'Azure Functions local host',
  '8000': 'Django and Python http.server default',
  '8080': 'a common local application port',
  '8081': 'Metro and a common second local port',
  '8888': 'Jupyter default',
  '9000': 'a common local application port',
  '19006': 'Expo web default',
};

export function reachIsUnreachableByOthers(reach: HostReach): boolean {
  return (
    reach === 'loopback' ||
    reach === 'private-network' ||
    reach === 'link-local' ||
    reach === 'special-use' ||
    reach === 'mdns-or-single-label' ||
    reach === 'overlay-network' ||
    reach === 'carrier-nat'
  );
}
