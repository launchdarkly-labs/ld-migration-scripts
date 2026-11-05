import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { exportBigSegmentCsv } from "./big_segments.ts";

// A response whose headers arrive but whose body stream fails partway, as when a connection drops
function dropped(status = 200, headers?: HeadersInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("user-"));
      controller.error(new TypeError("error reading a body from connection"));
    },
  });
  return new Response(stream, { status, headers });
}

const EXPORTS = "https://example.test/api/v2/segments/p/e/seg/exports";
const FILE = "https://storage.test/seg.csv";

async function runWith(
  handlers: Record<string, Array<() => Response>>,
): Promise<{ ok: boolean; message: string; csv: string; calls: string[] }> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const seen = new Map<string, number>();
  globalThis.fetch = ((input: Request | URL | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const id = `${req.method} ${req.url}`;
    calls.push(id);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    const list = handlers[id];
    if (!list) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(list[Math.min(n, list.length - 1)]());
  }) as typeof fetch;
  const dir = await Deno.makeTempDir({ prefix: "big-seg-" });
  try {
    const result = await exportBigSegmentCsv(
      "api-key",
      "example.test",
      "p",
      "e",
      "seg",
      `${dir}/out/seg.csv`,
    );
    const csv = await Deno.readTextFile(`${dir}/out/seg.csv`).catch(() => "");
    return { ...result, csv, calls };
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const complete = () =>
  new Response(
    JSON.stringify({
      status: "complete",
      _links: { download: { href: FILE, type: "text/csv" } },
    }),
    { headers: { "content-type": "application/json" } },
  );

Deno.test("a big segment download that drops once is retried", async () => {
  const result = await runWith({
    [`POST ${EXPORTS}`]: [
      () => new Response(JSON.stringify({ id: "exp-1" }), { status: 201 }),
    ],
    [`GET ${EXPORTS}/exp-1`]: [complete],
    [`GET ${FILE}`]: [
      () => dropped(200, { "content-type": "text/csv" }),
      () =>
        new Response("user-a\nuser-b\n", {
          headers: { "content-type": "text/csv" },
        }),
    ],
  });
  assertEquals(result.ok, true);
  assertEquals(result.csv, "user-a\nuser-b\n");
  assertEquals(result.calls.filter((c) => c === `GET ${FILE}`).length, 2);
});

Deno.test("an export whose create response body drops still finds its ID from Location", async () => {
  const result = await runWith({
    [`POST ${EXPORTS}`]: [
      () =>
        dropped(201, { location: "/api/v2/segments/p/e/seg/exports/exp-2" }),
    ],
    [`GET ${EXPORTS}/exp-2`]: [complete],
    [`GET ${FILE}`]: [() => new Response("user-a\n")],
  });
  assertEquals(result.ok, true);
  assertEquals(result.csv, "user-a\n");
  // The create was not replayed
  assertEquals(result.calls.filter((c) => c.startsWith("POST")).length, 1);
});
