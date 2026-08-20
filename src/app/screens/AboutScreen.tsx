/**
 * About: what this is, and what it never does.
 *
 * The privacy section is written as claims with a way to check each one, which is
 * the only form of privacy statement worth anything in a tool that handles other
 * people's clinical data on borrowed laptops. "Nothing is uploaded" is a promise;
 * "open the network panel and compare it with the trace, which lists every
 * request" is a claim somebody can falsify in ten seconds. Anything that could
 * only be taken on trust is written as a limit instead, in the section below it.
 *
 * The limits section is not modesty. Every one of those four sentences is a thing
 * a participant at an event will otherwise read as a defect in this tool, and
 * saying it first is what keeps the rest of the page credible.
 */
import type { ReactNode } from 'react';
import { BookOpen, ExternalLink, Landmark, ShieldCheck, WifiOff } from 'lucide-react';
import { version } from '../../../package.json';
import { GUIDE_SECTIONS } from '../../content/spec-guide';
import { STATIC_RULES } from '../../core/diagnose/rules';
import { GLOSSARY } from '../../content/glossary';
import { Callout, Chip } from '../../ui/primitives';
import { PageNav, type PageNavItem } from '../PageNav';

const SHL_SPEC =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html';
const SHC_SPEC =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/cards-specification.html';
const SHC_WEB_READER = 'https://github.com/the-commons-project/shc-web-reader';

interface Claim {
  claim: string;
  detail: string;
  /** How somebody who does not trust this page can check the claim themselves. */
  check: string;
}

/**
 * Each claim is checkable from the page itself, with no access to the source.
 * Where a claim depends on how the page is served rather than on its code, it
 * says so: the Content-Security-Policy belongs to the deployment, so it is
 * described as the shipped deployment's, not as a property of the tool.
 */
const CLAIMS: readonly Claim[] = [
  {
    claim: 'Everything runs in this tab',
    detail:
      'There is no backend to run anything else on. The payload is decrypted here with WebCrypto, and a signature is verified here against a key set fetched from the issuer named in the card itself.',
    check:
      'Open the network panel, then open a link. Every entry belongs to the sharing server, a file it named, or an issuer key set. Nothing goes to a server belonging to this tool, because there is not one.',
  },
  {
    claim: 'The only requests made are the ones the trace lists',
    detail:
      'Every request goes through one transport seam, and that seam is what records the trace, so a request that does not appear in the trace is a request the code cannot make. The reachability and DNS probes are off by default, and the DNS one is off specifically because it reaches a third-party resolver.',
    check:
      'Compare the network panel with the trace, request by request. They are the same list, in the same order, with the same timings.',
  },
  {
    claim: 'Nothing is persisted except preferences',
    detail:
      'Local storage holds one key, loupe.settings, carrying the theme, the larger-text preference, the recipient string, the embedded-length maximum and the two probe toggles. No link, key, passcode, manifest or decrypted payload is written to it, and a session ends when the tab does.',
    check:
      'Open a link, then read localStorage in the console. Search it for the key from the link, or for a patient name from the payload: neither is there.',
  },
  {
    claim: 'The key never leaves the page, and is stripped from anything exported',
    detail:
      'A run holds the key in full, because the person looking at it is holding the link and is entitled to see their own key. Redaction happens once, at the export boundary, so a copied report or a copied command carries a redaction marker where the key was. The UI masks it too, behind an explicit reveal.',
    check:
      'Open a link, copy the diagnosis, and search what you pasted for the key. It reads as redacted. A copied curl command does not need the key at all: the key decrypts the file after it arrives, it is not a credential any server checks.',
  },
  {
    claim: 'Nothing is fetched from anywhere else, ever',
    detail:
      'No content delivery network, no web font, no icon host, no analytics, no error reporting. The QR decoder’s WebAssembly is served from this bundle. In the deployment this ships with, the Content-Security-Policy also leaves https: out of img-src, so a remote image URL inside somebody’s bundle cannot phone home just by being rendered.',
    check:
      'Unplug the network and reload. The page renders identically, and every sample that carries its own content still opens. That matters when the venue wifi is itself the thing under investigation.',
  },
];

interface Limit {
  title: string;
  detail: string;
}

const LIMITS: readonly Limit[] = [
  {
    title: 'A browser will not say why a cross-origin request failed',
    detail:
      'DNS, a refused connection, a rejected certificate and a missing CORS header all arrive as the same bare TypeError. That is deliberate on the platform’s part, since a page that could tell them apart would be a port scanner. So this tool offers a ranked differential and a test per branch, and it says plainly that it is a differential rather than an answer.',
  },
  {
    title: 'There is no proxy, so a server without CORS cannot be read from here',
    detail:
      'Adding one would mean sending somebody’s link, key and payload through a machine of ours, which is the one thing this tool is built not to do. When a server has no CORS headers, the honest route is the copyable command it hands you: run the request from a shell and paste the response into Offline mode, where the same pipeline runs over it with no network at all.',
  },
  {
    title: 'Terminology display is limited to what ships in the page',
    detail:
      'A code with no display text stays a code. There is no terminology server call, because that would send clinical codes from somebody’s record to a third party, and a minified health card is stripped of display text by design. So a bare code on screen is the payload being honest, not the renderer failing.',
  },
  {
    title: 'A conformance opinion here is not a validator’s',
    detail:
      'The checks are against the SMART Health Links and Health Cards specifications, and against what browsers actually do. Whether a FHIR bundle conforms to a profile it claims is a different question, answered by a validator with that implementation guide loaded, and this tool does not pretend to answer it.',
  },
];

const NAV_ITEMS: readonly PageNavItem[] = [
  { anchor: 'about-why', label: 'Why it exists' },
  { anchor: 'about-who', label: 'Who it is for' },
  { anchor: 'about-privacy', label: 'What it never does' },
  { anchor: 'about-limits', label: 'What it cannot do' },
  { anchor: 'about-credits', label: 'Credits and specs' },
];

export function AboutScreen(): ReactNode {
  return (
    <div className="about">
      <div className="page-body">
        <PageNav items={NAV_ITEMS} label="Sections of this page" />

        <div className="page-column">
          <header className="about-head">
            <h1>SHLoupe</h1>
            <p className="about-lede">
              A SMART Health Link viewer, debugger and teaching tool that runs entirely in one
              browser tab. No backend, no upload, no account. You paste a link and it shows every
              step it takes, what each step observed, and who has to act when a step fails.
            </p>
            <p className="about-version">
              <Chip>version {version}</Chip>
              <Chip tone="skip">{STATIC_RULES.length} checks</Chip>
              <Chip tone="skip">{GUIDE_SECTIONS.length} guide sections</Chip>
              <Chip tone="skip">{GLOSSARY.length} glossary terms</Chip>
            </p>
          </header>

          <section className="about-section" aria-labelledby="about-why" tabIndex={-1}>
            <h2 id="about-why">Why it exists</h2>
            <p>
              A link sent in good faith at a testing event pointed at{' '}
              <code>https://localhost:5173/api/shl-manifest?bid=4836470</code>. The sender had
              tested it, and it worked, because localhost names the machine doing the asking: that
              link can only ever open on the machine that minted it. The viewer everyone reached for
              reported “TypeLoad failed”, which is not a protocol error at all but a browser’s
              TypeError with the middle of a word eaten by a careless string replacement. So the
              recipient saw a broken viewer, the sender saw a working link, and the finding, which
              needed no network access to reach, was never stated.
            </p>
            <p>
              This tool says it in one sentence before making any request, and names two more true
              things about the same URL at the same time: it is a development server port, and{' '}
              <code>?bid=4836470</code> carries nowhere near the entropy the specification requires,
              so that server’s links can be enumerated by anybody who has seen one.
            </p>
          </section>

          <section className="about-section" aria-labelledby="about-who" tabIndex={-1}>
            <h2 id="about-who">Who it is for</h2>
            <ul className="about-list">
              <li>
                <strong>Anyone handed a link that will not open.</strong> The trace says which step
                stopped, what it observed, and whose problem it is, in words you can repeat to the
                person who has to fix it.
              </li>
              <li>
                <strong>Whoever built the sharing server.</strong> Every hop copies out as a curl or
                PowerShell command, with the key redacted, so a server operator can reproduce a
                browser’s failure from a shell where CORS does not exist.
              </li>
              <li>
                <strong>Whoever is writing a viewer.</strong> The sandbox mints links that are wrong
                in one specific way each, which is a better test suite for a receiving application
                than a handful of correct links.
              </li>
              <li>
                <strong>Anyone learning the format.</strong> The Learn screen is the specification
                laid out as the life of one link, with every normative sentence quoted verbatim and
                linked back to its own section.
              </li>
            </ul>
          </section>

          <section className="about-section" aria-labelledby="about-privacy" tabIndex={-1}>
            <h2 id="about-privacy">
              <ShieldCheck size={16} aria-hidden />
              <span>Privacy, as claims you can check</span>
            </h2>
            <p>
              This tool handles other people’s clinical data on borrowed laptops at events, so the
              posture is a design constraint rather than a policy page. Each claim below is written
              so you can falsify it from this page, without reading the source.
            </p>
            <ol className="about-claims">
              {CLAIMS.map((claim) => (
                <li key={claim.claim}>
                  <h3>{claim.claim}</h3>
                  <p>{claim.detail}</p>
                  <p className="about-check">
                    <span className="about-check-label">How to check it</span>
                    <span>{claim.check}</span>
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section className="about-section" aria-labelledby="about-limits" tabIndex={-1}>
            <h2 id="about-limits">
              <WifiOff size={16} aria-hidden />
              <span>What it cannot do</span>
            </h2>
            <dl className="about-limits">
              {LIMITS.map((limit) => (
                <div key={limit.title}>
                  <dt>{limit.title}</dt>
                  <dd>{limit.detail}</dd>
                </div>
              ))}
            </dl>
            <Callout tone="info" title="Offline mode is the answer to most of these">
              Paste a manifest response, a JWE or a bundle you already have, and the same pipeline
              runs over it with no network at all: the same steps, the same evidence, the same
              findings. It is also how a link on a server with no CORS headers gets read at all.
            </Callout>
          </section>

          <section className="about-section" aria-labelledby="about-credits" tabIndex={-1}>
            <h2 id="about-credits">
              <Landmark size={16} aria-hidden />
              <span>Credits and specifications</span>
            </h2>
            <p>
              FHIR display groundwork comes from{' '}
              <a href={SHC_WEB_READER} target="_blank" rel="noreferrer noopener">
                the-commons-project/shc-web-reader
                <ExternalLink size={12} aria-hidden />
              </a>{' '}
              (MIT, copyright 2023 The Commons Project): the shape of its per-resource renderer
              registry, and the set of display primitives it accumulated over years of real
              payloads, including date-precision handling, the effective[x] choice-element mess, and
              quantity, range, dosage and timing rendering. The equivalents here are written fresh
              in TypeScript rather than copied line for line, and its notice is retained accordingly
              in THIRD-PARTY-NOTICES.md alongside every other component shipped in the bundle.
            </p>
            <ul className="about-links">
              <li>
                <BookOpen size={13} aria-hidden />
                <a href={SHL_SPEC} target="_blank" rel="noreferrer noopener">
                  SMART Health Links specification
                  <ExternalLink size={12} aria-hidden />
                </a>
              </li>
              <li>
                <BookOpen size={13} aria-hidden />
                <a href={SHC_SPEC} target="_blank" rel="noreferrer noopener">
                  SMART Health Cards specification
                  <ExternalLink size={12} aria-hidden />
                </a>
              </li>
            </ul>
            <p className="about-disclaimer">
              Not affiliated with HL7, with The Commons Project, or with any implementer whose link
              it opens. Where it disagrees with the specification, the specification is right: that
              is why every quote on the Learn screen carries a link to the section it came from.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
