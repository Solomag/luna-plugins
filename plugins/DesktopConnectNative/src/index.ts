import { LunaPlugin, type LunaUnload, Tracer } from "@luna/core";

import { startOwnReceiver } from "./receiver";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[DesktopConnectNative]");

// Both would answer the phone (two devices), the one enabled last stays
const deprecated = LunaPlugin.getByName("DesktopConnect");
if (deprecated?.enabled) {
	trace.msg.warn("Disabled DesktopConnect, DesktopConnectNative replaces it");
	deprecated.disable().catch(trace.err.withContext("disable DesktopConnect"));
}

if (!(await startOwnReceiver(unloads))) trace.msg.warn("DesktopConnectNative could not start its TIDAL Connect receiver, see the console");
