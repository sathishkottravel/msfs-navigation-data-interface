# Standalone Demo

Runs the standalone build of the WASM module outside the sim, through the JS interface (`NavigraphNavigationDataInterface` with a `StandaloneTransport`). It comes in two forms:

- A **script** (`index.ts`) which prints some mock navigation data.
- An **HTTP API** (`server.ts`, built with NestJS) which serves the mock navigation data, with an OpenAPI spec and Swagger UI.

Both serve mock data by default: only the airports the mock data was generated for (`MMUN`, `MMMD` and `MSLP` by default) and their surroundings are available. See [Running Outside the Sim](../../README.md#running-outside-the-sim-standalone-mode) for how the mock data is built.

To serve Navigraph data instead, build the remote data variant (`bun run build:wasm:standalone:remote`), and set `NAVIGRAPH_WASM_PATH` to `dist/wasm/standalone/remote/standalone_navigation_data_interface.wasm`. Then load data with a signed navigation data package URL, either at startup (`NAVIGRAPH_NAVDATA_URL`) or at runtime through the HTTP API (`POST /api/remote/download`, see [Remote Navigation Data](#remote-navigation-data)).

## Prerequisites

Build the standalone module (requires Docker) at the root of the repository:

```sh
bun run build:wasm:standalone
```

This writes `dist/wasm/standalone/mock/standalone_navigation_data_interface.wasm`, which the demo loads. The demo imports the JS interface from source (`src/ts`), so the package doesn't need to be built.

## Script

```sh
bun run demo:standalone          # from the root, or
cd example/standalone-demo
bun start [AIRPORT]              # defaults to MMUN
```

## HTTP API

```sh
bun run demo:standalone:serve    # from the root, or
cd example/standalone-demo
bun run serve
```

Then open http://localhost:3000/docs for the Swagger UI. The spec, generated from the controllers by `@nestjs/swagger`, is served at `/openapi.json`.

| Environment variable    | Default                                                               | Description                                                                         |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `PORT`                  | `3000`                                                                | Port to listen on                                                                   |
| `NAVIGRAPH_WASM_PATH`   | `dist/wasm/standalone/mock/standalone_navigation_data_interface.wasm` | Path of the standalone module (also used by the script)                             |
| `NAVIGRAPH_NAVDATA_URL` | (none)                                                                | Signed navigation data package URL to download at startup (also used by the script) |

The server tells the mock and remote data builds apart from the module's exports, so there's nothing to configure for it. If the startup download fails, the server still starts, and another URL can be posted to `/api/remote/download`.

### Endpoints

All API endpoints are under `/api`. The navigation data endpoints are mounted under the data source of the module, so URLs say where the data comes from: `/api/mock` with the mock data build, `/api/remote` with the remote data build. Identifiers are case insensitive.

| Endpoint                                            | Description                                        |
| --------------------------------------------------- | -------------------------------------------------- |
| `GET /health`                                       | Health check                                       |
| `GET /api/remote`                                   | Data source (mock or remote) and data state        |
| `POST /api/remote/download`                         | Download a package into the module (remote only)   |
| `GET /api/remote/cycle`                             | Installed cycle compared with the latest available |
| `GET /api/{source}/database`                        | Cycle and install status of the navigation data    |
| `GET /api/{source}/airports?lat=&long=&range=`      | Airports within `range` NM (max 500) of a point    |
| `GET /api/{source}/airports/{ident}`                | An airport                                         |
| `GET /api/{source}/airports/{ident}/runways`        | Runways of an airport                              |
| `GET /api/{source}/airports/{ident}/departures`     | Departures (SIDs)                                  |
| `GET /api/{source}/airports/{ident}/arrivals`       | Arrivals (STARs)                                   |
| `GET /api/{source}/airports/{ident}/approaches`     | Approaches                                         |
| `GET /api/{source}/airports/{ident}/gates`          | Gates                                              |
| `GET /api/{source}/airports/{ident}/communications` | Communication frequencies                          |
| `GET /api/{source}/waypoints/{ident}`               | Waypoints with an identifier (they're not unique)  |
| `GET /api/{source}/navaids/vhf/{ident}`             | VHF navaids with an identifier                     |
| `GET /api/{source}/navaids/ndb/{ident}`             | NDB navaids with an identifier                     |
| `GET /api/{source}/airways/{ident}`                 | Airways with an identifier                         |

`{source}` is `mock` or `remote`, and only the one matching the loaded module exists (the other responds `404`). The `/api/remote` configuration endpoints exist with both builds, so clients can find out which one is running.

```sh
curl http://localhost:3000/api/mock/airports/MMUN/runways
curl "http://localhost:3000/api/mock/airports?lat=21.04&long=-86.87&range=50"
```

### Remote Navigation Data

With the remote data build, the module starts without navigation data, and queries respond `500` until a package is downloaded:

```sh
curl http://localhost:3000/api/remote
# {"dataSource":"remote","state":"empty","lastDownload":null}

curl -X POST http://localhost:3000/api/remote/download \
  -H "content-type: application/json" \
  -d '{"url": "<signed package URL>"}'
# {"dataSource":"remote","state":"ready","lastDownload":{"host":"...","startedAt":"...","completedAt":"...","cycle":"2609","error":null}}

curl http://localhost:3000/api/remote/cycle
# {"installedCycle":"2609","latestCycle":"2609","upToDate":true}

curl http://localhost:3000/api/remote/airports/KJFK
```

- The request waits until the data is installed, and replaces the active data. If it fails (e.g. an expired URL), the previous data stays active.
- The data is held in memory, so download again after restarting the server.
- The signed URL is never echoed back: `lastDownload` only reports its host.
- Get signed URLs through Navigraph authentication, as the [gauge example](../gauge) does (`getPackagesAPI().getPackage(format)`, then `file.url`). They expire, so get a new one for each download.

`POST /api/remote/download` responds `400` to a missing or malformed URL, `409` when the module serves mock data or a download is already in progress, and `502` when the package can't be downloaded or installed.

Errors use the standard Nest format, `{ "statusCode": 404, "error": "Not Found", "message": "..." }`, with status `400` for invalid input (e.g. a malformed identifier or a missing query parameter), `404` when nothing matches, and `500` for unexpected failures of the module.

### Structure

The business logic is kept apart from HTTP, so each can be tested on its own:

```
server.ts                   Entry point: loads the module, starts the app
src/
  loadNavigationData.ts     Loads the standalone module and waits until it's ready
  NavigationDataService.ts  Business logic: validation, normalization, not found checks. Plain TS, no Nest or HTTP.
  RemoteConfigService.ts    Downloads packages into the remote data build and tracks their state. Plain TS, no Nest or HTTP.
  errors.ts                 ValidationError, NotFoundError, ConflictError, UpstreamError
  controllers.ts            All the controllers: map routes to service calls, and document them for Swagger
  app.module.ts             The Nest module, the filter mapping service errors to 400/404/409/502, and Swagger setup
```

The service depends on the `NavigationDataSource` type, the subset of the JS interface it uses, and `AppModule.register(source)` creates it. This way tests can replace the WASM module with an in-memory fake.

## Tests

```sh
cd example/standalone-demo
bun test
```

- `tests/NavigationDataService.test.ts`: the business logic, against an in-memory fake source.
- `tests/RemoteConfigService.test.ts`: the remote configuration logic, against the same fake.
- `tests/app.test.ts`: the HTTP layer (routes, status codes, OpenAPI spec and Swagger UI), against the same fake.
- `tests/integration.test.ts`: the service, and every example in the generated OpenAPI spec, against the real standalone module. Skipped when the module hasn't been built.
