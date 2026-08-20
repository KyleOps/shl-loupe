/**
 * The SMART Health Card area's public surface.
 *
 * `ShcVerification` is the whole of it: a payload view hands it an `OpenedFile`
 * and gets the posture, the ladder and the findings. The pure helpers are
 * exported alongside it because they are the parts worth reading in isolation,
 * not because anything else needs them yet.
 */
export {
  ShcVerification,
  bundleEntryCount,
  revocationSentence,
  splitChecks,
  trustSentence,
  unsignedFileLabel,
  CHECK_TONE,
  CHECK_WORD,
  POSTURE_TONE,
  type ShcVerificationProps,
} from './ShcVerification';
