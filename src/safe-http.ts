import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

const blockedAddresses = new BlockList();
const blockedV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const blockedV6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

for (const [network, prefix] of blockedV4) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of blockedV6) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export interface SafeGetOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeHttpResponse {
  ok: boolean;
  status: number;
  body: Buffer;
}

export function redactTarget(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return /^https?:/i.test(raw) ? "<remote target>" : raw;
  }
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}

export async function collectLimitedBody(
  body: AsyncIterable<Uint8Array>,
  declaredLength: string | string[] | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Array.isArray(declaredLength) ? Number.NaN : Number(declaredLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`download exceeds ${maxBytes} bytes`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of body) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`download exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function safeGet(
  rawUrl: string,
  options: SafeGetOptions,
): Promise<SafeHttpResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = rawUrl;
  const visited = new Set<string>();

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const parsed = parseRemoteUrl(current);
    if (visited.has(parsed.href)) throw new Error("remote redirect loop detected");
    visited.add(parsed.href);

    const addresses = await withTimeout(
      lookup(stripIpv6Brackets(parsed.hostname), { all: true, verbatim: true }),
      timeoutMs,
      "remote DNS lookup timed out",
    );
    if (addresses.length === 0) throw new Error("remote host did not resolve");
    if (addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new Error("remote host resolves to a blocked or non-public address");
    }

    const selected = addresses[0];
    if (!selected) throw new Error("remote host did not resolve");
    const response = await requestOnce(parsed, selected, options, timeoutMs);
    if (!isRedirect(response.status) || !response.location) {
      return { ok: response.status >= 200 && response.status < 300, status: response.status, body: response.body };
    }
    if (redirects === maxRedirects) throw new Error("remote redirect limit exceeded");
    try {
      current = new URL(response.location, parsed).toString();
    } catch {
      throw new Error("remote redirect is invalid");
    }
  }

  throw new Error("remote redirect limit exceeded");
}

function parseRemoteUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("invalid remote URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("remote URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("remote URLs with embedded credentials are not allowed");
  }
  if (!parsed.hostname || parsed.hostname.includes("%")) {
    throw new Error("remote URL has an invalid host");
  }
  return parsed;
}

async function requestOnce(
  url: URL,
  address: { address: string; family: number },
  options: SafeGetOptions,
  timeoutMs: number,
): Promise<{ status: number; location?: string; body: Buffer }> {
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.get(
      url,
      {
        agent: false,
        family: address.family,
        headers: options.headers,
        lookup: pinnedLookup,
      },
      (response) => {
        void (async () => {
          try {
            const body = await collectLimitedBody(
              response,
              response.headers["content-length"],
              options.maxBytes,
            );
            clearTimeout(timer);
            resolve({
              status: response.statusCode ?? 0,
              location: response.headers.location,
              body,
            });
          } catch (error) {
            response.destroy();
            clearTimeout(timer);
            reject(error);
          }
        })();
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error(`remote request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    request.once("error", () => {
      clearTimeout(timer);
      reject(new Error("remote request failed"));
    });
  });
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
