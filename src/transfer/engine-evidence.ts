import type { GetEngineEvidence } from "./contracts.ts";

// No qualified runtime evidence for any variant before the optional engine is implemented.
export const getEngineEvidence: GetEngineEvidence = () => null;
