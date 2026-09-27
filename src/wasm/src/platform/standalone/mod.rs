use std::ptr::NonNull;

use anyhow::{Context, Result};
use rusqlite::{ffi, serialize::OwnedData, Connection, DatabaseName};

/// The exported entry points, called by the `StandaloneTransport` in the TS package
mod exports;

/// Serves the mock navigation data embedded in the module (the default)
#[cfg(not(feature = "remote-data"))]
mod mock;
#[cfg(not(feature = "remote-data"))]
pub(crate) use mock::StandalonePlatform;

/// Serves Navigraph navigation data, downloaded through the host at runtime (the `remote-data` feature)
#[cfg(feature = "remote-data")]
mod remote;
#[cfg(feature = "remote-data")]
pub(crate) use remote::StandalonePlatform;

mod host {
    #[link(wasm_import_module = "navigraph")]
    extern "C" {
        /// Deliver a message to the host. The host copies the data before returning.
        pub fn send_message(
            channel_ptr: *const u8,
            channel_len: usize,
            data_ptr: *const u8,
            data_len: usize,
        );

        /// Ask the host to fetch a URL. The host copies the URL before returning, and later passes the response body back through
        /// the `navigraph_fetch_complete` export with the same request ID.
        #[cfg(feature = "remote-data")]
        pub fn fetch(request_id: u32, url_ptr: *const u8, url_len: usize);
    }
}

/// Send a message to the host
fn send_message(channel: &str, data: &str) {
    // SAFETY: The pointers are valid for the given lengths for the duration of the call, and the host copies the data before returning
    unsafe { host::send_message(channel.as_ptr(), channel.len(), data.as_ptr(), data.len()) }
}

/// Load a SQLite database into memory, as there is no filesystem to rely on
///
/// * `bytes` - The contents of the database file
fn load_database(bytes: &[u8]) -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;

    // SQLite takes ownership of the buffer, which must be allocated with sqlite3_malloc.
    // SAFETY: The buffer is allocated by SQLite with the required size, and fully initialized before being handed over
    let data = unsafe {
        let ptr = ffi::sqlite3_malloc64(bytes.len() as u64) as *mut u8;
        let ptr = NonNull::new(ptr).context("can't allocate memory for navigation data")?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.as_ptr(), bytes.len());
        OwnedData::from_raw_nonnull(ptr, bytes.len())
    };
    conn.deserialize(DatabaseName::Main, data, true)
        .context("can't load navigation data")?;

    // Keep temp storage in memory, as there is no filesystem to rely on
    conn.execute_batch("PRAGMA temp_store = MEMORY")?;

    Ok(conn)
}
