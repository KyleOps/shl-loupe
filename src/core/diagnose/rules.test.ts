import { describe, expect, it } from 'vitest';
import { runStaticRules, STATIC_RULES } from './rules';
import { HTTPS_VIEWER, type DiagnosisContext } from './context';
import { classifyHost, DEV_SERVER_PORTS } from './host';
import type { ShlLink } from '../shlink';

const NOW = Date.parse('2026-08-20T00:00:00Z');

function context(url: string, link: Partial<ShlLink> = {}, viewer = HTTPS_VIEWER): DiagnosisContext {
  return {
    url: new URL(url),
    rawUrl: url,
    link: { raw: {}, url, key: 'x'.repeat(43), flags: [], extraMembers: [], ...link },
    viewer,
    now: NOW,
  };
}

const ids = (ctx: DiagnosisContext): string[] => runStaticRules(ctx).map((f) => f.ruleId);

describe('rule identity', () => {
  it('gives every rule a unique id that matches the finding it raises', () => {
    const seen = new Set<string>();
    for (const rule of STATIC_RULES) {
      expect(seen.has(rule.id), `duplicate rule id ${rule.id}`).toBe(false);
      seen.add(rule.id);
      expect(rule.about.length).toBeGreaterThan(10);
    }
  });

  it('never emits a finding whose ruleId disagrees with the rule that made it', () => {
    // A report quotes the id, so a mismatch would send someone to the wrong rule.
    for (const rule of STATIC_RULES) {
      const finding = rule.evaluate(context('https://localhost:5173/m?bid=1', { flags: ['P', 'U'], exp: 1 }));
      if (finding !== undefined) expect(finding.ruleId).toBe(rule.id);
    }
  });

  it('sorts findings worst first', () => {
    const found = runStaticRules(context('http://10.0.0.5:3000/m?bid=7'));
    const order = ['fatal', 'error', 'warning', 'info', 'good'];
    const positions = found.map((f) => order.indexOf(f.severity));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('reachability', () => {
  it('catches the loopback family', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      expect(ids(context(`https://${host}/m`)), host).toContain('SHL-URL-LOOPBACK');
    }
  });

  it('catches every private and reserved range', () => {
    const cases: Array<[string, string]> = [
      ['10.1.2.3', 'SHL-URL-PRIVATE-NETWORK'],
      ['172.16.0.1', 'SHL-URL-PRIVATE-NETWORK'],
      ['172.31.255.254', 'SHL-URL-PRIVATE-NETWORK'],
      ['192.168.1.1', 'SHL-URL-PRIVATE-NETWORK'],
      ['169.254.1.1', 'SHL-URL-PRIVATE-NETWORK'],
      ['100.100.1.1', 'SHL-URL-PRIVATE-NETWORK'],
      ['[fd00::1]', 'SHL-URL-PRIVATE-NETWORK'],
      ['[fe80::1]', 'SHL-URL-PRIVATE-NETWORK'],
    ];
    for (const [host, expected] of cases) {
      expect(ids(context(`https://${host}/m`)), host).toContain(expected);
    }
  });

  it('does not flag a public address as private', () => {
    for (const host of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '99.1.1.1']) {
      expect(classifyHost(host).reach, host).toBe('public');
    }
  });

  it('names an unresolvable host shape', () => {
    for (const host of ['my-laptop', 'printer.local', 'api.internal', 'thing.test']) {
      expect(ids(context(`https://${host}/m`)), host).toContain('SHL-URL-UNRESOLVABLE-NAME');
    }
  });

  it('separates a tunnel from a permanent host', () => {
    expect(ids(context('https://abc123.ngrok-free.app/m'))).toContain('SHL-URL-EPHEMERAL-TUNNEL');
    expect(ids(context('https://sharing.example.org/m'))).not.toContain('SHL-URL-EPHEMERAL-TUNNEL');
  });

  it('recognises a Tailscale name as routing only inside the sender’s network', () => {
    const found = runStaticRules(context('https://laptop.tail1234.ts.net/m'));
    const finding = found.find((f) => f.ruleId === 'SHL-URL-OVERLAY-NETWORK');
    expect(finding?.title).toContain('Tailscale');
  });

  it('separates a per-commit preview from a production alias on the same platform', () => {
    expect(ids(context('https://my-app-git-feat-team.vercel.app/api/m'))).toContain(
      'SHL-URL-PREVIEW-DEPLOYMENT',
    );
    expect(ids(context('https://my-app.vercel.app/api/m'))).not.toContain(
      'SHL-URL-PREVIEW-DEPLOYMENT',
    );
  });
});

describe('scheme and mixed content', () => {
  it('is fatal for http under an https viewer, because the browser blocks it before the network', () => {
    const found = runStaticRules(context('http://sharing.example.org/m'));
    const finding = found.find((f) => f.ruleId === 'SHL-URL-NOT-HTTPS');
    expect(finding?.severity).toBe('fatal');
    expect(finding?.detail).toContain('mixed content');
    expect(finding?.remedy).toContain('localhost');
  });

  it('is only an error under an http viewer, where the request is actually permitted', () => {
    const local = {
      protocol: 'http:',
      hostname: 'localhost',
      port: '8080',
      isSecureContext: true,
      origin: 'http://localhost:8080',
    };
    const found = runStaticRules(context('http://sharing.example.org/m', {}, local));
    const finding = found.find((f) => f.ruleId === 'SHL-URL-NOT-HTTPS');
    expect(finding?.severity).toBe('error');
    expect(finding?.detail).not.toContain('mixed content');
  });

  it('names a development port, but stays quiet about it on loopback where it adds nothing', () => {
    expect(ids(context('https://sharing.example.org:5173/m'))).toContain('SHL-URL-DEV-PORT');
    expect(ids(context('https://localhost:5173/m'))).not.toContain('SHL-URL-DEV-PORT');
    expect(Object.keys(DEV_SERVER_PORTS)).toContain('5173');
  });
});

describe('time', () => {
  it('reports how long ago a link expired', () => {
    const cases: Array<[number, string]> = [
      [90, '2 minutes ago'],
      [7200, '2 hours ago'],
      [86_400 * 3, '3 days ago'],
      [86_400 * 400, '1 year ago'],
    ];
    for (const [ago, expected] of cases) {
      const found = runStaticRules(
        context('https://example.org/m', { exp: Math.floor(NOW / 1000) - ago }),
      );
      expect(found.find((f) => f.ruleId === 'SHL-EXP-PAST')?.title, String(ago)).toContain(expected);
    }
  });

  it('warns rather than fails when expiry is imminent', () => {
    const found = runStaticRules(
      context('https://example.org/m', { exp: Math.floor(NOW / 1000) + 600 }),
    );
    expect(found.find((f) => f.ruleId === 'SHL-EXP-IMMINENT')?.severity).toBe('warning');
    expect(ids(context('https://example.org/m', { exp: Math.floor(NOW / 1000) + 600 }))).not.toContain(
      'SHL-EXP-PAST',
    );
  });

  it('catches the Date.now() mistake', () => {
    const found = runStaticRules(context('https://example.org/m', { exp: NOW }));
    const finding = found.find((f) => f.ruleId === 'SHL-EXP-MILLISECONDS');
    expect(finding?.detail).toContain('Date.now()');
  });
});

describe('flags', () => {
  it('explains a passcode requirement before anything is attempted', () => {
    const found = runStaticRules(context('https://example.org/m', { flags: ['P'] }));
    const finding = found.find((f) => f.ruleId === 'SHL-FLAG-P');
    expect(finding?.detail).toContain('lifetime');
  });

  it('rejects U with P', () => {
    expect(ids(context('https://example.org/m', { flags: ['P', 'U'] }))).toContain(
      'SHL-FLAG-U-AND-P',
    );
  });

  it('stays quiet about CORS when the host is unreachable anyway', () => {
    // Two explanations for one failure dilutes the one that matters.
    expect(ids(context('https://localhost:5173/m'))).not.toContain('SHL-CORS-PREFLIGHT-EXPECTED');
    expect(ids(context('https://10.0.0.4/m'))).not.toContain('SHL-CORS-PREFLIGHT-EXPECTED');
  });

  it('tells a direct link apart from a manifest link in what it says will happen', () => {
    const direct = runStaticRules(context('https://example.org/f', { flags: ['U'] }));
    expect(direct.find((f) => f.ruleId === 'SHL-CORS-PREFLIGHT-EXPECTED')?.detail).toContain(
      'cross-origin GET',
    );
    const manifest = runStaticRules(context('https://example.org/m'));
    expect(manifest.find((f) => f.ruleId === 'SHL-CORS-PREFLIGHT-EXPECTED')?.detail).toContain(
      'OPTIONS preflight',
    );
  });
});

describe('URL entropy, which is the access control in this protocol', () => {
  it('flags a sequential database id, the shape seen in the field', () => {
    const found = runStaticRules(context('https://example.org/api/shl-manifest?bid=4836470'));
    const finding = found.find((f) => f.ruleId === 'SHL-URL-LOW-ENTROPY');
    expect(finding?.severity).toBe('error');
    expect(finding?.detail).toContain('decimal counter');
    expect(finding?.detail).toContain('no authentication in this protocol');
  });

  it('flags a short opaque token', () => {
    expect(ids(context('https://example.org/manifest/abc123'))).toContain('SHL-URL-LOW-ENTROPY');
  });

  it('accepts an identifier long enough to carry 256 bits', () => {
    const random = 'x'.repeat(43);
    expect(ids(context(`https://example.org/manifest/${random}`))).not.toContain(
      'SHL-URL-LOW-ENTROPY',
    );
  });

  it('flags a URL with no identifier at all', () => {
    const found = runStaticRules(context('https://example.org/'));
    expect(found.find((f) => f.ruleId === 'SHL-URL-LOW-ENTROPY')?.detail).toContain(
      'no identifier at all',
    );
  });
});

describe('URL hygiene', () => {
  it('catches the 128-character cap', () => {
    const long = `https://example.org/manifest/${'a'.repeat(120)}`;
    expect(ids(context(long))).toContain('SHL-URL-TOO-LONG');
  });

  it('catches an invisible character', () => {
    const withZeroWidth = 'https://example.org/manifest/​abc';
    const found = runStaticRules({
      ...context('https://example.org/manifest/abc'),
      rawUrl: withZeroWidth,
    });
    const finding = found.find((f) => f.ruleId === 'SHL-URL-INVISIBLE-CHARACTER');
    expect(finding?.detail).toContain('U+200B');
  });

  it('catches a fragment, which never reaches the server', () => {
    expect(ids(context('https://example.org/m?bid=abcdefghijklmnopqrstuvwxyz#frag'))).toContain(
      'SHL-URL-FRAGMENT',
    );
  });

  it('rejects an unsupported protocol version rather than guessing', () => {
    const found = runStaticRules(context('https://example.org/m', { version: 2 }));
    expect(found.find((f) => f.ruleId === 'SHL-VERSION-UNSUPPORTED')?.severity).toBe('error');
    expect(ids(context('https://example.org/m', { version: 1 }))).not.toContain(
      'SHL-VERSION-UNSUPPORTED',
    );
    expect(ids(context('https://example.org/m', { version: '1' }))).not.toContain(
      'SHL-VERSION-UNSUPPORTED',
    );
  });
});
