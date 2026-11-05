// Preload for the migration scripts that simulates the connection drops of the Commercial → Federal run:
// a share of GET responses arrive with their headers, then the body fails partway ("error reading a
// body from connection") or ends early (truncated JSON). POST/PATCH are never touched, since they are
// not replayed. A fixed seed makes a run reproducible.
//
// Usage:
//   deno run --allow-net --allow-read --allow-write --preload scripts/e2e/fault_injection.ts \
//     src/scripts/launchdarkly-migrations/migrate_between_ld_instances.ts <migrate args>

const DROP_RATE = 0.1;
const TRUNCATE_RATE = 0.03;
let seed = 20261104;

// mulberry32: small, seedable, good enough to pick requests
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const counts = { gets: 0, dropped: 0, truncated: 0 };
const realFetch = globalThis.fetch;

globalThis.fetch = async (
  input: Request | URL | string,
  init?: RequestInit,
): Promise<Response> => {
  const req = new Request(input, init);
  const res = await realFetch(req);
  if (req.method !== "GET" || !res.body) return res;
  counts.gets++;
  const roll = random();
  if (roll >= DROP_RATE + TRUNCATE_RATE) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const cut = bytes.slice(0, Math.floor(bytes.length / 2));
  if (roll < DROP_RATE) {
    counts.dropped++;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(cut);
        controller.error(
          new TypeError(
            "error reading a body from connection (injected by fault_injection.ts)",
          ),
        );
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  counts.truncated++;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(cut, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

globalThis.addEventListener("unload", () => {
  console.log(
    `[fault_injection] ${counts.gets} GET responses: ${counts.dropped} bodies dropped, ${counts.truncated} truncated`,
  );
});
