/**
 * Reveal elements as they scroll into view.
 *
 * Position-based rather than intersection-based, following the same reasoning
 * as the N1AC site: an element that gets jumped past — a deep link, scroll
 * restoration on reload, a fast flick — never "intersects", so an
 * IntersectionObserver would leave it invisible forever.
 *
 * Anyone who has asked for reduced motion gets everything shown at once.
 */
export function startReveal({ selector = '.reveal', threshold = 0.85 } = {}) {
  const items = Array.prototype.slice.call(document.querySelectorAll(selector));
  if (!items.length) return;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const el of items) el.classList.add('is-visible');
    return;
  }

  let pending = items;
  let queued = false;

  function sweep() {
    queued = false;
    pending = pending.filter((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight * threshold) {
        el.classList.add('is-visible');
        return false;
      }
      return true;
    });
    if (!pending.length) {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sweep);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  schedule();
}
