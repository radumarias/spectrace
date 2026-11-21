import { createApp } from "./app";

// Only /api/* reaches this Worker (see `run_worker_first` in wrangler.toml);
// the web app is served by Workers Static Assets.
export default createApp();
