// Bounded-concurrency primitives shared by the pipeline scripts.

// Caps how many tasks run at once; the rest queue. Usage:
//   const limit = createLimiter(16);
//   await limit(() => doWork());
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// Worker pool over a list: `concurrency` workers pull the next item until the
// list is exhausted. `fn` is expected to handle its own per-item errors; an
// uncaught throw aborts the whole pool (used for fatal browser-gone errors).
async function mapPool(items, concurrency, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

module.exports = { createLimiter, mapPool };
