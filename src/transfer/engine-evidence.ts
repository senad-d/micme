import type { Cell, DeviceIdentity, GetEngineEvidence, Traits } from "./contracts.ts";

// Exact English CPU runtime qualification for M, not the integrated P4 gate.
// The loaded language list is capability metadata, not qualified languages.
const rig = "linux-x86_64/ubuntu-24.04/i5-7500/4t/headless/sha256:75f3202cf290f69973a5e23cf64cb761bbdefd859d24cf0d21a33442d2a3005a";
const device: DeviceIdentity = { id: null, label: "Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz" };
const evidence = "native/recognizer/linux-x64-component.json";
const streamer = "moonshine-streaming-tiny/Q8_0@3b75b3ab1d29bee2112deb73514de0657337db559134956af809d3dd70231174";
const batch = "parakeet-tdt-0.6b-v3/Q4_K_M@536c7023afb9030c8e6f4d238607c7dc5d9b5b27361a79e8ff4139321822cab4";
const componentTraits = {
	longForm: false, batch: true, bias: false, translateEn: false, vad: "off", actualCompute: "cpu", boundDevice: device,
} satisfies Partial<Traits>;

function measured(language: string, wer: number, disposition: Cell["disposition"]): Cell {
	return { feature: "M4", language, task: "transcribe", rig, device, wer, cer: null, xrt: null, evidence, disposition };
}

export const getEngineEvidence: GetEngineEvidence = (variantId) => {
	if (variantId === streamer) return structuredClone({
		runtime: "passed", traits: { ...componentTraits, stream: true, nativeLid: false, languages: ["en"] }, measurements: [measured("en", 0, "adapted-verified")],
	});
	if (variantId === batch) return structuredClone({
		runtime: "passed", traits: { ...componentTraits, stream: false, nativeLid: true,
			languages: ["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk"] },
		measurements: [measured("en", 0, "adapted-verified"), measured("fr", 1, "unverified")],
	});
	return null;
};
