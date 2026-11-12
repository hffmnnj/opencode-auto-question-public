import { OpenCode } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeLocalFetch } from "./local-fetch.ts";

const CURRENT_SERVER = "http://127.0.0.1:4108";

type ClientOptions = {
  file?: string;
  useCurrentServer?: boolean;
  transport?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
};

export async function discoverLocalService(version: string, file?: string): Promise<Endpoint> {
  // The SDK's discovery probe uses global fetch. Isolate that override in a
  // worker so it cannot affect the host or other plugins' network requests.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`./discovery-worker.${extension}`, import.meta.url));
  try {
    return await new Promise<Endpoint>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCode service discovery timed out.")), 8_000);
      worker.onmessage = (event: MessageEvent<Endpoint | undefined>) => {
        clearTimeout(timer);
        if (event.data === undefined) reject(new Error("No compatible local OpenCode service found."));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        clearTimeout(timer);
        reject(new Error("OpenCode service discovery failed."));
      };
      // Bun workers snapshot their environment independently. Resolve the SDK's
      // documented default in the host so both use the same registration.
      const registration = file ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "service.json");
      worker.postMessage({ version, file: registration });
    });
  } finally {
    worker.terminate();
  }
}

export async function createLocalClient(version: string, pid: number, signal: AbortSignal, options: ClientOptions = {}) {
  const env = options.env ?? process.env;
  const endpoint: Endpoint = options.useCurrentServer
    ? { url: CURRENT_SERVER, auth: { type: "basic", username: env.OPENCODE_SERVER_USERNAME ?? "", password: env.OPENCODE_SERVER_PASSWORD ?? "" } }
    : await discoverLocalService(version, options.file);
  if (!endpoint.auth || !endpoint.auth.password || !endpoint.auth.username || endpoint.auth.username.includes(":")) {
    throw new Error("OpenCode service authentication is required.");
  }
  // Recheck the returned URL at the API boundary, not just in the worker.
  const url = new URL(endpoint.url);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid OpenCode service URL.");
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    fetch: makeLocalFetch(options.transport ?? fetch, options.useCurrentServer ? CURRENT_SERVER : undefined),
  });
  const server = await client.server.info({ signal });
  if (server.pid !== pid || server.version !== version) {
    throw new Error("opencode-auto-question refuses to answer forms on another OpenCode server.");
  }
  return client;
}
