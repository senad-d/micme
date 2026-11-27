import type { ListCompute, ListInstalled, OpenRecognizer, RecognizeFile, Unload } from "./contracts.ts";

export const openRecognizer: OpenRecognizer = async () => {
	throw new Error("Micme optional recognition is not available. Unset MICME_ARTIFACT to use the existing dictation backend.");
};

export const recognizeFile: RecognizeFile = async () => {
	throw new Error("Micme optional file recognition is not available.");
};

export const listInstalled: ListInstalled = async () => [];
export const listCompute: ListCompute = async () => [];
export const unload: Unload = async () => { /* No engine is loaded. */ };
