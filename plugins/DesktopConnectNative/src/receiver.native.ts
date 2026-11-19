import { getResponder, type CiaoService } from "@homebridge/ciao";
import { createHash } from "crypto";
import { app, webContents } from "electron";
import { readFile } from "fs/promises";
import { hostname, networkInterfaces } from "os";
import path from "path";

import { ConnectReceiver, type PlayerCommand, type PlayerEvent } from "./connect/ConnectReceiver";
// TIDAL's desktop server certificate, public. The phone only trusts it (signed by TIDAL's CA)
import tidalCert from "file://./connect/tidal_server_cert.pem";

type Running = { receiver: ConnectReceiver; service: CiaoService; watchAddresses?: NodeJS.Timeout };
declare const luna: { __desktopConnectNativeReceiver?: Running };

const receiverChannel = "desktopConnectNative.receiver";

// A certificate and key in this folder replace the built-in ones (development, tests)
export const keyFolder = () => path.join(app.getPath("userData"), "DesktopConnectNative");
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
const log = (...args: unknown[]) => console.log("[DesktopConnectNative]", ...args);

// Not TIDAL's own device id (its receiver may be advertised too), stable so the phone remembers the device
const deviceId = () => createHash("md5").update(`TidaLuna:${hostname()}`).digest("hex");

// The certificate and key from the key folder, otherwise TIDAL's certificate with the key the plugin was built with
const loadKeys = async (builtInKeyBase64: string) => {
	const folder = keyFolder();
	const [cert, key] = await Promise.all([readFile(path.join(folder, certFile)), readFile(path.join(folder, keyFile))]).catch(() => []);
	if (cert !== undefined && key !== undefined) {
		log(`Using ${certFile} and ${keyFile} from ${folder}`);
		return { cert, key };
	}
	if (builtInKeyBase64 !== "") return { cert: tidalCert, key: Buffer.from(builtInKeyBase64, "base64") };
	log(`Built without TIDAL's server key and no ${certFile} and ${keyFile} in ${folder}, the own receiver is off`);
	return undefined;
};

// The phone connects to port 9000 whatever port the mDNS record says (Lunar uses 9000 too)
const connectPort = 9000;
const lanAddresses = () =>
	Object.values(networkInterfaces())
		.flat()
		.filter((info) => info !== undefined && info.family === "IPv4" && !info.internal)
		.map((info) => info!.address);

// A new network (Wi-Fi, VPN, another address) is listened on within this time
const addressCheckMs = 10_000;

// TIDAL starts its own receiver (tidal_connect_application) with every window, it holds port 9000 on all addresses.
// Windows still lets the port be taken on one address, and the phone's connections to that address come here.
// The addresses change with the network, they are checked again every few seconds
const listen = async (cert: string | Buffer, key: string | Buffer) => {
	const options = { cert, key, port: connectPort, toPlayer, log };
	try {
		return { receiver: await ConnectReceiver.start(options) };
	} catch (err) {
		log(`Port ${connectPort} is taken (TIDAL's own receiver), listening on the network addresses`, (err as NodeJS.ErrnoException).code ?? err);
	}
	const receiver = await ConnectReceiver.start({ ...options, hosts: lanAddresses() });
	if (!receiver.listening) log(`Cannot listen on port ${connectPort} on any network address yet, phones will not find the receiver`);
	const watchAddresses = setInterval(() => receiver.setHosts(lanAddresses()).catch(log), addressCheckMs);
	return { receiver, watchAddresses };
};

// Starts the own receiver, undefined without a key
export const startReceiver = async (builtInKeyBase64: string): Promise<{ port: number } | undefined> => {
	if (running.__desktopConnectNativeReceiver) return { port: running.__desktopConnectNativeReceiver.receiver.port };
	const keys = await loadKeys(builtInKeyBase64);
	if (keys === undefined) return undefined;
	const { cert, key } = keys;
	const { receiver, watchAddresses } = await listen(cert, key);
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
	running.__desktopConnectNativeReceiver = { receiver, service, watchAddresses };
	log("Listening on port", receiver.port);
	return { port: receiver.port };
};

export const stopReceiver = async () => {
	const current = running.__desktopConnectNativeReceiver;
	if (current === undefined) return;
	running.__desktopConnectNativeReceiver = undefined;
	clearInterval(current.watchAddresses);
	await current.service.end().catch(log);
	await current.service.destroy().catch(log);
	await current.receiver.stop();
};

export const playerEvent = (event: PlayerEvent) => running.__desktopConnectNativeReceiver?.receiver.onPlayerEvent(event);
