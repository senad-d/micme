import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SHORTCUT } from "./constants.ts";

export const isOmp = CONFIG_DIR_NAME === ".omp";
// OMP reserves Alt+M for Models. F8 is free in its stock editor keymap.
export const hostDefaultShortcut = isOmp ? "f8" : DEFAULT_SHORTCUT;
