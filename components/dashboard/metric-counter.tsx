"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * Counts up to `value`: from zero when the figure first appears after an in-app navigation, and
 * from the old figure when it changes (a new period). A server-rendered page shows the final
 * figure at once and does not drop back to zero on hydration, so the number is always correct
 * without JavaScript and for assistive tech. Reduced motion skips the animation.
 */
export function MetricCounter({ value, format = String, duration = 600, className }: { value: number; format?: (value: number) => string; duration?: number; className?: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  // false while hydrating server HTML, true for a component first rendered in the browser.
  const browserRender = useSyncExternalStore(noSubscription, () => true, () => false);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const from = shown.current ?? (browserRender ? 0 : value);
    shown.current = value;
    if (from === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { node.textContent = format(value); return; }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      node.textContent = format(progress === 1 ? value : Math.round(from + (value - from) * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    // Interrupted (a newer value, or Strict Mode's re-run): the next run starts from here again.
    return () => { cancelAnimationFrame(frame); shown.current = from; };
  }, [value, format, duration, browserRender]);

  return <span ref={element} className={className}>{format(value)}</span>;
}
