/**
 * The sample catalogue: everything Loupe can open without asking anybody for a
 * link.
 *
 * Two jobs, and they pull in different directions, which is why this is a
 * catalogue rather than a folder of files.
 *
 * The first is offline usefulness. A static viewer at a testing event is on
 * conference wifi, behind a captive portal, or on a laptop that has never seen
 * this tool before. Everything in here that carries `content` runs the render
 * path with the network unplugged.
 *
 * The second is teaching. Walking a room through a correct link has to take one
 * keystroke, or it does not happen: you are standing at someone else's laptop
 * with about ninety seconds of their attention. So each sample states what it is
 * FOR, in `teaches`, and the catalogue is ordered so the first two entries are
 * the ones to reach for in that ninety seconds.
 *
 * Two of these are live links, and they are special: the implementation guide's
 * own examples are, as far as I can find, the only SMART Health Links in the
 * world that a static browser-only viewer can rely on. They are served from
 * raw.githubusercontent.com, which sends `Access-Control-Allow-Origin: *`, they
 * carry the U flag so there is no manifest POST and therefore no CORS preflight,
 * and they are static files that do not expire. Every other link a viewer meets
 * needs a server operator to have thought about browsers.
 *
 * Nothing here is confidential. Both live examples use the key published in the
 * specification's own encryption example, and the Platypus payloads are
 * synthetic. That is what makes them safe to project.
 */
import type { FileKind } from '../core/pipeline';
import { IG_IPS_BUNDLE } from './ips-bundle';
import { IG_SHC_FILE } from './shc-card';
import { PLATYPUS_AU_PS_BUNDLE, PLATYPUS_COLLECTION_BUNDLE } from './platypus';

export { IG_IPS_BUNDLE, type FixtureBundle } from './ips-bundle';
export { IG_SHC_FILE, IG_SHC_JWE, IG_EXAMPLE_KEY, type SmartHealthCardFile } from './shc-card';
export { PLATYPUS_AU_PS_BUNDLE, PLATYPUS_COLLECTION_BUNDLE, NESTED_SHLINK } from './platypus';

/**
 * What a sample resolves to, using the same vocabulary the pipeline classifies
 * decrypted files with, so a sample's declared kind is a claim the test suite can
 * check against `classifyContent` rather than a label nobody verifies.
 *
 * `sandbox` is the one addition: an entry that is a signpost rather than a
 * payload, carrying neither a link nor content.
 */
export type SampleKind = FileKind | 'sandbox';

export interface Sample {
  /** Stable, kebab-case. Safe to put in a URL or a keyboard shortcut. */
  id: string;
  /** Short noun phrase. What it is, not what it demonstrates. */
  title: string;
  /** Two to four sentences: what this is, where it came from, what is odd about it. */
  description: string;
  kind: SampleKind;
  /** Present when the sample is a link to open. Costs a network request. */
  link?: string;
  /** Present when the sample is already-decrypted content. Costs nothing. */
  content?: unknown;
  /** One line: why you would reach for this one. This is the teaching hook. */
  teaches: string;
}

/**
 * The IG's IPS example, in the bare form a QR code carries.
 *
 * `shlink:/` takes ONE slash. It is not an authority-based URI, so there is no
 * `//` host part, and `shlink` is not an IANA-registered scheme either, which is
 * why pasting this into a browser address bar does nothing at all.
 */
const IG_IPS_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

/**
 * The IG's health-card example, in the viewer-prefixed form the IG publishes it
 * in, pointing at the viewer from the incident that motivated this tool.
 *
 * Kept prefixed on purpose. The payload after the `#` is byte-identical to the
 * bare form, and that is the whole point of the convention: a fragment is never
 * sent to a server, so the decryption key inside the payload does not reach the
 * viewer's own host, its proxy or its access log. Move the same payload into a
 * query string and you have published the key.
 */
const IG_SHC_LINK =
  'https://viewer.tcpdev.org/shlink.html#shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9jYXJkcy9jYXJpbi1pbnN1cmFuY2UtZXhhbXBsZS9qd3MudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIGNhcmluLWluc3VyYW5jZS1leGFtcGxlIn0';

export const SAMPLES: Sample[] = [
  {
    id: 'ig-ips-link',
    title: 'Live link: IPS document',
    description:
      "The first working example on the implementation guide's links-examples page, unmodified. It carries the LU flags, so Loupe fetches one file by GET and never asks for a manifest, and the file is a static object on raw.githubusercontent.com, which is CORS-open. Opening it makes exactly one cross-origin request.",
    kind: 'fhir',
    link: IG_IPS_LINK,
    teaches:
      'The happy path, end to end, over a real network: link, direct fetch, JWE, decrypt, FHIR document.',
  },
  {
    id: 'ig-shc-link',
    title: 'Live link: signed health card',
    description:
      "The guide's second working example, a CARIN insurance card, wrapped in the viewer URL the guide publishes it with. It is the only sample that exercises the whole stack a SMART Health Card adds: after decryption there is a verifiableCredential array, and inside that a compact JWS whose payload is raw-DEFLATE compressed and whose ES256 signature is checked against a JWKS at the issuer.",
    kind: 'smart-health-card',
    link: IG_SHC_LINK,
    teaches:
      'That a link, a card and a signature are three separate things, and which of them a failure belongs to.',
  },
  {
    id: 'ig-ips-bundle',
    title: 'IPS document, already decrypted',
    description:
      'The plaintext behind the live IPS link, bundled so the renderer can be exercised with no network at all. Twenty entries, first a Composition, and no meta.profile anywhere: this example claims no IPS conformance on the wire, so it is a good test of a viewer that keys its layout off a profile canonical.',
    kind: 'fhir',
    content: IG_IPS_BUNDLE,
    teaches: 'How a real IPS document renders, on a laptop with no connection.',
  },
  {
    id: 'ig-shc-card',
    title: 'Health card file, already decrypted',
    description:
      'The verifiableCredential file behind the live card link. Verifying its signature needs the issuer\'s JWKS, so offline it stops at "signature not checked", which is the honest answer and worth seeing stated as one rather than as a failure.',
    kind: 'smart-health-card',
    content: IG_SHC_FILE,
    teaches: 'The difference between a signature that failed and a signature nobody could check.',
  },
  {
    id: 'platypus-au-ps',
    title: 'AU Patient Summary, Platypus shaped',
    description:
      'A document Bundle built from the real output of Platypus, an Australian personal health record, at about a tenth of the size. Nine sections, one of them empty; SNOMED CT-AU codes that do not exist in the International edition; a mandated element stated absent in an underscore-prefixed sibling; a medication whose concept is a contained resource; and an asserted party named in text with no Organization behind it.',
    kind: 'fhir',
    content: PLATYPUS_AU_PS_BUNDLE,
    teaches:
      'The nine things a real Australian summary does that break a viewer written against a tidier producer.',
  },
  {
    id: 'platypus-collection',
    title: 'Record collection, Platypus shaped',
    description:
      'The same producer choosing individual records instead of a summary. No Composition, no profile, no identifier and no Patient entry, so one subject reference dangles and another is missing outright. One entry is a preserved health link, which makes it a link inside a payload.',
    kind: 'fhir',
    content: PLATYPUS_COLLECTION_BUNDLE,
    teaches:
      'That a collection asserts nothing about completeness, so a dangling reference in one is not a defect.',
  },
  {
    id: 'broken-link-presets',
    title: 'Deliberately broken links',
    description:
      'Not a payload. The Sandbox screen mints links that are wrong in one specific way each, from the presets in src/core/mint.ts: a localhost manifest URL, a key of the wrong length, an exp in milliseconds, flags that cannot be combined, a payload put in a query string. They are for pointing at another viewer to see what it says.',
    kind: 'sandbox',
    teaches: 'What each failure looks like when you already know which one you caused.',
  },
];

/** Look one up by id, for a deep link or a keyboard shortcut. */
export function sampleById(id: string): Sample | undefined {
  return SAMPLES.find((sample) => sample.id === id);
}
