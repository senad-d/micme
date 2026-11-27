import type { FinishLocal, ResolveLanguage } from "./contracts.ts";

export const resolveLanguage: ResolveLanguage = (choice) => choice.language;
export const finishLocal: FinishLocal = (raw, language, source) => ({ raw, local: raw, language, source, rules: [] });
