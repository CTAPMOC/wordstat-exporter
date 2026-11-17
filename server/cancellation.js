import { setTimeout } from "node:timers/promises";
export const sleep = (ms, signal) => setTimeout(ms, undefined, { signal });
export function withAbort(action, signal) {
  signal?.throwIfAborted();
  if (!signal) return action();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}
