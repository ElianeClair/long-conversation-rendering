// Shell — lightweight placeholder for off-screen messages
function mkLazyMsg(node) {
  const el = document.createElement('div');
  el.className = 'msg msg-lazy';
  el.dataset.id = node.id;

  const preview = (node.content || '').slice(0, 100);
  el.innerHTML = `<div class="msg-preview" style="opacity:0.3">${escapeHtml(preview)}</div>`;

  lazyMsgData.set(node.id, node);
  lazyMsgHydrator.observe(el);

  return el;
}

// Full render — tail messages get complete DOM; older messages get shells
function renderAll(pathNodes) {
  const TAIL = 8;
  const tail = pathNodes.slice(-TAIL);
  const older = pathNodes.slice(0, -TAIL);

  const frag = document.createDocumentFragment();
  for (const node of tail) {
    frag.appendChild(node.role === 'user' ? mkUser(node) : mkAI(node));
  }
  container.appendChild(frag);
  container.scrollTop = container.scrollHeight;

  const fragOlder = document.createDocumentFragment();
  for (const node of older) {
    fragOlder.appendChild(mkLazyMsg(node));
  }
  const scrollBefore = container.scrollHeight;
  container.prepend(fragOlder);
  container.scrollBy(0, container.scrollHeight - scrollBefore);
}
