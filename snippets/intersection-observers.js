// Observer 1: shell → full message (hydration)
const lazyMsgHydrator = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    const id = el.dataset.id;
    const node = lazyMsgData.get(id);
    if (!node) continue;

    const full = node.role === 'user' ? mkUser(node) : mkAI(node);
    el.replaceWith(full);
    lazyMsgData.delete(id);
    lazyMsgHydrator.unobserve(el);
  }
}, { rootMargin: '600px 0px' });

// Observer 2: lazy Markdown rendering (optional — redundant if using two-tier)
const lazyObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    el.innerHTML = md(el.dataset.lazyMd);
    delete el.dataset.lazyMd;
    lazyObserver.unobserve(el);
  }
}, { rootMargin: '600px 0px' });

// Observer 3: image lazy loading
const lazyImgObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src = img.dataset.lazySrc;
    lazyImgObserver.unobserve(img);
  }
}, { rootMargin: '300px 0px' });
