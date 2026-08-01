// --- ResizeObserver: write real height back to contain-intrinsic-size ---
const msgHeightObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    const el = entry.target;
    const h = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
    if (h > 0) el.style.containIntrinsicSize = `auto ${h}px`;
  }
});

// --- Scroll Anchor: detect and correct drift ---
let scrollAnchorEl = null;
let scrollAnchorOff = 0;

function updateScrollAnchor() {
  if (atBottom()) { scrollAnchorEl = null; return; }
  const st = container.scrollTop;
  for (const m of container.querySelectorAll('.msg')) {
    if (m.offsetTop + m.offsetHeight > st) {
      scrollAnchorEl = m;
      scrollAnchorOff = m.offsetTop - st;
      return;
    }
  }
  scrollAnchorEl = null;
}
container.addEventListener('scroll', updateScrollAnchor);

// In ResizeObserver callback — correct drift
if (scrollAnchorEl && !scrollAnchorEl.isConnected) {
  updateScrollAnchor();
}
if (scrollAnchorEl && !atBottom()) {
  const drift = (scrollAnchorEl.offsetTop - container.scrollTop) - scrollAnchorOff;
  if (Math.abs(drift) > 1) container.scrollBy(0, drift);
}

// --- pinBottom: hold bottom during initial height stabilization ---
function pinBottom() {
  const gestures = ['wheel', 'touchstart', 'mousedown'];
  let stopped = false;
  const stop = () => { stopped = true; gestures.forEach(ev => window.removeEventListener(ev, stop)); };
  gestures.forEach(ev => window.addEventListener(ev, stop, { passive: true }));

  const t0 = performance.now();
  let calmSince = null;
  (function tick() {
    if (stopped) return;
    scrollAnchorEl = null;
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (dist > 1) {
      container.scrollTop = container.scrollHeight;
      calmSince = null;
    } else if (calmSince === null) {
      calmSince = performance.now();
    }
    const now = performance.now();
    if ((now - t0 > 5000 && calmSince !== null && now - calmSince > 1000) || now - t0 > 15000) { stop(); return; }
    requestAnimationFrame(tick);
  })();
}
