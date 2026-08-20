/**
 * The bundle index and the reference resolver.
 *
 * A payload is a pile of resources that point at each other, and almost every
 * interesting thing a viewer says ("this medication was authorised by Dr Chen")
 * is a reference resolution. The reference implementation resolves references
 * with one string lookup against a map keyed by `fullUrl` and by
 * `ResourceType/id`, which means an absolute reference never resolves, a
 * relative reference in a `urn:uuid` bundle never resolves, and both failures
 * surface as a `console.log` and a missing row. That is the class of defect this
 * module exists to make impossible.
 *
 * Three commitments:
 *
 *  1. **Dual keying.** Every entry is indexed by `fullUrl` and by
 *     `ResourceType/id`, so a payload that disagrees with itself about which
 *     form it uses still resolves. Platypus emits exactly that: a fresh
 *     `urn:uuid:` `fullUrl` over a resource whose `id` is still the source
 *     server's.
 *  2. **Positive signal only.** A reference with no target in the bundle
 *     resolves to nothing. It is never pointed at something plausible, and the
 *     UI renders the row without a tap-through rather than as a broken link. A
 *     conformant Platypus summary ships around 26 unresolvable references by
 *     design (`PractitionerRole`, `Encounter`, `Location` the app does not
 *     hold), so treating one as an error would report a defect that is not there.
 *  3. **The reason is kept.** "Did not resolve" is four different facts, and the
 *     interesting one (a relative reference inside a `urn:uuid` bundle has no
 *     defined meaning per R4 2.36.4.1, because there is no base to make it
 *     absolute against) is the one people rediscover at every event.
 */
import {
  arrField,
  asArray,
  asRecord,
  asString,
  identifierText,
  resourceTypeOf,
  strField,
  type FhirNode,
} from './display';

export interface IndexedEntry {
  /** Position in the flattened entry list. Stable, and used as the React key. */
  index: number;
  fullUrl?: string;
  resource: FhirNode;
  resourceType: string;
  id?: string;
  versionId?: string;
  /** Set when this entry came from a Bundle nested inside another entry. */
  nestedIn?: number;
}

/** How a resolution was reached. The UI says so, because it is teachable. */
export type ResolutionVia = 'fullUrl' | 'type-id' | 'relative-base';

export type UnresolvedReason =
  | 'no-reference'
  | 'relative-against-urn-uuid'
  | 'no-match'
  | 'ambiguous';

export type Resolution =
  | { kind: 'resolved'; entry: IndexedEntry; via: ResolutionVia; note?: string }
  | { kind: 'contained'; resource: FhirNode; resourceType: string; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'unresolved'; reason: UnresolvedReason; detail: string; label?: string };

export interface ReferenceCensus {
  total: number;
  resolved: number;
  contained: number;
  external: number;
  unresolved: number;
  byReason: Record<UnresolvedReason, number>;
}

export interface BundleIndex {
  /** The resource the file actually carried, Bundle or not. */
  root: FhirNode;
  isBundle: boolean;
  bundleType?: string;
  entries: IndexedEntry[];
  byType: ReadonlyMap<string, IndexedEntry[]>;
  /** Types present, most numerous first, then alphabetically. */
  typeCounts: Array<{ resourceType: string; count: number }>;
  /** The first Composition, which is what makes a payload a document. */
  composition?: IndexedEntry;
  patient?: IndexedEntry;
  /** Entries with no `fullUrl`. IPS and AU PS both make it 1..1. */
  missingFullUrl: number;
  /** Keys that two or more entries claim. R4 calls the resolution ambiguous. */
  duplicateKeys: string[];
  resolve(reference: unknown, from?: IndexedEntry): Resolution;
  entryAt(index: number): IndexedEntry | undefined;
}

/**
 * The RESTful URL shape from R4's own regex, loosened only where the strict
 * version would reject real servers (a resource type it does not know about).
 * The captured root is what a relative reference is made absolute against.
 */
const RESTFUL =
  /^((?:[a-z][a-z0-9+.-]*:\/\/[^\s]*?\/)?)([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([A-Za-z0-9\-.]{1,64}))?$/;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface ParsedReference {
  /** The reference with any `/_history/x` and any `|version` removed. */
  base: string;
  versionId?: string;
  /** Canonical version, as `Task.focus.reference` carries for a Questionnaire. */
  canonicalVersion?: string;
  restful?: { root: string; resourceType: string; id: string };
}

function parseReference(raw: string): ParsedReference {
  let base = raw.trim();
  let canonicalVersion: string | undefined;
  const pipe = base.indexOf('|');
  if (pipe !== -1) {
    canonicalVersion = base.slice(pipe + 1);
    base = base.slice(0, pipe);
  }
  const match = RESTFUL.exec(base);
  if (match !== null) {
    const [, root, resourceType, id, history] = match;
    return {
      base: history === undefined ? base : base.slice(0, base.indexOf('/_history/')),
      ...(history === undefined ? {} : { versionId: history }),
      ...(canonicalVersion === undefined ? {} : { canonicalVersion }),
      restful: { root: root ?? '', resourceType: resourceType as string, id: id as string },
    };
  }
  return {
    base,
    ...(canonicalVersion === undefined ? {} : { canonicalVersion }),
  };
}

/** A `urn:` fullUrl has no root, so nothing relative can be made absolute. */
function isUrn(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase().startsWith('urn:');
}

export function buildBundleIndex(rootValue: unknown): BundleIndex {
  const root = asRecord(rootValue) ?? {};
  const isBundle = resourceTypeOf(root) === 'Bundle';
  const entries: IndexedEntry[] = [];

  const collect = (bundle: FhirNode, nestedIn?: number): void => {
    for (const raw of arrField(bundle, 'entry')) {
      const resource = asRecord(asRecord(raw)?.['resource']);
      const fullUrl = strField(raw, 'fullUrl');
      if (resource === undefined) {
        // A reference-only entry is legal in a searchset and forbidden in a
        // document. Keeping a placeholder is what stops the entry count on
        // screen disagreeing with the entry count on the wire.
        entries.push({
          index: entries.length,
          ...(fullUrl === undefined ? {} : { fullUrl }),
          resource: {},
          resourceType: 'entry with no resource',
          ...(nestedIn === undefined ? {} : { nestedIn }),
        });
        continue;
      }
      const index = entries.length;
      const id = strField(resource, 'id');
      const versionId = strField(asRecord(resource['meta']), 'versionId');
      entries.push({
        index,
        ...(fullUrl === undefined ? {} : { fullUrl }),
        resource,
        resourceType: resourceTypeOf(resource) ?? 'Resource with no resourceType',
        ...(id === undefined ? {} : { id }),
        ...(versionId === undefined ? {} : { versionId }),
        ...(nestedIn === undefined ? {} : { nestedIn }),
      });
      // A Bundle nested as an entry is rare and is exactly where a resource
      // goes missing, so its entries are flattened in and accounted for too.
      if (resourceTypeOf(resource) === 'Bundle') collect(resource, index);
    }
  };

  if (isBundle) {
    collect(root);
  } else if (resourceTypeOf(root) !== undefined) {
    const id = strField(root, 'id');
    entries.push({
      index: 0,
      resource: root,
      resourceType: resourceTypeOf(root) as string,
      ...(id === undefined ? {} : { id }),
    });
  }

  const byFullUrl = new Map<string, IndexedEntry[]>();
  const byTypeId = new Map<string, IndexedEntry[]>();
  const byType = new Map<string, IndexedEntry[]>();
  const push = (map: Map<string, IndexedEntry[]>, key: string, entry: IndexedEntry): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [entry]);
    else list.push(entry);
  };

  for (const entry of entries) {
    if (entry.fullUrl !== undefined) {
      push(byFullUrl, entry.fullUrl, entry);
      // A fullUrl carrying a version is matched versionless too, per R4.
      const parsed = parseReference(entry.fullUrl);
      if (parsed.base !== entry.fullUrl) push(byFullUrl, parsed.base, entry);
    }
    if (entry.id !== undefined) push(byTypeId, `${entry.resourceType}/${entry.id}`, entry);
    push(byType, entry.resourceType, entry);
  }

  const duplicateKeys = [
    ...[...byFullUrl.entries()].filter(([, list]) => list.length > 1).map(([key]) => key),
    ...[...byTypeId.entries()].filter(([, list]) => list.length > 1).map(([key]) => key),
  ];

  const typeCounts = [...byType.entries()]
    .map(([resourceType, list]) => ({ resourceType, count: list.length }))
    .sort((a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType));

  const resolve = (reference: unknown, from?: IndexedEntry): Resolution => {
    const record = asRecord(reference);
    const refString = record === undefined ? asString(reference) : strField(record, 'reference');

    if (refString === undefined) {
      const label =
        (record === undefined ? undefined : strField(record, 'display')) ??
        identifierText(record?.['identifier']);
      return {
        kind: 'unresolved',
        reason: 'no-reference',
        detail:
          label === undefined
            ? 'This reference carries no reference, identifier or display, so there is nothing to point at.'
            : 'This reference names its target without a URL, so there is nothing in the bundle to match it against.',
        ...(label === undefined ? {} : { label }),
      };
    }

    if (refString.startsWith('#')) {
      const id = refString.slice(1);
      const holders = [from?.resource, root].filter(
        (holder): holder is FhirNode => holder !== undefined,
      );
      for (const holder of holders) {
        for (const candidate of arrField(holder, 'contained')) {
          const contained = asRecord(candidate);
          if (contained === undefined) continue;
          if (strField(contained, 'id') !== id) continue;
          return {
            kind: 'contained',
            resource: contained,
            resourceType: resourceTypeOf(contained) ?? 'Resource with no resourceType',
            id,
          };
        }
      }
      return {
        kind: 'unresolved',
        reason: 'no-match',
        detail: `Nothing in this resource's contained list has the id "${id}".`,
      };
    }

    const parsed = parseReference(refString);

    const fromMap = (
      map: Map<string, IndexedEntry[]>,
      key: string,
    ): { entry?: IndexedEntry; ambiguous?: boolean } => {
      const list = map.get(key);
      if (list === undefined || list.length === 0) return {};
      if (list.length > 1) return { ambiguous: true };
      return { entry: list[0] as IndexedEntry };
    };

    const versionNote = (entry: IndexedEntry): string | undefined => {
      if (parsed.versionId === undefined) return undefined;
      if (entry.versionId === parsed.versionId) return undefined;
      return entry.versionId === undefined
        ? `The reference asks for version ${parsed.versionId}; the entry in this bundle states no meta.versionId, so the version could not be checked.`
        : `The reference asks for version ${parsed.versionId}; this bundle carries version ${entry.versionId}.`;
    };

    const resolved = (entry: IndexedEntry, via: ResolutionVia, note?: string): Resolution => {
      const combined = [note, versionNote(entry)].filter(
        (part): part is string => part !== undefined,
      );
      return {
        kind: 'resolved',
        entry,
        via,
        ...(combined.length === 0 ? {} : { note: combined.join(' ') }),
      };
    };

    const absolute = HAS_SCHEME.test(parsed.base);

    if (absolute) {
      const exact = fromMap(byFullUrl, parsed.base);
      if (exact.ambiguous === true) {
        return {
          kind: 'unresolved',
          reason: 'ambiguous',
          detail: `Two or more entries carry the fullUrl ${parsed.base}, so R4 leaves it undefined which one this means.`,
        };
      }
      if (exact.entry !== undefined) return resolved(exact.entry, 'fullUrl');

      if (parsed.restful !== undefined) {
        const key = `${parsed.restful.resourceType}/${parsed.restful.id}`;
        const byId = fromMap(byTypeId, key);
        if (byId.ambiguous === true) {
          return {
            kind: 'unresolved',
            reason: 'ambiguous',
            detail: `Two or more entries are ${key}, so it is undefined which one this absolute reference means.`,
          };
        }
        if (byId.entry !== undefined) {
          // The known failure: a bundle assembled by copying resources off a
          // REST server keeps their absolute references while giving every
          // entry a fresh urn:uuid fullUrl, so nothing matches by fullUrl.
          return resolved(
            byId.entry,
            'type-id',
            `No entry has this fullUrl, so it was matched on ${key} instead. Strictly, R4 resolves an absolute reference by fullUrl only, so a receiver following the specification to the letter would find nothing here.`,
          );
        }
      }

      if (/^https?:/i.test(parsed.base)) {
        return { kind: 'external', url: parsed.base };
      }
      return {
        kind: 'unresolved',
        reason: 'no-match',
        detail: `No entry in this bundle has the fullUrl ${parsed.base}, and the reference is not a URL that could be fetched.`,
      };
    }

    if (parsed.restful !== undefined) {
      const key = `${parsed.restful.resourceType}/${parsed.restful.id}`;
      const byId = fromMap(byTypeId, key);
      if (byId.ambiguous === true) {
        return {
          kind: 'unresolved',
          reason: 'ambiguous',
          detail: `Two or more entries are ${key}, so it is undefined which one this reference means.`,
        };
      }
      if (byId.entry !== undefined) return resolved(byId.entry, 'type-id');

      const base = from?.fullUrl;
      if (base !== undefined && !isUrn(base)) {
        const baseParsed = parseReference(base);
        if (baseParsed.restful !== undefined && baseParsed.restful.root !== '') {
          const absoluteForm = `${baseParsed.restful.root}${key}`;
          const viaBase = fromMap(byFullUrl, absoluteForm);
          if (viaBase.entry !== undefined) return resolved(viaBase.entry, 'relative-base');
        }
      }

      if (isUrn(base)) {
        return {
          kind: 'unresolved',
          reason: 'relative-against-urn-uuid',
          detail: `A relative reference is resolved against the base implied by its entry's fullUrl, and ${base} is a URN, which implies no base. R4 2.36.4.1 says this reference "has no defined meaning within this specification", so it is a defect in the payload rather than something a viewer can work around.`,
        };
      }
      return {
        kind: 'unresolved',
        reason: 'no-match',
        detail: `No entry in this bundle is ${key}.`,
      };
    }

    return {
      kind: 'unresolved',
      reason: 'no-match',
      detail: `"${refString}" is neither an absolute URL nor a ResourceType/id pair, so there is no way to look it up.`,
    };
  };

  const composition = entries.find((entry) => entry.resourceType === 'Composition');
  const patient = entries.find((entry) => entry.resourceType === 'Patient');
  const bundleType = strField(root, 'type');

  return {
    root,
    isBundle,
    ...(bundleType === undefined ? {} : { bundleType }),
    entries,
    byType,
    typeCounts,
    ...(composition === undefined ? {} : { composition }),
    ...(patient === undefined ? {} : { patient }),
    missingFullUrl: entries.filter((entry) => entry.fullUrl === undefined).length,
    duplicateKeys,
    resolve,
    entryAt: (index) => entries[index],
  };
}

/** Keys that are not references and must not be walked as one. */
const NON_REFERENCE_KEYS = new Set(['fullUrl', 'text', 'div']);

/**
 * Count every reference in the payload and how it resolved.
 *
 * The number is the point: "26 of 208 references are not carried by this
 * bundle" is a fact a sender can act on, whereas 26 silently missing rows is
 * the failure this whole file exists to prevent.
 */
export function censusReferences(index: BundleIndex): ReferenceCensus {
  const census: ReferenceCensus = {
    total: 0,
    resolved: 0,
    contained: 0,
    external: 0,
    unresolved: 0,
    byReason: {
      'no-reference': 0,
      'relative-against-urn-uuid': 0,
      'no-match': 0,
      ambiguous: 0,
    },
  };

  const walk = (node: unknown, from: IndexedEntry, depth: number): void => {
    if (depth > 24) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, from, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (record === undefined) return;
    if (typeof record['reference'] === 'string') {
      census.total += 1;
      const resolution = index.resolve(record, from);
      switch (resolution.kind) {
        case 'resolved':
          census.resolved += 1;
          break;
        case 'contained':
          census.contained += 1;
          break;
        case 'external':
          census.external += 1;
          break;
        default:
          census.unresolved += 1;
          census.byReason[resolution.reason] += 1;
      }
      // A Reference's own members are never themselves references, so the walk
      // stops here rather than descending into `identifier.assigner`.
      return;
    }
    for (const [key, value] of Object.entries(record)) {
      if (NON_REFERENCE_KEYS.has(key)) continue;
      walk(value, from, depth + 1);
    }
  };

  for (const entry of index.entries) walk(entry.resource, entry, 0);
  return census;
}

/**
 * A short label for a resolution, for a chip. Never invents a name: an
 * unresolved reference falls back to what the reference itself said, and then
 * says plainly that the bundle does not carry it.
 */
export function resolutionLabel(resolution: Resolution, fallback?: string): string {
  switch (resolution.kind) {
    case 'resolved':
      return fallback ?? resolution.entry.resourceType;
    case 'contained':
      return fallback ?? resolution.resourceType;
    case 'external':
      return fallback ?? resolution.url;
    default:
      return fallback ?? resolution.label ?? 'Not carried by this bundle';
  }
}

/** Everything not reachable from any of the given entry indices. */
export function unreferencedEntries(
  index: BundleIndex,
  claimed: ReadonlySet<number>,
): IndexedEntry[] {
  return index.entries.filter((entry) => !claimed.has(entry.index));
}

/**
 * Follow a `0..*` reference element to whatever the bundle holds for each item,
 * keeping the resolutions that failed so the caller can say so.
 */
export function resolveAll(
  index: BundleIndex,
  value: unknown,
  from?: IndexedEntry,
): Array<{ reference: unknown; resolution: Resolution }> {
  return asArray(value).map((reference) => ({
    reference,
    resolution: index.resolve(reference, from),
  }));
}
