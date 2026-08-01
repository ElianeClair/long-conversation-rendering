// Single-message surgical replacement with scroll compensation
function swapMsgEl(node) {
  const stale = container.querySelector(`[data-id="${node.id}"]`);
  if (!stale) return;

  const fresh = node.role === 'user' ? mkUser(node) : mkAI(node);
  fresh.style.contentVisibility = 'visible';

  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  const topBefore = stale.getBoundingClientRect().top;
  stale.replaceWith(fresh);

  if (nearBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollBy(0, fresh.getBoundingClientRect().top - topBefore);
  }
}
