import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { DatabaseSummary } from "../src/NavigationDataService";
import type { RemoteConfig } from "../src/RemoteConfigService";
import { FAILING_URL_MARKER, MMUN, createFakeSource } from "./fakeSource";
import { type ErrorResponse, readJson, startApp } from "./helpers";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await startApp(createFakeSource().source));
});

afterAll(async () => {
  await app.close();
});

const get = (path: string) => fetch(baseUrl + path);

describe("HTTP API", () => {
  test("GET /health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /api/mock/database", async () => {
    const res = await get("/api/mock/database");
    expect(res.status).toBe(200);
    expect((await readJson<DatabaseSummary>(res)).info.airac_cycle).toBe("2401");
  });

  test("GET /api/mock/airports/:ident", async () => {
    const res = await get("/api/mock/airports/mmun");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MMUN);
  });

  test("GET /api/mock/airports/:ident/runways", async () => {
    const res = await get("/api/mock/airports/MMUN/runways");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  test("GET /api/mock/airports with query parameters", async () => {
    const res = await get("/api/mock/airports?lat=21&long=-86.8&range=50");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([MMUN]);
  });

  test("responds 400 to invalid input", async () => {
    for (const path of [
      "/api/mock/airports/M!",
      "/api/mock/airports?lat=21&long=-86.8",
      "/api/mock/airports?lat=abc&long=0&range=5",
      "/api/mock/airports?lat=95&long=0&range=5",
    ]) {
      const res = await get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
  });

  test("responds 404 when nothing matches", async () => {
    const res = await get("/api/mock/airports/XXXX/approaches");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, error: "Not Found", message: "Airport 'XXXX' not found" });
  });

  test("responds 500 to unexpected errors", async () => {
    const { source } = createFakeSource();
    source.get_database_info = () => Promise.reject(new Error("module failure"));
    const failing = await startApp(source);
    try {
      const res = await fetch(`${failing.baseUrl}/api/mock/database`);
      expect(res.status).toBe(500);
      expect((await readJson<ErrorResponse>(res)).statusCode).toBe(500);
    } finally {
      await failing.app.close();
    }
  });

  describe("remote configuration", () => {
    let remote: Awaited<ReturnType<typeof startApp>>;

    beforeAll(async () => {
      remote = await startApp(createFakeSource().source, "remote");
    });

    afterAll(async () => {
      await remote.app.close();
    });

    const download = (base: string, body: unknown) =>
      fetch(`${base}/api/remote/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    test("GET /api/remote reports the data source and state", async () => {
      expect(await readJson<RemoteConfig>(await get("/api/remote"))).toEqual({
        dataSource: "mock",
        state: "ready",
        lastDownload: null,
      });
      expect((await readJson<RemoteConfig>(await fetch(`${remote.baseUrl}/api/remote`))).state).toBe("empty");
    });

    test("POST /api/remote/download installs the data", async () => {
      const res = await download(remote.baseUrl, {
        url: "https://packages.navigraph.com/navdata.zip?signature=secret",
      });
      expect(res.status).toBe(200);
      const config = await readJson<RemoteConfig>(res);
      expect(config.state).toBe("ready");
      expect(config.lastDownload).toMatchObject({ host: "packages.navigraph.com", cycle: "2401", error: null });
      // The signed URL is never echoed back
      expect(JSON.stringify(config)).not.toContain("secret");
    });

    test("POST /api/remote/download responds 400, 409 and 502", async () => {
      expect((await download(remote.baseUrl, {})).status).toBe(400);
      expect((await download(remote.baseUrl, { url: "ftp://example.com/x.zip" })).status).toBe(400);
      expect((await download(baseUrl, { url: "https://example.com/x.zip" })).status).toBe(409);

      const failed = await download(remote.baseUrl, { url: `https://example.com/${FAILING_URL_MARKER}.zip` });
      expect(failed.status).toBe(502);
      expect((await readJson<ErrorResponse>(failed)).message).toContain("403 Forbidden");
    });

    test("mounts the navigation data under the data source", async () => {
      expect((await fetch(`${remote.baseUrl}/api/remote/airports/MMUN`)).status).toBe(200);
      expect((await fetch(`${remote.baseUrl}/api/mock/airports/MMUN`)).status).toBe(404);
      expect((await get("/api/remote/airports/MMUN")).status).toBe(404);
      expect((await get("/api/airports/MMUN")).status).toBe(404);
    });

    test("GET /api/remote/cycle compares the cycles", async () => {
      expect(await (await get("/api/remote/cycle")).json()).toEqual({
        installedCycle: "2401",
        latestCycle: "2402",
        upToDate: false,
      });
    });
  });

  test("serves the OpenAPI spec and Swagger UI", async () => {
    const spec = await readJson<{ openapi: string; paths: Record<string, unknown> }>(await get("/openapi.json"));
    expect(spec.openapi).toStartWith("3.");
    expect(Object.keys(spec.paths)).toContain("/api/mock/airports/{ident}/runways");
    expect(Object.keys(spec.paths)).toContain("/api/remote/download");

    const docs = await get("/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("swagger-ui");
  });
});
