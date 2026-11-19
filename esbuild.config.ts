import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { listen, pluginBuildOptions } from "luna/build";

// luna/buildPlugins, with the build-time values plugins need

// TIDAL's desktop server key for DesktopConnectNative's TIDAL Connect receiver, from the CI secret (the PEM text).
// Baked into the output base64 encoded, so it is not there as plain text. Empty without it
const serverKey = process.env.TIDAL_SERVER_KEY_PEM?.trim() ?? "";
const define = { __TIDAL_SERVER_KEY_BASE64__: JSON.stringify(Buffer.from(serverKey).toString("base64")) };

const pluginFolders = await readdir(join(process.cwd(), "./plugins"));
const buildConfigs = await Promise.all(pluginFolders.map((name) => pluginBuildOptions(`./plugins/${name}`, { define })));

listen(buildConfigs);

// Quick export of plugins for store functionality
const pkg = JSON.parse(await readFile(join(process.cwd(), "./package.json"), "utf8"));
pkg.plugins ??= buildConfigs.map((config) => config.outfile?.replace("./dist/", ""));
await mkdir(join(process.cwd(), "./dist"), { recursive: true });
await writeFile(join(process.cwd(), "./dist/store.json"), JSON.stringify(pkg));
