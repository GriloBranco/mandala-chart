// Prompts and answers for the four AI features: suggest, sharpen, leverage and report analysis.
// The model sees short refs instead of ids (P3 = pillar 3, A3.5 = its 5th action, G2.A3.5 when a
// report covers several goals). Every answer is validated, clamped and mapped back to real ids
// here; unknown refs are dropped. Prompt builders are pure so they can be checked without a key.
// suggest, sharpen and leverage build their prompt first and return the call that sends it, so
// the routes use quota only for input that passed (a 400 never counts).

export {
  analyzeTextSchema,
  leverageInputSchema,
  sharpenInputSchema,
  suggestInputSchema,
  type ReportScope,
} from "./inputs";
export { suggest } from "./suggest";
export { sharpen } from "./sharpen";
export { leverage } from "./leverage";
export { analyzeReport, AUDIO_MAX_BYTES, AUDIO_MIN_BYTES, audioMimeTypes } from "./audio";
