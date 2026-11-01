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

afterEach(() => {
  cleanup();
});
