import { describe, expect, test } from "bun:test";
import { ConflictError, UpstreamError, ValidationError } from "../src/errors";
import { type DataSource, RemoteConfigService } from "../src/RemoteConfigService";
import { expectRejection } from "./helpers";
import { FAILING_URL_MARKER, createFakeSource } from "./fakeSource";

const URL_OK = "https://packages.navigraph.com/navdata.zip?signature=secret";
const URL_FAILING = `https://packages.navigraph.com/${FAILING_URL_MARKER}.zip`;

function createService(dataSource: DataSource = "remote") {
  const fake = createFakeSource();
  return { service: new RemoteConfigService(fake.source, dataSource), ...fake };
}

describe("RemoteConfigService", () => {
  test("the remote build starts empty, the mock build ready", () => {
    expect(createService("remote").service.getConfig()).toEqual({
      dataSource: "remote",
      state: "empty",
      lastDownload: null,
    });
    expect(createService("mock").service.getConfig().state).toBe("ready");
  });

  test("download passes the URL on and records the installed cycle", async () => {
    const { service, calls } = createService();
    const config = await service.download(` ${URL_OK} `);

    expect(calls.find(c => c.method === "download_navigation_data")?.args).toEqual([URL_OK]);
    expect(config.state).toBe("ready");
    expect(config.lastDownload).toMatchObject({ host: "packages.navigraph.com", cycle: "2401", error: null });
    expect(config.lastDownload?.completedAt).not.toBeNull();
  });

  test.each([undefined, 42, "", "not a url", "file:///tmp/navdata.zip"])(
    "rejects url=%p without downloading",
    async url => {
      const { service, calls } = createService();
      await expectRejection(service.download(url), ValidationError);
      expect(calls).toHaveLength(0);
    },
  );

  test("rejects downloads into the mock build", async () => {
    const { service, calls } = createService("mock");
    await expectRejection(service.download(URL_OK), ConflictError);
    expect(calls).toHaveLength(0);
  });

  test("rejects a download while another is in progress", async () => {
    const { service } = createService();
    const first = service.download(URL_OK);
    expect(service.getConfig().state).toBe("downloading");
    await expectRejection(service.download(URL_OK), ConflictError);
    await first;
    expect(service.getConfig().state).toBe("ready");
  });

  test("a failed download records the error and keeps the previous state", async () => {
    const { service } = createService();
    await expectRejection(service.download(URL_FAILING), UpstreamError);
    expect(service.getConfig().state).toBe("empty");
    expect(service.getConfig().lastDownload?.error).toBe("403 Forbidden");

    await service.download(URL_OK);
    await expectRejection(service.download(URL_FAILING), UpstreamError);
    expect(service.getConfig().state).toBe("ready");
  });

  test("checkCycle compares the installed and latest cycles", async () => {
    const { service, source } = createService();
    expect(await service.checkCycle()).toEqual({ installedCycle: "2401", latestCycle: "2402", upToDate: false });

    const status = await source.get_navigation_data_install_status();
    source.get_navigation_data_install_status = () => Promise.resolve({ ...status, latestCycle: null });
    expect((await service.checkCycle()).upToDate).toBeNull();
  });
});
