import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Semaphore } from "./semaphore.ts";
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";

Deno.test("acquire resolves immediately when permits available", async () => {
  const sem = new Semaphore(2);
  await using _a = await sem.acquire();
  await using _b = await sem.acquire();
  // Both acquired without blocking — test passes by not hanging
});

Deno.test("acquire blocks when no permits available", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];

  await using _permit = await sem.acquire();

  // This acquire should block until the permit above is disposed
  const blocked = (async () => {
    await using _p = await sem.acquire();
    order.push(2);
  })();

  // Give the blocked task a tick to prove it hasn't resolved
  await delay(10);
  order.push(1);

  // Disposing _permit (scope exit) will unblock the waiting acquire
  _permit[Symbol.dispose]();

  await blocked;
  assertEquals(order, [1, 2]);
});

Deno.test("dispose wakes the next waiter in FIFO order", async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];

  const permit = await sem.acquire();

  const first = (async () => {
    await using _p = await sem.acquire();
    order.push("first");
  })();

  const second = (async () => {
    await using _p = await sem.acquire();
    order.push("second");
  })();

  // Let both waiters enqueue
  await delay(10);

  permit[Symbol.dispose]();
  await first;
  await second;

  assertEquals(order, ["first", "second"]);
});

Deno.test("concurrency is bounded to permit count", async () => {
  const sem = new Semaphore(3);
  let running = 0;
  let maxRunning = 0;

  const tasks = Array.from({ length: 10 }, (_, i) =>
    (async () => {
      await using _p = await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(20); // Simulate work
      running--;
    })());

  await Promise.all(tasks);

  assertEquals(maxRunning, 3);
  assertEquals(running, 0);
});

Deno.test("dispose on throw still releases the permit", async () => {
  const sem = new Semaphore(1);

  // Acquire and throw — permit should still be released
  try {
    await using _p = await sem.acquire();
    throw new Error("boom");
  } catch {
    // expected
  }

  // Should not hang — permit was released by dispose despite the throw
  await using _p = await sem.acquire();
});
