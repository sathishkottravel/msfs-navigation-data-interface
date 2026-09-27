import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NavigraphNavigationDataInterface, StandaloneTransport } from "./navigraph";
import type { DataSource } from "./RemoteConfigService";

/// The standalone module with mock data, as written by `bun run build:wasm:standalone`
export const DEFAULT_WASM_PATH = fileURLToPath(
  new URL("../../../dist/wasm/standalone/mock/standalone_navigation_data_interface.wasm", import.meta.url),
);

export interface LoadedNavigationData {
  navigationDataInterface: NavigraphNavigationDataInterface;
  /** Drives the module on an interval, which keeps the process alive until it is disposed */
  transport: StandaloneTransport;
  /** Whether the module is the mock or remote data build */
  dataSource: DataSource;
}

/**
 * Loads the standalone module and waits until it is ready (its first heartbeat). If a navigation data URL is given, the data is
 * then downloaded into the module, which is required for the remote data build (`bun run build:wasm:standalone:remote`).
 *
 * @param wasmPath - Path of the standalone module
 * @param timeoutMs - Milliseconds to wait for the module to become ready
 * @param navdataUrl - A signed URL of a Navigraph navigation data package to download
 */
export async function loadNavigationData(
  wasmPath = DEFAULT_WASM_PATH,
  timeoutMs = 5000,
  navdataUrl?: string,
): Promise<LoadedNavigationData> {
  const loaded = await waitUntilReady(wasmPath, timeoutMs);

  if (navdataUrl) {
    await loaded.navigationDataInterface.download_navigation_data(navdataUrl).catch((error: unknown) => {
      loaded.transport.dispose();
      throw error;
    });
  }

  return loaded;
}

async function waitUntilReady(wasmPath: string, timeoutMs: number): Promise<LoadedNavigationData> {
  if (!existsSync(wasmPath)) {
    throw new Error(
      `${wasmPath} not found. Run \`bun run build:wasm:standalone\` at the root of the repository first.`,
    );
  }

  // Compiled here, rather than by the transport, to tell the builds apart: only the remote data build takes fetch results
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const dataSource: DataSource = WebAssembly.Module.exports(module).some(e => e.name === "navigraph_fetch_complete")
    ? "remote"
    : "mock";

  const transport = new StandaloneTransport({ wasm: module });
  const navigationDataInterface = new NavigraphNavigationDataInterface(transport);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      transport.dispose();
      reject(new Error(`The standalone module did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    navigationDataInterface.onReady(() => {
      clearTimeout(timeout);
      resolve({ navigationDataInterface, transport, dataSource });
    });
  });
}
