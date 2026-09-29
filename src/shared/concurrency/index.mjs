export function createRateGate(qps, concurrency) {
  let active = 0, starts = [], timer = null;
  const pending = [];
  const pump = () => {
    timer = null;
    const timestamp = Date.now();
    starts = starts.filter(value => timestamp - value < 1000);
    while (pending.length && active < concurrency && starts.length < qps) {
      const resolve = pending.shift();
      active += 1;
      starts.push(Date.now());
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        pump();
      });
    }
    if (pending.length && active < concurrency && !timer) {
      const delay = starts.length >= qps ? Math.max(1, 1000 - (timestamp - starts[0])) : 1;
      timer = setTimeout(pump, delay);
      timer.unref?.();
    }
  };
  return {
    acquire: () => new Promise(resolve => {
      pending.push(resolve);
      pump();
    })
  };
}
