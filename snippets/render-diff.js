// Replace only the divergence tail when switching branches
function renderDiff(oldPathIds) {
  const newPath = getPath();
  const newIds = newPath.map(n => n.id);

  let divIdx = 0;
  while (divIdx < oldPathIds.length &&
         divIdx < newIds.length &&
         oldPathIds[divIdx] === newIds[divIdx]) {
    divIdx++;
  }

  if (divIdx === 0) { renderAll(); return; }

  const removedSet = new Set(oldPathIds.slice(divIdx));
  for (const el of container.querySelectorAll('.msg')) {
    if (removedSet.has(el.dataset.id)) el.remove();
  }

  const tail = newPath.slice(divIdx);
  const frag = document.createDocumentFragment();
  tail.forEach((node, i) => {
    const el = node.role === 'user' ? mkUser(node) : mkAI(node);

    // Skip the 400px estimate for streaming tail or navigator anchor
    if (isLiveTail || (isNavFlip && i === 0)) {
      el.style.contentVisibility = 'visible';
    }

    frag.appendChild(el);
  });
  container.appendChild(frag);
}

// Navigator anchor — pin the branch arrow in place across switches
const anchorEl = container.querySelector(`.msg[data-id="${anchorId}"]`);
const bottomBefore = anchorEl.getBoundingClientRect().bottom;

// ... renderDiff runs here ...

const freshEl = container.querySelector(`.msg[data-id="${newTail[0].id}"]`);
const bottomAfter = freshEl.getBoundingClientRect().bottom;
root.scrollBy({ top: bottomAfter - bottomBefore, behavior: 'instant' });
