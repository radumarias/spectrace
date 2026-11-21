//! Prints the OpenAPI document to stdout (used by `just api-client`; no database needed).
#![allow(clippy::print_stdout)]
use utoipa::OpenApi;

fn main() {
    match spectrace_server::openapi::ApiDoc::openapi().to_pretty_json() {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("cannot render OpenAPI: {e}");
            std::process::exit(1);
        }
    }
}
