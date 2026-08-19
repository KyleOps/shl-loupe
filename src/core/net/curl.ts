/**
 * "Run this yourself" commands.
 *
 * A browser cannot see why a cross-origin request failed, and Loupe has no
 * backend to ask on its behalf. So the honest escape hatch is to hand the user
 * the exact command that WILL see it, from a shell where CORS does not exist.
 * Getting these copy-paste correct is a feature, not a nicety: at an event
 * nobody has patience for a command that needs editing first.
 *
 * The key is never included. A manifest request does not need it (the key
 * decrypts the files, it is not an access credential), so a copied command is
 * safe to paste into a group chat, and Loupe says so.
 */
import type { ShlLink } from '../shlink';

export interface ManifestRequestShape {
  url: string;
  recipient: string;
  passcode?: string;
  embeddedLengthMax?: number;
}

export function manifestBody(shape: ManifestRequestShape): string {
  const body: Record<string, unknown> = { recipient: shape.recipient };
  if (shape.passcode !== undefined) body.passcode = shape.passcode;
  if (shape.embeddedLengthMax !== undefined) body.embeddedLengthMax = shape.embeddedLengthMax;
  return JSON.stringify(body);
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A curl command that shows the whole story: the redirect chain, the response
 * headers the browser hid, and the body pretty-printed if jq is present.
 */
export function curlForManifest(shape: ManifestRequestShape, options: { passcode?: boolean } = {}): string {
  const body = manifestBody({
    ...shape,
    ...(options.passcode === true && shape.passcode === undefined ? { passcode: 'PASSCODE' } : {}),
  });
  return [
    'curl -sS -L -D - -o - \\',
    `  -X POST ${shellQuote(shape.url)} \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d ${shellQuote(body)}`,
  ].join('\n');
}

/** The same request as a preflight, which is what a browser actually sends first. */
export function curlForPreflight(url: string, origin: string): string {
  return [
    'curl -sS -i -X OPTIONS \\',
    `  ${shellQuote(url)} \\`,
    `  -H ${shellQuote(`Origin: ${origin}`)} \\`,
    "  -H 'Access-Control-Request-Method: POST' \\",
    "  -H 'Access-Control-Request-Headers: content-type'",
  ].join('\n');
}

export function curlForDirectFile(url: string): string {
  return `curl -sS -L -D - -o shl-file.jwe ${shellQuote(url)}`;
}

export function powershellForManifest(shape: ManifestRequestShape): string {
  const body = manifestBody(shape).replace(/"/g, '""');
  return [
    `$body = '${body}'`,
    `Invoke-WebRequest -Method POST -Uri "${shape.url}" \``,
    '  -ContentType "application/json" -Body $body -MaximumRedirection 5 |',
    '  Select-Object StatusCode, Headers, Content | Format-List',
  ].join('\n');
}

/**
 * A one-liner that fetches the manifest and prints just what Loupe needs pasted
 * back into offline mode.
 */
export function curlForOfflineHandoff(shape: ManifestRequestShape): string {
  return [
    `curl -sS -X POST ${shellQuote(shape.url)} \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d ${shellQuote(manifestBody(shape))} | tee shl-manifest.json`,
    '',
    '# Then paste the contents of shl-manifest.json into Loupe under "Offline".',
  ].join('\n');
}

/** The OPTIONS response a browser needs, as a checklist for the server operator. */
export function corsRequirementsFor(origin: string): Array<{ header: string; value: string }> {
  return [
    { header: 'Access-Control-Allow-Origin', value: `${origin} (or *)` },
    { header: 'Access-Control-Allow-Methods', value: 'POST, GET, OPTIONS' },
    { header: 'Access-Control-Allow-Headers', value: 'content-type' },
    { header: 'Access-Control-Max-Age', value: '600 (optional, avoids a preflight per request)' },
  ];
}

/** Everything a sender needs to reproduce the failure outside a browser. */
export function reproductionBundle(link: ShlLink, recipient: string, viewerOrigin: string): string {
  const shape: ManifestRequestShape = { url: link.url, recipient };
  return [
    '# 1. Does the server answer the browser preflight?',
    curlForPreflight(link.url, viewerOrigin),
    '',
    '# 2. Does the manifest request itself work outside a browser?',
    curlForManifest(shape),
  ].join('\n');
}
