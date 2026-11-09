import { Service } from "@opencode/client/service";
import { makeLocalFetch } from "./local-fetch.ts";

// Service.discover performs an authenticated probe using global fetch. The
// worker has its own global, allowing a loopback-only, no-redirect probe.
globalThis.fetch = makeLocalFetch(globalThis.fetch);

self.onmessage = async (event: MessageEvent<{ version: string; file?: string }>) => {
  try {
    self.postMessage(await Service.discover(event.data));
  } catch {
    self.postMessage(undefined);
  }
};
