// Per-conversation DOM containers — switch without re-rendering
const convSlots = new Map();

function createSlot(convId) {
  const el = document.createElement('div');
  el.className = 'conv-slot';
  el.style.display = 'none';
  root.appendChild(el);
  const slot = { el, scrollTop: 0 };
  convSlots.set(convId, slot);
  return slot;
}

function activateSlot(convId) {
  const prev = root.querySelector('.conv-slot.active');
  if (prev) {
    const prevSlot = convSlots.get(prev.dataset.conv);
    if (prevSlot) prevSlot.scrollTop = root.scrollTop;
    prev.classList.remove('active');
    prev.style.display = 'none';
  }

  let slot = convSlots.get(convId);
  if (!slot) slot = createSlot(convId);
  slot.el.style.display = '';
  slot.el.classList.add('active');

  root.scrollTop = slot.scrollTop || 0;

  return slot;
}
