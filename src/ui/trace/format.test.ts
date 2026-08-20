import { describe, expect, it } from 'vitest';
import type { Evidence, Finding, HttpResponseRecord, TraceRun, TraceStep } from '../../core/trace';
import {
  buildStepTree,
  countRequests,
  durationBarWidths,
  evidenceLabel,
  flattenStepTree,
  highlightPartForRule,
  highlightUrlPart,
  isCrossOriginResponse,
  leadingFinding,
  linkExpiryFromRun,
  manifestUrlFromRun,
  failingStepId,
  outcomeHeadline,
  outcomeTone,
  relativeTime,
  statusLabel,
  statusPillTone,
  stepDomId,
  stepMetrics,
  stepToText,
  worstFinding,
} from './format';

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

function step(partial: Partial<TraceStep> & { id: string }): TraceStep {
  return {
    kind: 'net.manifest',
    title: 'Request the manifest',
    status: 'ok',
    startedAt: 0,
    evidence: [],
    findingIds: [],
    ...partial,
  };
}

function response(partial: Partial<HttpResponseRecord> = {}): HttpResponseRecord {
  return { status: 200, headers: {}, ...partial };
}

describe('relativeTime', () => {
  it('phrases a future instant with "in"', () => {
    expect(relativeTime(NOW / 1000 + 3600, NOW)).toBe('in 1 hour');
    expect(relativeTime(NOW / 1000 + 60 * 60 * 24 * 6, NOW)).toBe('in 6 days');
    expect(relativeTime(NOW / 1000 + 45, NOW)).toBe('in 45 seconds');
  });

  it('phrases a past instant with "ago"', () => {
    expect(relativeTime(NOW / 1000 - 60 * 60 * 24 * 2, NOW)).toBe('2 days ago');
    expect(relativeTime(NOW / 1000 - 60 * 60 * 24 * 400, NOW)).toBe('1 year ago');
  });

  it('says "now" inside a second, so a fresh expiry does not read as expired', () => {
    expect(relativeTime(NOW / 1000, NOW)).toBe('now');
  });

  it('refuses to invent a date from a non-finite value', () => {
    expect(relativeTime(Number.NaN, NOW)).toBe('an unknown time');
  });
});

describe('statusLabel and statusPillTone', () => {
  it('never renders 0 as a status code', () => {
    expect(statusLabel(0)).toBe('no response');
    expect(statusPillTone(0)).toBe('fail');
  });

  it('maps the ranges a manifest response actually lands in', () => {
    expect(statusLabel(200)).toBe('200');
    expect(statusPillTone(200)).toBe('pass');
    expect(statusPillTone(302)).toBe('warn');
    expect(statusPillTone(401)).toBe('fail');
    expect(statusPillTone(503)).toBe('fail');
    expect(statusPillTone(100)).toBe('info');
  });
});

describe('isCrossOriginResponse', () => {
  it('reports unknown rather than guessing when the transport recorded no type', () => {
    expect(isCrossOriginResponse(response())).toBeUndefined();
  });

  it('treats anything other than basic as cross origin', () => {
    expect(isCrossOriginResponse(response({ responseType: 'basic' }))).toBe(false);
    expect(isCrossOriginResponse(response({ responseType: 'cors' }))).toBe(true);
    expect(isCrossOriginResponse(response({ responseType: 'opaque' }))).toBe(true);
  });
});

describe('highlightUrlPart', () => {
  it('marks the host in place and leaves a matching query parameter alone', () => {
    const segments = highlightUrlPart('https://localhost:5173/api?next=localhost', 'host');
    expect(segments).toEqual([
      { text: 'https://', highlight: false },
      { text: 'localhost', highlight: true },
      { text: ':5173/api?next=localhost', highlight: false },
    ]);
  });

  it('marks the scheme without the colon', () => {
    expect(highlightUrlPart('http://shl.example.org/m', 'scheme')).toEqual([
      { text: 'http', highlight: true },
      { text: '://shl.example.org/m', highlight: false },
    ]);
  });

  it('marks the port digits only', () => {
    expect(highlightUrlPart('https://shl.example.org:5173/m', 'port')).toEqual([
      { text: 'https://shl.example.org:', highlight: false },
      { text: '5173', highlight: true },
      { text: '/m', highlight: false },
    ]);
  });

  it('does not mistake userinfo for the host', () => {
    const segments = highlightUrlPart('https://user@evil.example.org/m', 'host');
    expect(segments.find((segment) => segment.highlight)?.text).toBe('evil.example.org');
  });

  it('keeps an IPv6 literal whole', () => {
    const segments = highlightUrlPart('http://[::1]:5173/m', 'host');
    expect(segments.find((segment) => segment.highlight)?.text).toBe('[::1]');
  });

  it('returns nothing highlighted when there is no such part, or no URL at all', () => {
    expect(highlightUrlPart('https://shl.example.org/m', 'port')).toEqual([
      { text: 'https://shl.example.org/m', highlight: false },
    ]);
    expect(highlightUrlPart('not a url', 'host')).toEqual([
      { text: 'not a url', highlight: false },
    ]);
  });

  it('always reproduces the input when the segments are joined', () => {
    const url = 'https://user@127.0.0.1:8080/api/shl-manifest?bid=4836470#x';
    for (const part of ['scheme', 'host', 'port'] as const) {
      expect(
        highlightUrlPart(url, part)
          .map((segment) => segment.text)
          .join(''),
      ).toBe(url);
    }
  });
});

describe('highlightPartForRule', () => {
  it('points the loopback rule at the host', () => {
    expect(highlightPartForRule('SHL-URL-LOOPBACK')).toBe('host');
    expect(highlightPartForRule('SHL-URL-NOT-HTTPS')).toBe('scheme');
    expect(highlightPartForRule('SHL-URL-DEV-PORT')).toBe('port');
  });

  it('has nothing to point at for a rule that is not about the URL', () => {
    expect(highlightPartForRule('SHL-DECRYPT-FAILED')).toBeUndefined();
  });
});

describe('buildStepTree', () => {
  it('nests children under their parent and numbers both levels', () => {
    const tree = buildStepTree([
      step({ id: 'a' }),
      step({ id: 'b' }),
      step({ id: 'b1', parentId: 'b' }),
      step({ id: 'b2', parentId: 'b' }),
    ]);
    expect(tree.map((node) => node.number)).toEqual(['1', '2']);
    expect(tree[1]?.children.map((node) => node.number)).toEqual(['2.1', '2.2']);
  });

  it('promotes a step whose parent was never recorded rather than dropping it', () => {
    const tree = buildStepTree([step({ id: 'a', parentId: 'ghost' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.number).toBe('1');
  });

  it('keeps every step even when parents form a cycle', () => {
    const tree = buildStepTree([
      step({ id: 'a', parentId: 'b' }),
      step({ id: 'b', parentId: 'a' }),
    ]);
    expect(
      flattenStepTree(tree)
        .map((node) => node.step.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('stepMetrics', () => {
  it('reports no network for a step that made no request', () => {
    expect(stepMetrics(step({ id: 'a', evidence: [{ type: 'note', text: 'x' }] }))).toEqual({
      hasNetwork: false,
    });
  });

  it('takes the status and size from the recorded response', () => {
    const evidence: Evidence[] = [
      { type: 'request', request: { method: 'POST', url: 'https://x/', headers: {} } },
      { type: 'response', response: response({ status: 401, bodyBytes: 64 }) },
    ];
    expect(stepMetrics(step({ id: 'a', evidence }))).toEqual({
      status: 401,
      bytes: 64,
      hasNetwork: true,
    });
  });

  it('falls back to a recorded byte length when there was no response', () => {
    const evidence: Evidence[] = [
      { type: 'bytes', label: 'Ciphertext', length: 3100, preview: 'ab cd' },
    ];
    expect(stepMetrics(step({ id: 'a', evidence })).bytes).toBe(3100);
  });
});

describe('durationBarWidths', () => {
  it('scales to the longest step and splits out the network wait', () => {
    const bars = durationBarWidths([
      step({ id: 'a', durationMs: 100 }),
      step({
        id: 'b',
        durationMs: 400,
        evidence: [{ type: 'response', response: response({ durationMs: 300 }) }],
      }),
    ]);
    expect(bars.get('a')).toEqual({ totalPercent: 25, waitingPercent: 0, hasNetwork: false });
    expect(bars.get('b')).toEqual({ totalPercent: 100, waitingPercent: 75, hasNetwork: true });
  });

  it('keeps a fast step visible instead of rounding it away', () => {
    const bars = durationBarWidths([
      step({ id: 'a', durationMs: 1 }),
      step({ id: 'b', durationMs: 2000 }),
    ]);
    expect(bars.get('a')?.totalPercent).toBe(2);
  });

  it('gives an untimed step no bar at all', () => {
    const bars = durationBarWidths([step({ id: 'a' })]);
    expect(bars.get('a')).toEqual({ totalPercent: 0, waitingPercent: 0, hasNetwork: false });
  });
});

describe('run level helpers', () => {
  const run: TraceRun = {
    id: 'run-1',
    startedAt: 0,
    outcome: 'failed',
    input: { kind: 'shlink', source: 'shlink:/x' },
    networkUsed: false,
    findings: [],
    steps: [
      step({
        id: 'a',
        evidence: [
          { type: 'request', request: { method: 'POST', url: 'https://x/', headers: {} } },
        ],
      }),
      step({ id: 'b' }),
    ],
  };

  it('counts requests across the whole run', () => {
    expect(countRequests(run)).toBe(1);
    expect(countRequests({ ...run, steps: [] })).toBe(0);
  });

  it('leads with the worst severity present', () => {
    const findings: Finding[] = [
      { id: '1', ruleId: 'A', severity: 'warning', audience: 'you', title: 'w', detail: 'd' },
      { id: '2', ruleId: 'B', severity: 'fatal', audience: 'sender', title: 'f', detail: 'd' },
      { id: '3', ruleId: 'C', severity: 'error', audience: 'server', title: 'e', detail: 'd' },
    ];
    expect(worstFinding(findings)?.ruleId).toBe('B');
    expect(worstFinding([])).toBeUndefined();
  });

  it('separates blocked from failed, because one waits on a person', () => {
    expect(outcomeTone('blocked')).toBe('info');
    expect(outcomeTone('failed')).toBe('fail');
    expect(outcomeHeadline('blocked')).toBe('This link cannot go further without a person.');
    expect(outcomeHeadline('opened')).toBe('This link opens.');
  });

  it('names a step row so the banner can jump to it', () => {
    expect(stepDomId('s-4')).toBe('trace-step-s-4');
  });
});

describe('evidenceLabel', () => {
  it('uses the evidence own label where it has one, and a fixed word otherwise', () => {
    expect(evidenceLabel({ type: 'json', label: 'Decoded payload', value: {} })).toBe(
      'Decoded payload',
    );
    expect(evidenceLabel({ type: 'response', response: response() })).toBe('Response');
    expect(
      evidenceLabel({ type: 'citation', citation: { spec: 'S', section: 'x', url: 'u' } }),
    ).toBe('Specification');
  });
});

describe('stepToText', () => {
  const evidence: Evidence[] = [
    { type: 'note', text: 'The key is sekritsekritsekrit.' },
    {
      type: 'request',
      request: {
        method: 'POST',
        url: 'https://shl.example.org/m',
        headers: { 'content-type': 'application/json' },
        body: '{"recipient":"SHLoupe"}',
      },
    },
    { type: 'response', response: response({ status: 0, networkError: 'Failed to fetch' }) },
  ];
  const target = step({ id: 'a', durationMs: 412, status: 'fail', evidence, findingIds: ['f-1'] });
  const findings: Finding[] = [
    {
      id: 'f-1',
      ruleId: 'SHL-URL-LOOPBACK',
      severity: 'fatal',
      audience: 'sender',
      title: 'Manifest host is a loopback address.',
      detail: 'localhost resolves to this machine.',
      remedy: 'Republish with a reachable host.',
    },
    { id: 'f-2', ruleId: 'OTHER', severity: 'info', audience: 'nobody', title: 'x', detail: 'y' },
  ];

  it('writes a greppable block carrying status, timing and the finding', () => {
    const text = stepToText(target, findings, { number: '5' });
    expect(text).toContain('step 5  Request the manifest  [fail]  412 ms');
    expect(text).toContain('request: POST https://shl.example.org/m');
    expect(text).toContain('content-type: application/json');
    expect(text).toContain('response: no response');
    expect(text).toContain('browser said: Failed to fetch');
    expect(text).toContain('fatal: SHL-URL-LOOPBACK  Manifest host is a loopback address.');
    expect(text).toContain('remedy: Republish with a reachable host.');
  });

  it('leaves out findings raised by other steps', () => {
    expect(stepToText(target, findings)).not.toContain('OTHER');
  });

  it('applies the mask, because the clipboard is outside the tab', () => {
    const text = stepToText(target, findings, {
      mask: (value) => value.split('sekritsekritsekrit').join('[link key redacted]'),
    });
    expect(text).not.toContain('sekritsekritsekrit');
    expect(text).toContain('[link key redacted]');
  });
});

describe('reading the link back out of the run', () => {
  const decode = step({
    id: 'd',
    kind: 'shlink.decode',
    evidence: [
      {
        type: 'json',
        label: 'Decoded payload',
        value: {
          url: 'https://localhost:5173/api/shl-manifest?bid=1',
          key: 'k',
          exp: 1_800_000_000,
        },
      },
    ],
  });
  const base: TraceRun = {
    id: 'run-2',
    startedAt: 0,
    outcome: 'blocked',
    input: { kind: 'shlink', source: 'shlink:/x' },
    networkUsed: false,
    findings: [],
    steps: [decode],
  };

  it('finds the manifest URL with no request having been made', () => {
    expect(manifestUrlFromRun(base)).toBe('https://localhost:5173/api/shl-manifest?bid=1');
    expect(linkExpiryFromRun(base)).toBe(1_800_000_000);
  });

  it('falls back to the first request when there was no decoded payload', () => {
    const pasted: TraceRun = {
      ...base,
      steps: [
        step({
          id: 'r',
          evidence: [
            { type: 'request', request: { method: 'GET', url: 'https://files/x', headers: {} } },
          ],
        }),
      ],
    };
    expect(manifestUrlFromRun(pasted)).toBe('https://files/x');
    expect(linkExpiryFromRun(pasted)).toBeUndefined();
  });
});

describe('leadingFinding and failingStepId', () => {
  const findings: Finding[] = [
    { id: 'f1', ruleId: 'GOOD', severity: 'good', audience: 'nobody', title: 'g', detail: 'd' },
    { id: 'f2', ruleId: 'NOTE', severity: 'info', audience: 'nobody', title: 'i', detail: 'd' },
  ];

  it('does not lead with a finding that says nothing is wrong', () => {
    expect(leadingFinding(findings)).toBeUndefined();
  });

  it('leads with a warning, an error or a fatal', () => {
    const warned: Finding[] = [
      ...findings,
      { id: 'f3', ruleId: 'W', severity: 'warning', audience: 'you', title: 'w', detail: 'd' },
    ];
    expect(leadingFinding(warned)?.ruleId).toBe('W');
  });

  it('jumps to the step that raised the leading finding', () => {
    const run: TraceRun = {
      id: 'r',
      startedAt: 0,
      outcome: 'failed',
      input: { kind: 'shlink', source: 'x' },
      networkUsed: false,
      steps: [step({ id: 's1' }), step({ id: 's2', status: 'fail' })],
      findings: [
        {
          id: 'f',
          ruleId: 'SHL-URL-LOOPBACK',
          severity: 'fatal',
          audience: 'sender',
          title: 't',
          detail: 'd',
          stepId: 's1',
        },
      ],
    };
    expect(failingStepId(run)).toBe('s1');
    expect(failingStepId({ ...run, findings: [] })).toBe('s2');
    expect(failingStepId({ ...run, findings: [], steps: [step({ id: 'a' })] })).toBeUndefined();
  });
});
