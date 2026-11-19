import { type LunaUnload, Tracer } from "@luna/core";

import { startOwnReceiver } from "./receiver";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[DesktopConnectNative]");

if (!(await startOwnReceiver(unloads))) trace.msg.warn("DesktopConnectNative could not start its TIDAL Connect receiver, see the console");
