// Validate before sending credentials, including during the SDK discovery probe.
export function makeLocalFetch(transport: typeof fetch, origin?: string): typeof fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const address = input instanceof Request ? input.url : input.toString();
    if (origin !== undefined && address !== origin && !address.startsWith(`${origin}/`)) {
      throw new Error("OpenCode service must use the configured loopback address.");
    }
    const url = new URL(address);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
      url.username !== "" || url.password !== "" || (origin !== undefined && url.origin !== origin)
    ) throw new Error("OpenCode service must use a loopback address.");
    return transport(input, { ...init, redirect: "error" });
  }, { preconnect: transport.preconnect });
}
