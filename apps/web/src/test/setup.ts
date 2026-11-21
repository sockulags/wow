import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks the layout APIs cmdk and Radix call; they only need to exist.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver;
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;

// A timer a test leaves behind (a toast's exit, a debounce) would fire after the test file's
// window is gone and fail the run from another file. Every timer started is cleared once the test
// that started it has ended and its tree is unmounted.
const started = new Set<ReturnType<typeof setTimeout>>();
globalThis.setTimeout = new Proxy(globalThis.setTimeout, {
  apply(target, thisArg, args: Parameters<typeof setTimeout>) {
    const id = Reflect.apply(target, thisArg, args);
    started.add(id);
    return id;
  },
});

afterEach(() => {
  cleanup();
  for (const id of started) clearTimeout(id);
  started.clear();
  // Composer drafts are kept in the browser's storage (agent workbench spec 49); each test starts
  // without the last one's.
  globalThis.localStorage.clear();
});
