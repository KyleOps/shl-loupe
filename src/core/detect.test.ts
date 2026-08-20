/**
 * Input detection, branch by branch.
 *
 * Detection is total, so every string gets an answer, and the interesting cases
 * are the confusable pairs rather than the clean ones: a JWE and a JWS differ
 * only by part count, and a manifest, a health-card file and a FHIR bundle are
 * all JSON objects. Each of those is asserted against both sides of the pair, so
 * a rule that fires too eagerly fails here rather than in front of a room.
 */
import { describe, expect, it } from 'vitest';
import { detectInput, type DetectedVariant } from './detect';
import { encodeShlink } from './shlink';
import { encryptDirA256Gcm } from './jose';
import { bytesToBase64url, stringToBase64url, utf8Encode } from './bytes';
import { IG_SHC_FILE } from '../fixtures/shc-card';

const KEY = bytesToBase64url(new Uint8Array(32).fill(7));
const URL_IN_LINK =
  'https://sharing.example.org/manifest/PDVWzSDGdvS0Q6IcVlPzKrqSVFcHnLdMEEsxAJVLu9E';

const LINK = encodeShlink({ url: URL_IN_LINK, key: KEY, label: 'Patient Summary' });
/** The encoded payload on its own, which is what every carrier form wraps. */
const PAYLOAD = LINK.replace('shlink:/', '');

/** Assert the variant, and return the whole result for further assertions. */
const detect = (text: string, variant: DetectedVariant) => {
  const result = detectInput(text);
  expect(result.variant).toBe(variant);
  return result;
};

// ---------------------------------------------------------------------------
// Nothing, and nothing recognisable
// ---------------------------------------------------------------------------

describe('the two empty answers', () => {
  it('treats an empty box as a prompt, not an error', () => {
    for (const blank of ['', '   ', '\n\t ']) {
      const result = detect(blank, 'empty');
      expect(result.kind).toBe('unknown');
      expect(result.needsKey).toBe(false);
      // The sentence names what would work, because an empty state is the one
      // place a tool gets to teach without interrupting anybody.
      expect(result.sentence).toContain('A link, a manifest, an encrypted file');
    }
  });

  it('says plainly what it reads when it recognises nothing, and quotes no guess', () => {
    const prose = 'Have a look at this, would you? Thanks!';
    const result = detect(prose, 'unrecognised');
    expect(result.kind).toBe('unknown');
    expect(result.sentence).toContain('does not recognise this');
    expect(result.sentence).toContain('raw output of a curl command');
    expect(result.details).toEqual([`${prose.length} characters pasted`]);
  });
});

// ---------------------------------------------------------------------------
// The five carrier forms
// ---------------------------------------------------------------------------

describe('how a link arrived', () => {
  it('reads the one-slash URI the specification defines', () => {
    const result = detect(LINK, 'shlink-uri');
    expect(result.kind).toBe('shlink');
    expect(result.confidence).toBe('certain');
    expect(result.link?.url).toBe(URL_IN_LINK);
    expect(result.link?.key).toBe(KEY);
    expect(result.needsKey).toBe(false);
    expect(result.details).toContain('carried as a shlink:/ URI');
    expect(result.details).toContain('manifest host sharing.example.org');
    expect(result.details).toContain('labelled "Patient Summary"');
  });

  it('accepts the two-slash form and names it as the mistake it is', () => {
    const result = detect(`shlink://${PAYLOAD}`, 'shlink-uri-double-slash');
    expect(result.link?.url).toBe(URL_IN_LINK);
    expect(result.details).toContain('carried as a shlink:// URI, which has one slash too many');
  });

  it('reads a viewer URL with the payload after the hash, and says that is the right place', () => {
    const result = detect(
      `https://viewer.example.org/shlink.html#shlink:/${PAYLOAD}`,
      'viewer-fragment',
    );
    expect(result.link?.key).toBe(KEY);
    expect(result.details).toContain(
      'carried as a viewer URL with the payload after the "#", which is the right place for it',
    );
  });

  it('reads a viewer URL with the payload in the query, and says the key reached a server', () => {
    const result = detect(`https://viewer.example.org/v?shlink=${PAYLOAD}`, 'viewer-query');
    expect(result.link?.key).toBe(KEY);
    // The fragment-versus-query distinction is the whole reason this form is
    // called out: a query string is sent to the host, a fragment never is.
    expect(result.details).toContain(
      'carried as a viewer URL with the payload in the query string, which sends the key to a server',
    );
  });

  it('reads a bare payload with no prefix at all', () => {
    const result = detect(PAYLOAD, 'bare-payload');
    expect(result.kind).toBe('shlink');
    expect(result.link?.url).toBe(URL_IN_LINK);
    expect(result.details).toContain('carried as a bare base64url payload with no prefix');
  });
});

// ---------------------------------------------------------------------------
// What a link survives on its way here
// ---------------------------------------------------------------------------

describe('a link that has been through a chat client', () => {
  it('survives leading and trailing whitespace', () => {
    expect(detect(`\n  ${LINK}\t \n`, 'shlink-uri').link?.url).toBe(URL_IN_LINK);
  });

  it('survives a trailing full stop from prose', () => {
    // The payload must not absorb the stop: if it did, the base64url would not
    // decode and `link` would be absent rather than wrong, so this asserts the
    // decoded url rather than only the variant.
    const result = detect(`Here you go: ${LINK}.`, 'shlink-uri');
    expect(result.link?.url).toBe(URL_IN_LINK);
    expect(result.link?.key).toBe(KEY);
  });

  it('survives a soft line break inserted mid-payload', () => {
    const at = Math.floor(PAYLOAD.length / 2);
    const wrapped = `shlink:/${PAYLOAD.slice(0, at)}\n${PAYLOAD.slice(at)}`;
    expect(detect(wrapped, 'shlink-uri').link?.url).toBe(URL_IN_LINK);
  });

  it('survives being copied out of a URL bar percent-encoded', () => {
    const escaped = encodeURIComponent(`https://viewer.example.org/v#shlink:/${PAYLOAD}`);
    expect(escaped).toContain('%23');
    const result = detect(escaped, 'viewer-fragment');
    expect(result.link?.url).toBe(URL_IN_LINK);
  });

  it('still reports a link whose payload does not decode, rather than calling it unknown', () => {
    // Truncated in the middle of the base64url. It is unmistakably a link, and
    // saying where the decode stops is the pipeline's job, not detection's.
    const result = detect(`shlink:/${PAYLOAD.slice(0, 40)}`, 'shlink-uri');
    expect(result.kind).toBe('shlink');
    expect(result.link).toEqual({});
    expect(result.needsKey).toBe(true);
    expect(result.sentence).toContain('does not decode');
    expect(result.sentence).toContain('show exactly where the decoding stops');
  });
});

// ---------------------------------------------------------------------------
// Compact JOSE: the part count is the whole signal
// ---------------------------------------------------------------------------

describe('an encrypted file against a signed one', () => {
  it('calls five parts a JWE, even though alg=dir leaves the second one empty', async () => {
    const jwe = await encryptDirA256Gcm(
      utf8Encode('{"resourceType":"Patient"}'),
      new Uint8Array(32),
    );
    expect(jwe.split('.')).toHaveLength(5);
    // The trap: an empty second part fails any base64url test, so a detector
    // that checked all five parts against the alphabet would refuse every
    // conformant SHL file. Part 1 is exempt precisely because "dir" empties it.
    expect(jwe.split('.')[1]).toBe('');

    const result = detect(jwe, 'jwe-compact');
    expect(result.kind).toBe('jwe');
    expect(result.confidence).toBe('certain');
    expect(result.needsKey).toBe(true);
    expect(result.details).toContain('five dot-separated parts');
    expect(result.details).toContain('alg dir');
    expect(result.details).toContain('enc A256GCM');
    expect(result.details).toContain('an empty encrypted key, correct for alg "dir"');
  });

  it('faults a non-empty encrypted key, which alg=dir forbids', async () => {
    const jwe = await encryptDirA256Gcm(utf8Encode('{}'), new Uint8Array(32));
    const parts = jwe.split('.');
    const wrong = [parts[0], 'AAAAAAAAAAAAAAAA', parts[2], parts[3], parts[4]].join('.');
    const result = detect(wrong, 'jwe-compact');
    expect(result.details).toContain('a non-empty encrypted key, which alg "dir" forbids');
  });

  it('calls three parts a JWS, and recognises a health card from its header alone', () => {
    const card = IG_SHC_FILE.verifiableCredential[0] as string;
    expect(card.split('.')).toHaveLength(3);

    const result = detect(card, 'jws-compact');
    expect(result.kind).toBe('jws');
    expect(result.confidence).toBe('certain');
    expect(result.needsKey).toBe(false);
    expect(result.details).toContain('three dot-separated parts');
    expect(result.details).toContain('alg ES256');
    expect(result.details).toContain('zip DEF');
    expect(result.sentence).toContain('A signed SMART Health Card');
  });

  it('hedges on a three-part token that is not a health card', () => {
    const header = stringToBase64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = stringToBase64url(JSON.stringify({ sub: 'someone' }));
    const result = detect(`${header}.${claims}.AAAA`, 'jws-compact');
    // ES256 over raw DEFLATE is the card's exact signature; without it the
    // honest answer is "a signed token", stated as less than certain.
    expect(result.confidence).toBe('likely');
    expect(result.sentence).toContain('three parts rather than the five an encrypted SHL file has');
    expect(result.details).toContain('alg RS256');
  });

  it('keeps the part count as the signal when the header does not decode', () => {
    // A wrapper that mangled the header still leaves the shape readable, and
    // the shape is what decides which pipeline opens it.
    const result = detect('zzzz.AAAA.BBBB.CCCC.DDDD', 'jwe-compact');
    expect(result.kind).toBe('jwe');
    expect(result.details).toContain('five dot-separated parts');
    expect(result.details).not.toContain('alg dir');
  });
});

// ---------------------------------------------------------------------------
// The three JSON shapes
// ---------------------------------------------------------------------------

describe('three JSON documents that are not each other', () => {
  it('reads a manifest response by its files array', () => {
    const manifest = JSON.stringify({
      status: 'finalized',
      files: [
        { contentType: 'application/fhir+json', embedded: 'eyJ...' },
        { contentType: 'application/fhir+json', location: 'https://sharing.example.org/file/1' },
      ],
    });
    const result = detect(manifest, 'manifest-json');
    expect(result.kind).toBe('manifest');
    expect(result.needsKey).toBe(true);
    expect(result.details).toEqual(['status finalized', '1 embedded', '1 by location']);
    expect(result.sentence).toContain('A manifest response with 2 files');
  });

  it('reads a health-card file by its verifiableCredential array', () => {
    const result = detect(JSON.stringify(IG_SHC_FILE), 'shc-file');
    expect(result.kind).toBe('shc');
    expect(result.needsKey).toBe(false);
    expect(result.details).toEqual(['1 verifiable credential']);
    expect(result.sentence).toContain('holding 1 signed card');
  });

  it('reads a FHIR Bundle by its resourceType, and counts its entries', () => {
    const bundle = JSON.stringify({
      resourceType: 'Bundle',
      type: 'document',
      entry: [{ resource: { resourceType: 'Composition' } }],
    });
    const result = detect(bundle, 'fhir-bundle');
    expect(result.kind).toBe('fhir');
    expect(result.needsKey).toBe(false);
    expect(result.details).toEqual(['resourceType Bundle', 'type document', '1 entry']);
    expect(result.sentence).toContain('no key and no network needed');
  });

  it('reads a single FHIR resource separately from a bundle', () => {
    const result = detect(JSON.stringify({ resourceType: 'Patient', id: 'x' }), 'fhir-resource');
    expect(result.kind).toBe('fhir');
    expect(result.sentence).toContain('A FHIR Patient, already decrypted');
  });

  it('does not mistake a searchset Bundle carrying a List for a manifest', () => {
    // This is what a VHL retrieval answers with, and it is the nearest thing to
    // a manifest that is not one: no `files`, so it is FHIR.
    const searchset = JSON.stringify({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: { resourceType: 'List', status: 'current', mode: 'snapshot' } }],
    });
    const result = detect(searchset, 'fhir-bundle');
    expect(result.kind).toBe('fhir');
  });

  it('reports a JSON object it does not know by naming its members', () => {
    const result = detect(JSON.stringify({ alpha: 1, beta: 2 }), 'json-unrecognised');
    expect(result.kind).toBe('unknown');
    expect(result.sentence).toContain('the members alpha, beta');
    // The sentence says which three shapes it looked for, so the reader can see
    // what their document is missing rather than guessing.
    expect(result.sentence).toContain('no files array');
    expect(result.sentence).toContain('no resourceType');
    expect(result.sentence).toContain('no verifiableCredential array');
  });

  it('reports a bare JSON array as an array, with its length', () => {
    const result = detect('[{"resourceType":"Patient"}]', 'json-unrecognised');
    expect(result.sentence).toContain('a JSON array of 1 item');
    expect(result.sentence).toContain('not a bare array');
  });
});

// ---------------------------------------------------------------------------
// Health cards and certificates
// ---------------------------------------------------------------------------

/**
 * `shc:/` digits: each character of the JWS as its code point minus 45.
 *
 * Indexed rather than iterated because the input is a compact JWS, which is
 * ASCII by construction, and the encoding is defined per UTF-16 code unit.
 */
function toNumeric(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    out += String(text.charCodeAt(at) - 45).padStart(2, '0');
  }
  return out;
}

describe('a numeric health card', () => {
  const jws = 'eyJ6aXAiOiJERUYi.abc.def';

  it('reads the form a single QR code carries', () => {
    const result = detect(`shc:/${toNumeric(jws)}`, 'shc-numeric');
    expect(result.kind).toBe('shc');
    expect(result.confidence).toBe('certain');
    expect(result.needsKey).toBe(false);
    expect(result.details).toEqual([`${jws.length * 2} digits`]);
    expect(result.sentence).toContain('the form a QR code carries');
  });

  it('recognises a chunked card, and says it came from a multi-part QR code', () => {
    const result = detect(`shc:/1/2/${toNumeric(jws)}`, 'shc-numeric');
    expect(result.kind).toBe('shc');
    expect(result.details).toContain('split across chunks, so it came from a multi-part QR code');
  });

  it('says a digit is missing when the count is odd, rather than failing to decode', () => {
    const result = detect(`shc:/${toNumeric(jws)}7`, 'shc-numeric');
    expect(result.sentence).toContain('digit count is odd');
    expect(result.sentence).toContain('at least one digit is missing');
    // Still openable: the pipeline decodes as far as it can and says where it
    // stopped, which is more useful than refusing the paste.
    expect(result.kind).toBe('shc');
  });
});

describe('an HC1 certificate', () => {
  it('names the family and says what Loupe will not pretend to do', () => {
    const certificate = 'HC1:NCFOXN%TSMAHN-HXZSUFC*PP';
    const result = detect(certificate, 'hcert-base45');
    expect(result.kind).toBe('hcert');
    expect(result.confidence).toBe('certain');
    expect(result.needsKey).toBe(false);
    expect(result.sentence).toContain('EU Digital COVID Certificate and WHO DDCC family');
    // Naming a limit is the honest answer. A half-decode that showed bytes
    // would read as support.
    expect(result.sentence).toContain('does not decode COSE and CBOR');
    expect(result.details).toEqual([
      `${certificate.length - 4} characters of base45 after the HC1: prefix`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// A bare blob, unwrapped exactly once
// ---------------------------------------------------------------------------

describe('base64url with no prefix', () => {
  it('reports what it decodes to, not that it is base64url', () => {
    // People paste the middle of things. "This is base64url" is a fact about
    // the encoding and never the answer the reader wanted.
    const inner = JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: [] });
    const result = detect(stringToBase64url(inner), 'fhir-bundle');
    expect(result.kind).toBe('fhir');
    expect(result.content).toBe(inner);
    expect(result.sentence).toMatch(/^base64url, which decodes to a FHIR Bundle/);
    expect(result.details[0]).toContain('characters of base64url');
  });

  it('admits it does not know, when what it decodes to is not recognisable', () => {
    const result = detect(
      stringToBase64url('nothing here but prose, and plenty of it'),
      'base64url',
    );
    expect(result.kind).toBe('unknown');
    expect(result.confidence).toBe('unsure');
    // The sentence says what an SHL payload WOULD look like, which turns a dead
    // end into a check the reader can run.
    expect(result.sentence).toContain('a JSON object with a url and a key');
    expect(result.details.some((detail) => detail.endsWith('bytes decoded'))).toBe(true);
  });

  it('does not chase a doubly encoded blob past one level', () => {
    // Recursion is capped at one, so this reports honestly as base64url rather
    // than silently peeling layers until something matches.
    const once = stringToBase64url(JSON.stringify({ resourceType: 'Patient' }));
    const result = detect(stringToBase64url(once), 'base64url');
    expect(result.kind).toBe('unknown');
  });

  it('does not claim a bare payload unless it decodes to url and key', () => {
    // A base64url blob that decodes to JSON without both members is not a link:
    // otherwise every encoded object in the world is a candidate.
    const result = detect(stringToBase64url(JSON.stringify({ url: URL_IN_LINK })), 'base64url');
    expect(result.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// The paste that comes back from a curl command
// ---------------------------------------------------------------------------

describe('a pasted HTTP response', () => {
  const manifest = JSON.stringify({
    files: [{ contentType: 'application/fhir+json', embedded: 'e' }],
  });

  it('splits the headers off and detects the body underneath', () => {
    const pasted = [
      'HTTP/2 200 OK',
      'content-type: application/json',
      'access-control-allow-origin: *',
      '',
      manifest,
    ].join('\r\n');

    const result = detect(pasted, 'manifest-json');
    expect(result.kind).toBe('manifest');
    // The body, with the wrapper peeled off, is what the pipeline gets.
    expect(result.content).toBe(manifest);
    expect(result.sentence).toMatch(/^An HTTP 200 response, pasted with its headers\./);
    expect(result.httpResponse?.status).toBe(200);
    expect(result.httpResponse?.headers['access-control-allow-origin']).toBe('*');
    expect(result.details).toContain('HTTP 200 OK');
    expect(result.details).toContain('access-control-allow-origin: *');
    expect(result.details).toContain('one response block');
  });

  it('counts the header blocks, because -L prints one per hop', () => {
    const pasted = [
      'HTTP/2 302 Found',
      'location: https://elsewhere.example.org/m',
      '',
      'HTTP/2 200 OK',
      'content-type: application/json',
      '',
      manifest,
    ].join('\r\n');
    const result = detect(pasted, 'manifest-json');
    // The LAST block describes the body, and the count is the redirect evidence
    // a browser refuses to expose to script.
    expect(result.httpResponse?.status).toBe(200);
    expect(result.details).toContain('2 response blocks, so at least 1 redirect');
  });

  it('calls out a missing CORS header, which is the one a browser needs', () => {
    const pasted = ['HTTP/1.1 200 OK', 'content-type: application/json', '', manifest].join('\r\n');
    const result = detect(pasted, 'manifest-json');
    expect(result.details).toContain(
      'no access-control-allow-origin header, which is what a browser needs',
    );
  });

  it('reports the status and the headers when there is no body at all', () => {
    const pasted = ['HTTP/1.1 404 Not Found', 'content-length: 0', ''].join('\r\n');
    const result = detect(pasted, 'unrecognised');
    expect(result.httpResponse?.status).toBe(404);
    expect(result.httpResponse?.statusText).toBe('Not Found');
    expect(result.content).toBe('');
    expect(result.sentence).toContain('an HTTP response with no body');
  });
});

// ---------------------------------------------------------------------------
// The union is closed
// ---------------------------------------------------------------------------

it('has an assertion for every variant the union declares', () => {
  // A new variant with no test is the failure this guards: the list below is
  // written out, so adding a member to `DetectedVariant` fails the typecheck
  // here until it is covered above.
  const covered: Record<DetectedVariant, true> = {
    empty: true,
    'shlink-uri': true,
    'shlink-uri-double-slash': true,
    'viewer-fragment': true,
    'viewer-query': true,
    'bare-payload': true,
    'shc-numeric': true,
    'shc-file': true,
    'jws-compact': true,
    'jwe-compact': true,
    'manifest-json': true,
    'fhir-bundle': true,
    'fhir-resource': true,
    'hcert-base45': true,
    base64url: true,
    'json-unrecognised': true,
    unrecognised: true,
  };
  expect(Object.keys(covered)).toHaveLength(17);
});
