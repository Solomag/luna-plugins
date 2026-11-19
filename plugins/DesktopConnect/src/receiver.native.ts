import { getResponder, type CiaoService } from "@homebridge/ciao";
import { createHash } from "crypto";
import { app, webContents } from "electron";
import { readFile } from "fs/promises";
import { hostname } from "os";
import path from "path";

import { ConnectReceiver, type PlayerCommand, type PlayerEvent } from "./connect/ConnectReceiver";
// TIDAL's desktop server certificate, public. The phone only trusts it (signed by TIDAL's CA)
import tidalCert from "file://./connect/tidal_server_cert.pem";

type Running = { receiver: ConnectReceiver; service: CiaoService };
declare const luna: { __desktopConnectReceiver?: Running };

const receiverChannel = "desktopConnect.receiver";

// A certificate and key in this folder replace the built-in ones (development, tests)
export const keyFolder = () => path.join(app.getPath("userData"), "DesktopConnect");
const certFile = "tidal_server_cert.pem";
const keyFile = "tidal_server_key.pem";

// Luna evaluates the native module again (in a new sandbox) when the plugin reloads, so the running receiver is kept on luna,
// otherwise the next stopReceiver would not find it and it would hold the port
const running = luna;

// TIDAL's page (luna.tidalWindow is not set in the main process)
const toPlayer = (command: PlayerCommand) => {
	for (const contents of webContents.getAllWebContents()) {
		if (contents.getURL().startsWith("https://desktop.tidal.com/")) contents.send(receiverChannel, command);
	}
};
const log = (...args: unknown[]) => console.log("[DesktopConnect.receiver]", ...args);

// Not TIDAL's own device id (its receiver may be advertised too), stable so the phone remembers the device
const deviceId = () => createHash("md5").update(`TidaLuna:${hostname()}`).digest("hex");

// The certificate and key from the key folder, otherwise TIDAL's certificate with the key the plugin was built with
const loadKeys = async (builtInKey: string) => {
	const folder = keyFolder();
	const [cert, key] = await Promise.all([readFile(path.join(folder, certFile)), readFile(path.join(folder, keyFile))]).catch(() => []);
	if (cert !== undefined && key !== undefined) {
		log(`Using ${certFile} and ${keyFile} from ${folder}`);
		return { cert, key };
	}
	if (builtInKey !== "") return { cert: tidalCert, key: builtInKey };
	log(`Built without TIDAL's server key and no ${certFile} and ${keyFile} in ${folder}, the own receiver is off`);
	return undefined;
};

// Starts the own receiver, undefined without a key
export const startReceiver = async (builtInKey: string): Promise<{ port: number } | undefined> => {
	if (running.__desktopConnectReceiver) return { port: running.__desktopConnectReceiver.receiver.port };
	const keys = await loadKeys(builtInKey);
	if (keys === undefined) return undefined;
	const { cert, key } = keys;
	// TIDAL's own receiver may use 9000, any port works as the phone takes it from the mDNS record
	const receiver = await ConnectReceiver.start({ cert, key, port: 9000, toPlayer, log }).catch((err) => {
		log("Port 9000 is taken, using a free one", err.code ?? err);
		return ConnectReceiver.start({ cert, key, port: 0, toPlayer, log });
	});
	const id = deviceId();
	const service = getResponder().createService({
		disabledIpv6: true,
		port: receiver.port,
		type: "tidalconnect",
		name: `TidalConnect-${id.slice(0, 8)}`,
		txt: {
			mn: "TidaLuna",
			id,
			fn: `TidaLuna: ${hostname().split(".")[0]}`,
			ca: "0",
			ve: "1",
		},
	});
	await service.advertise();
	running.__desktopConnectReceiver = { receiver, service };
	log("Listening on port", receiver.port);
	return { port: receiver.port };
};

export const stopReceiver = async () => {
	const current = running.__desktopConnectReceiver;
	if (current === undefined) return;
	running.__desktopConnectReceiver = undefined;
	await current.service.end().catch(log);
	await current.service.destroy().catch(log);
	await current.receiver.stop();
};

export const playerEvent = (event: PlayerEvent) => running.__desktopConnectReceiver?.receiver.onPlayerEvent(event);
