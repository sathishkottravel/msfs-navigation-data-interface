use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    future::Future,
    io::{Cursor, Read},
    pin::Pin,
    task::{Context as TaskContext, Poll},
};

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;
use serde::Deserialize;
use zip::ZipArchive;

use super::{host, load_database, send_message};
use crate::{
    database::CycleInfo,
    interface::{DownloadProgressEvent, InterfaceEvent},
    platform::Platform,
};

/// The URL to get the latest available cycle number
const LATEST_CYCLE_ENDPOINT: &str = "https://navdata.api.navigraph.com/info";

/// The return type from the latest cycle endpoint
#[derive(Deserialize)]
struct CycleResponseInfo {
    cycle: String,
}

/// The installed navigation data, held in memory
struct InstalledNavigationData {
    cycle_json: String,
    db: Vec<u8>,
    db_name: String,
}

thread_local! {
    /// The active navigation data, if any has been downloaded
    static INSTALLED: RefCell<Option<InstalledNavigationData>> = const { RefCell::new(None) };
    /// The downloaded navigation data zip, waiting to be installed
    static DOWNLOADED: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    /// The ID of the next host fetch
    static NEXT_FETCH_ID: Cell<u32> = const { Cell::new(0) };
    /// The results of host fetches, by request ID. `None` while the fetch is in progress.
    static FETCHES: RefCell<HashMap<u32, Option<Result<Vec<u8>>>>> = RefCell::new(HashMap::new());
}

/// Called by the `navigraph_fetch_complete` export when the host has finished a fetch
///
/// * `request_id` - The ID passed to the host with the fetch
/// * `result` - The response body, or an error message
pub(super) fn complete_fetch(request_id: u32, result: Result<Vec<u8>, String>) {
    FETCHES.with_borrow_mut(|fetches| {
        if let Some(slot) = fetches.get_mut(&request_id) {
            *slot = Some(result.map_err(|e| anyhow!("host fetch failed: {e}")));
        }
    });
}

/// A fetch run by the host. It is polled once per update like the other function futures, until the host passes the result back.
struct HostFetch {
    request_id: u32,
}

impl HostFetch {
    fn new(url: &str) -> Self {
        let request_id = NEXT_FETCH_ID.get();
        NEXT_FETCH_ID.set(request_id.wrapping_add(1));
        FETCHES.with_borrow_mut(|fetches| fetches.insert(request_id, None));

        // SAFETY: The pointer is valid for the given length for the duration of the call, and the host copies the URL before returning
        unsafe { host::fetch(request_id, url.as_ptr(), url.len()) };

        Self { request_id }
    }
}

impl Future for HostFetch {
    type Output = Result<Vec<u8>>;

    fn poll(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        FETCHES.with_borrow_mut(|fetches| {
            if let Some(None) = fetches.get(&self.request_id) {
                return Poll::Pending;
            }

            Poll::Ready(
                fetches
                    .remove(&self.request_id)
                    .flatten()
                    .unwrap_or_else(|| Err(anyhow!("unknown fetch request {}", self.request_id))),
            )
        })
    }
}

impl Drop for HostFetch {
    fn drop(&mut self) {
        FETCHES.with_borrow_mut(|fetches| fetches.remove(&self.request_id));
    }
}

/// The standalone platform with remote data: runs outside the sim, messaging the host directly and serving Navigraph navigation data
/// downloaded through the host. There is no navigation data until the first `DownloadNavigationData` call.
pub(crate) struct StandalonePlatform;

impl Platform for StandalonePlatform {
    fn send_message(channel: &str, data: &str) {
        send_message(channel, data)
    }

    fn init_database() -> Result<Option<Connection>> {
        Ok(None)
    }

    fn open_database() -> Result<Connection> {
        INSTALLED.with_borrow(|installed| {
            let installed = installed.as_ref().context("no navigation data installed")?;
            load_database(&installed.db)
        })
    }

    fn get_cycle_info() -> Result<CycleInfo> {
        INSTALLED.with_borrow(|installed| {
            CycleInfo::from_json(&installed.as_ref().context("no navigation data installed")?.cycle_json)
        })
    }

    fn installed_path() -> Option<String> {
        INSTALLED.with_borrow(|installed| installed.as_ref().map(|i| i.db_name.clone()))
    }

    async fn get_latest_cycle() -> Result<Option<String>> {
        // Support cases in which the host may be offline (or blocked by CORS) by returning a None instead
        let Ok(res) = HostFetch::new(LATEST_CYCLE_ENDPOINT).await else {
            return Ok(None);
        };

        let response_info = serde_json::from_slice::<CycleResponseInfo>(&res)
            .context("can't deserialize cycle response info")?;

        Ok(Some(response_info.cycle))
    }

    /// Download the navigation data zip file through the host, keeping it in memory until it is installed
    async fn download_navigation_data(url: &str) -> Result<()> {
        let data = HostFetch::new(url)
            .await
            .context("can't download navigation data")?;

        // The host downloads in one go, so report a single chunk once it's done
        InterfaceEvent::send_download_progress_event(DownloadProgressEvent {
            total_bytes: data.len(),
            downloaded_bytes: data.len(),
            current_chunk: 0,
            total_chunks: 1,
        })
        .context("can't send download progress event")?;

        DOWNLOADED.set(Some(data));

        Ok(())
    }

    /// Extract the navigation data files from the downloaded zip file, replacing the active navigation data
    async fn install_downloaded_navigation_data() -> Result<()> {
        let zip_data = DOWNLOADED.take().context("no downloaded navigation data")?;
        let mut zip = ZipArchive::new(Cursor::new(zip_data))
            .context("can't read zip archive from downloaded data")?;

        let mut cycle_json = String::new();
        zip.by_name("cycle.json")
            .context("can't find cycle.json in zip")?
            .read_to_string(&mut cycle_json)
            .context("can't read cycle.json from zip")?;

        // Ensure the cycle info is valid before replacing the active navigation data
        CycleInfo::from_json(&cycle_json)?;

        let db_name = zip
            .file_names()
            .find(|f| f.to_lowercase().ends_with(".s3db"))
            .context("unable to find sqlite db in downloaded zip")?
            .to_owned();

        let mut db = Vec::new();
        zip.by_name(&db_name)
            .context("can't find db in zip")?
            .read_to_end(&mut db)
            .context("can't read db from zip")?;

        INSTALLED.set(Some(InstalledNavigationData {
            cycle_json,
            db,
            db_name,
        }));

        Ok(())
    }
}
