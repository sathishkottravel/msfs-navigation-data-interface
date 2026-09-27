import { ConflictError, UpstreamError, ValidationError } from "./errors";
import type { NavigationDataSource } from "./NavigationDataService";

/** Where the module gets its navigation data: embedded mock data, or Navigraph data downloaded at runtime */
export type DataSource = "mock" | "remote";

/**
 * - `empty`: the remote build before its first successful download. Queries fail until data is downloaded.
 * - `downloading`: a download is in progress. The previous data, if any, is still served.
 * - `ready`: navigation data is available.
 */
export type DataState = "empty" | "downloading" | "ready";

export interface DownloadAttempt {
  /** Host of the package URL. The full URL is signed, so it is never echoed back. */
  host: string;
  startedAt: string;
  completedAt: string | null;
  /** AIRAC cycle of the installed data, once the download succeeded */
  cycle: string | null;
  error: string | null;
}

export interface RemoteConfig {
  dataSource: DataSource;
  state: DataState;
  lastDownload: DownloadAttempt | null;
}

export interface CycleCheck {
  installedCycle: string | null;
  latestCycle: string | null;
  /** `null` when either cycle is unknown (no data installed, or the latest cycle couldn't be fetched) */
  upToDate: boolean | null;
}

/**
 * Manages the navigation data of the remote build: downloads signed packages into the module, and tracks the result.
 * Knows nothing about HTTP.
 */
export class RemoteConfigService {
  private state: DataState;
  private lastDownload: DownloadAttempt | null = null;

  constructor(
    private readonly source: NavigationDataSource,
    public readonly dataSource: DataSource,
  ) {
    // The mock build embeds its data, the remote build starts without any
    this.state = dataSource === "mock" ? "ready" : "empty";
  }

  public getConfig(): RemoteConfig {
    return { dataSource: this.dataSource, state: this.state, lastDownload: this.lastDownload };
  }

  /**
   * Downloads a signed navigation data package into the module, replacing the active data. If the download fails, the previous data
   * stays active.
   *
   * @param url - A signed URL of a Navigraph navigation data package
   */
  public async download(url: unknown): Promise<RemoteConfig> {
    const parsed = parsePackageUrl(url);

    if (this.dataSource === "mock") {
      throw new ConflictError(
        "The module serves mock data. Build the remote data variant (`bun run build:wasm:standalone:remote`) to download data.",
      );
    }
    if (this.state === "downloading") {
      throw new ConflictError("A download is already in progress");
    }

    const previousState = this.state;
    const attempt: DownloadAttempt = {
      host: parsed.host,
      startedAt: new Date().toISOString(),
      completedAt: null,
      cycle: null,
      error: null,
    };
    this.state = "downloading";
    this.lastDownload = attempt;

    try {
      await this.source.download_navigation_data(parsed.href);
      attempt.cycle = (await this.source.get_database_info()).airac_cycle;
      this.state = "ready";
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      this.state = previousState;
      throw new UpstreamError(`Unable to download navigation data: ${attempt.error}`);
    } finally {
      attempt.completedAt = new Date().toISOString();
    }

    return this.getConfig();
  }

  /** Compares the installed cycle with the latest one available from Navigraph */
  public async checkCycle(): Promise<CycleCheck> {
    const { installedCycle, latestCycle } = await this.source.get_navigation_data_install_status();
    return {
      installedCycle,
      latestCycle,
      upToDate: installedCycle && latestCycle ? installedCycle === latestCycle : null,
    };
  }
}

function parsePackageUrl(url: unknown): URL {
  if (typeof url !== "string" || url.trim() === "") {
    throw new ValidationError("url must be a non-empty string");
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ValidationError("url must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ValidationError("url must be an http(s) URL");
  }

  return parsed;
}
