use anyhow::{Context, Result};
use rusqlite::Connection;

use super::{load_database, send_message};
use crate::{
    database::CycleInfo,
    interface::{DownloadProgressEvent, InterfaceEvent},
    platform::Platform,
};

/// The mock navigation data, generated inside the standalone build container (`bun run build:wasm:standalone`),
/// which sets `NAVIGRAPH_MOCK_DATA_DIR` to its output folder
const MOCK_NAVDATA: &[u8] = include_bytes!(concat!(
    env!(
        "NAVIGRAPH_MOCK_DATA_DIR",
        "The standalone build must run through `bun run build:wasm:standalone`, which generates the mock navigation data"
    ),
    "/mock-navdata.sqlite"
));

/// The cycle info of the mock navigation data
const MOCK_CYCLE_JSON: &str = include_str!(concat!(
    env!(
        "NAVIGRAPH_MOCK_DATA_DIR",
        "The standalone build must run through `bun run build:wasm:standalone`, which generates the mock navigation data"
    ),
    "/mock-cycle.json"
));

/// The path reported for the mock navigation data
const MOCK_NAVDATA_PATH: &str = "mock-navdata.sqlite";

/// The number of progress events sent by the mock download
const MOCK_DOWNLOAD_CHUNKS: usize = 4;

/// The size of each chunk of the mock download
const MOCK_DOWNLOAD_CHUNK_SIZE_BYTES: usize = 4 * 1024 * 1024;

/// The standalone platform with mock data: runs outside the sim, messaging the host directly and serving the embedded mock navigation data
pub(crate) struct StandalonePlatform;

impl Platform for StandalonePlatform {
    fn send_message(channel: &str, data: &str) {
        send_message(channel, data)
    }

    fn init_database() -> Result<Option<Connection>> {
        Ok(Some(Self::open_database()?))
    }

    fn open_database() -> Result<Connection> {
        load_database(MOCK_NAVDATA).context("can't load mock navigation data")
    }

    fn get_cycle_info() -> Result<CycleInfo> {
        CycleInfo::from_json(MOCK_CYCLE_JSON)
    }

    fn installed_path() -> Option<String> {
        Some(MOCK_NAVDATA_PATH.to_owned())
    }

    async fn get_latest_cycle() -> Result<Option<String>> {
        Ok(Some(Self::get_cycle_info()?.cycle))
    }

    /// Simulates a download by sending progress events. The mock navigation data is reloaded when the connection is reopened.
    async fn download_navigation_data(_url: &str) -> Result<()> {
        let total_bytes = MOCK_DOWNLOAD_CHUNKS * MOCK_DOWNLOAD_CHUNK_SIZE_BYTES;

        for i in 0..MOCK_DOWNLOAD_CHUNKS {
            InterfaceEvent::send_download_progress_event(DownloadProgressEvent {
                total_bytes,
                downloaded_bytes: i * MOCK_DOWNLOAD_CHUNK_SIZE_BYTES,
                current_chunk: i,
                total_chunks: MOCK_DOWNLOAD_CHUNKS,
            })
            .context("can't send download progress event")?;
        }

        Ok(())
    }

    async fn install_downloaded_navigation_data() -> Result<()> {
        Ok(())
    }
}
