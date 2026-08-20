/**
 * The one integration test that talks to a real server.
 *
 * The specification's own example links are the only SMART Health Links in the
 * world a static browser viewer can rely on: they use the U flag (a plain GET,
 * so no preflight), they are served with `access-control-allow-origin: *`, and
 * they are hosted on a stable raw.githubusercontent.com path. That makes them
 * the right, and only, target for an end-to-end check.
 *
 * Excluded from the default test run (the file name carries `.integration.`),
 * because a suite that fails when the venue wifi is down is a suite people learn
 * to ignore. Run it deliberately:
 *
 *   npx vitest run --config vitest.integration.config.ts
 *
 * What it is actually protecting: that our JOSE layer, written on WebCrypto
 * against no reference implementation, agrees with a real encrypter on real
 * bytes. Golden fixtures cannot prove that, because a fixture we generated
 * reproduces our own mistakes forever.
 */
import { describe, expect, it } from 'vitest';
import { openShl } from '../src/core/pipeline';
import { HTTPS_VIEWER } from '../src/core/diagnose/context';
import { octThumbprint } from '../src/core/jose';

// From the IG's own links-examples page. Both carry flag "LU" and the published
// example key, so nothing secret is committed here.
const IPS_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';
const CARD_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9jYXJkcy9jYXJpbi1pbnN1cmFuY2UtZXhhbXBsZS9qd3MudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIGNhcmluLWluc3VyYW5jZS1leGFtcGxlIn0';

const EXAMPLE_KEY = 'rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q';

const base = { viewer: HTTPS_VIEWER, recipient: 'SHLoupe integration test' };

describe('the specification’s own example links', () => {
  it('opens the IPS document bundle end to end', async () => {
    const result = await openShl({ ...base, input: IPS_LINK });

    expect(result.outcome).toBe('opened');
    expect(result.run.networkUsed).toBe(true);

    // A U-flag link takes the direct path: a GET, no manifest, no preflight.
    const kinds = result.run.steps.map((step) => step.kind);
    expect(kinds).toContain('net.direct');
    expect(kinds).not.toContain('net.manifest');

    const file = result.files[0];
    expect(file?.kind).toBe('fhir');
    expect(file?.source).toBe('direct');

    const bundle = file?.content as { resourceType: string; type: string; entry: unknown[] };
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('document');
    expect(bundle.entry.length).toBeGreaterThanOrEqual(20);
    expect((bundle.entry[0] as { resource: { resourceType: string } }).resource.resourceType).toBe(
      'Composition',
    );

    // The JWE parameters the specification pins, observed on real bytes.
    expect(file?.jweHeader?.alg).toBe('dir');
    expect(file?.jweHeader?.enc).toBe('A256GCM');
    // No cty, which is the norm in practice despite the prose asking for one.
    expect(file?.jweHeader?.cty).toBeUndefined();
    expect(file?.compressed).toBe(false);
    expect(file?.bytes).toBeGreaterThan(50_000);
  }, 30_000);

  it('confirms the header kid really is the RFC 7638 thumbprint of the link key', async () => {
    // This convention is what lets SHLoupe prove a key mismatch before decrypting,
    // rather than reporting an opaque authentication failure. It is a convention
    // the examples follow and the prose never states, so it gets checked against
    // the live artefact rather than trusted.
    const result = await openShl({ ...base, input: IPS_LINK });
    const kid = result.files[0]?.jweHeader?.kid;
    expect(kid).toBe(await octThumbprint(EXAMPLE_KEY));
  }, 30_000);

  it('opens the signed health card, and reports the JWS as compressed', async () => {
    const result = await openShl({ ...base, input: CARD_LINK });

    expect(result.outcome).toBe('opened');
    const file = result.files[0];
    expect(file?.kind).toBe('smart-health-card');

    const card = file?.content as { verifiableCredential: string[] };
    expect(card.verifiableCredential).toHaveLength(1);

    // The health-card JWS is separately DEFLATE-compressed inside the JWE, which
    // is a different layer from the JWE's own optional zip header.
    const jws = card.verifiableCredential[0] as string;
    expect(jws.split('.')).toHaveLength(3);
    const header = JSON.parse(
      Buffer.from(jws.split('.')[0] as string, 'base64url').toString(),
    ) as Record<string, string>;
    expect(header.alg).toBe('ES256');
    expect(header.zip).toBe('DEF');
  }, 30_000);

  it('records the recipient in the query, as the U flag requires', async () => {
    const result = await openShl({ ...base, input: IPS_LINK });
    const step = result.run.steps.find((s) => s.kind === 'net.direct');
    const request = step?.evidence.find((e) => e.type === 'request');
    expect(request?.type === 'request' && request.request.url).toContain(
      'recipient=SHLoupe+integration+test',
    );
  }, 30_000);

  it('reports the response content type without gating on it', async () => {
    // The IG's own example is served as text/plain, not application/jose. A
    // viewer that insisted on the content type would refuse the specification's
    // own example, so this asserts we note it and carry on.
    const result = await openShl({ ...base, input: IPS_LINK });
    const step = result.run.steps.find((s) => s.kind === 'net.direct');
    const response = step?.evidence.find((e) => e.type === 'response');
    expect(response?.type === 'response' && response.response.headers['content-type']).toContain(
      'text/plain',
    );
    expect(result.outcome).toBe('opened');
  }, 30_000);
});
