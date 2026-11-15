// The tests' fakes wait with Node's setImmediate; the browser has none.
const g = globalThis as unknown as { setImmediate?: (f: () => void) => unknown };
g.setImmediate ??= (f) => setTimeout(f, 0);
