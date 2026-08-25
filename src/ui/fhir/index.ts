/**
 * The payload area's public surface.
 *
 * `PayloadView` is what a screen needs: hand it an `OpenedFile` and it renders
 * whatever came out of the link, including the cases where nothing did. Everything
 * else exported here is exported because it is worth reading, testing or reusing
 * in isolation, not because a screen reaches for it.
 *
 * The layering, lowest first, since it is the thing to preserve when adding to
 * this area:
 *
 *   display.ts        pure readers over `unknown`, no React
 *   BundleIndex.ts    the dual-keyed index and the positive-signal resolver
 *   Narrative.tsx     the sanitiser boundary and the narrative component
 *   UnknownResource   the datatype leaf formatters and the generic tree
 *   ResourceCard      the card shell and Rendered | Fields | JSON
 *   renderers/*       one module per family of resource types
 *   registry.tsx      type to renderer, and the never-nothing fallback
 *   CompositionView   the document shell
 *   PayloadView       the dispatcher, and the entry accounting
 *
 * Nothing lower imports anything higher, so a new renderer is a leaf change.
 */

export { PayloadView, PayloadSource, FhirPayload } from './PayloadView';
export { CompositionView, claimedEntries, type SectionOrder } from './CompositionView';
export {
  ResourceCard,
  AbsenceAssertionCard,
  DetailTable,
  type CardView,
  type DetailRow,
  type RendererProps,
  type ResourceRenderer,
} from './ResourceCard';
export {
  RESOURCE_RENDERERS,
  RENDERED_TYPES,
  GenericResourceCard,
  RenderedResource,
  hasRenderer,
  rendererFor,
} from './registry';
export {
  DocumentReferenceView,
  BinaryView,
  AttachmentPreview,
  decodeAttachmentData,
  hexDump,
  sniffContentType,
  type Sniffed,
} from './DocumentReferenceView';
export {
  Narrative,
  carriedActiveContent,
  narrativeMayExceedEntries,
  narrativeStatus,
  narrativeStatusMeaning,
  sanitiseNarrative,
  type NarrativeStatus,
} from './Narrative';
export {
  Absent,
  AttachmentSummary,
  CodeChips,
  ConceptList,
  ConceptValue,
  DateValue,
  ElementTree,
  IdentifierValue,
  LeafValue,
  QuantityValue,
  ReferenceList,
  ReferenceValue,
  ResourceTree,
  StatedAbsence,
  UnhandledRow,
  UnknownResource,
  orderedFields,
  type OrderedField,
  type RenderContext,
} from './UnknownResource';
export { ErrorBoundary, type ErrorBoundaryProps, type FailureUnit } from './ErrorBoundary';
export { ageFromBirthDate } from './renderers/people';
export {
  medicationConcept,
  type MedicationConcept,
  type MedicationSource,
} from './renderers/medications';
export { readAgent, type AgentBasis, type ProvenanceAgent } from './renderers/workflow';
export { ChoiceValue } from './renderers/clinical';
