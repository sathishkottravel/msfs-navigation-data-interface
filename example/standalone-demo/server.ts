import { createApp } from "./src/app.module";
import { loadNavigationData } from "./src/loadNavigationData";
import { RemoteConfigService } from "./src/RemoteConfigService";

const PORT = Number(process.env.PORT ?? 3000);

const { navigationDataInterface, transport, dataSource } = await loadNavigationData(
  process.env.NAVIGRAPH_WASM_PATH,
).catch((error: unknown) => {
  console.error("[-]", error instanceof Error ? error.message : error);
  process.exit(1);
});

const app = await createApp(navigationDataInterface, { dataSource });

// Download through the service, so the remote endpoints report it. A failure doesn't stop the server: another URL can be
// posted to /api/remote/download.
const navdataUrl = process.env.NAVIGRAPH_NAVDATA_URL;
if (navdataUrl) {
  await app
    .get(RemoteConfigService)
    .download(navdataUrl)
    .then(config => console.info(`[+] Navigation data installed (AIRAC ${config.lastDownload?.cycle})`))
    .catch((error: unknown) => console.warn("[!]", error instanceof Error ? error.message : error));
}

await app.listen(PORT);
console.info(
  `[+] Listening on http://localhost:${PORT} (${dataSource} data, API docs at http://localhost:${PORT}/docs)`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    transport.dispose();
    void app.close();
  });
}
