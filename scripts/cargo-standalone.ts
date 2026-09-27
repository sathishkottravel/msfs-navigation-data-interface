import { $ } from "bun";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/// Builds the standalone WASM module, which runs outside the sim. The navigation data source is selected with `--data`:
/// - `mock` (default): serves mock navigation data, generated inside the container right before the build and embedded into the module
/// - `remote`: serves Navigraph navigation data, downloaded through the host at runtime (`DownloadNavigationData`)
///
/// Usage: `bun run build:wasm:standalone [AIRPORT ...]` (airports default to those in scripts/generate-mock-navdata.ts)
///        `bun run build:wasm:standalone:remote`

/// The docker image name
const IMAGE_NAME = "navigation-data-interface-standalone-build";

/// Docker volume used to cache the cargo registry between builds
const REGISTRY_VOLUME = "navigation-data-interface-cargo-registry";

/// Where the mock navigation data is generated, relative to the workspace root (inside the gitignored targets folder)
const MOCK_DATA_DIR = "targets/standalone/mock-data";

/// The name of the built module in the dist folder
const MODULE_NAME = "standalone_navigation_data_interface.wasm";

/// The cargo features for each navigation data source
const DATA_FEATURES = { mock: "standalone", remote: "remote-data" } as const;

const workspaceRoot = resolve(import.meta.dir, "..");

/// The navigation data source, from `--data=<mock|remote>`
const dataArg = process.argv.find(a => a.startsWith("--data="))?.slice("--data=".length) ?? "mock";
if (!(dataArg in DATA_FEATURES)) {
  console.error(`[-] Invalid --data '${dataArg}', expected one of: ${Object.keys(DATA_FEATURES).join(", ")}`);
  process.exit(1);
}
const data = dataArg as keyof typeof DATA_FEATURES;

/// Airports to generate mock data for, passed through to the generator
const airports = process.argv.slice(2).filter(a => /^[A-Za-z0-9]{3,4}$/.test(a));

// Ensure docker is installed and available
await $`docker ps`.quiet().catch(() => {
  console.error("[-] Docker is not installed or not running");
  process.exit(1);
});

// Ensure image is built
await $`docker image inspect ${IMAGE_NAME}:latest`.quiet().catch(async () => {
  const dockerfilePath = resolve(workspaceRoot, "Dockerfile.standalone");
  console.info(`[*] Building '${IMAGE_NAME}' image from ${dockerfilePath}`);
  await $`docker build -t ${IMAGE_NAME} -f ${dockerfilePath} ${workspaceRoot}`;
});

const cargoBuild = `cargo build -p msfs-navigation-data-interface --release --target wasm32-wasip1 --no-default-features --features ${DATA_FEATURES[data]}`;
const buildCommand =
  data === "mock"
    ? `bun ./scripts/generate-mock-navdata.ts --out ${MOCK_DATA_DIR} ${airports.join(" ")} && ${cargoBuild}`
    : cargoBuild;

console.info(
  data === "mock"
    ? "[*] Generating mock navigation data and building standalone module (mock data)"
    : "[*] Building standalone module (remote data)",
);

await $`docker run \
  --rm -t \
  --name msfs-standalone-${data}-wasm-builder \
  -v ${workspaceRoot}:/workspace \
  -v ${REGISTRY_VOLUME}:/usr/local/cargo/registry \
  -w /workspace \
  -e CARGO_TARGET_DIR=/workspace/targets/standalone/${data} \
  -e NAVIGRAPH_MOCK_DATA_DIR=/workspace/${MOCK_DATA_DIR} \
  ${IMAGE_NAME} \
    bash -c ${buildCommand}`.catch((err: { exitCode?: number }) => {
  console.error(`[-] Error building standalone module: ${err.exitCode}`);
  process.exit(1);
});

const builtModule = join(
  workspaceRoot,
  `targets/standalone/${data}/wasm32-wasip1/release/msfs_navigation_data_interface.wasm`,
);
const outDir = resolve(workspaceRoot, "dist/wasm/standalone", data);
mkdirSync(outDir, { recursive: true });
copyFileSync(builtModule, join(outDir, MODULE_NAME));

console.info(`[+] Standalone module written to ${join(outDir, MODULE_NAME)}`);
