# Rendering Optimization for Nonlinear Conversations

[中文原文](nonlinear-rendering.zh-CN.md)

In a tree-branching conversation, the user can fork at any point, backtrack, and switch between paths. Every branch switch updates the message list on screen — but must not re-render the whole window. These notes cover surgical DOM replacement on branch switches, navigator anchoring, and DOM reuse across conversations.

This is the branching companion to [Long-conversation open-window optimization](README.md). The general techniques (`content-visibility`, tiered lazy loading, scroll correction) live there; this article covers only what is specific to trees.

> *Premise*  This article assumes your conversations are tree-shaped — each message is a node, each fork creates sibling nodes, and the frontend renders one root-to-leaf path. How the tree is stored (parent pointers, child arrays, adjacency lists…) doesn't affect any of this — as long as you can extract "the current path" as an ordered list, everything below applies.

## Contents

- [renderDiff: replace only past the divergence point](#1-renderdiff-replace-only-past-the-divergence-point)
- [Temporarily overriding content-visibility](#2-temporarily-overriding-content-visibility)
- [Navigator anchoring](#3-navigator-anchoring)
- [Edit and retry: branch switches, not single swaps](#4-edit-and-retry-branch-switches-not-single-swaps)
- [DOM slots: reusing DOM across conversations](#5-dom-slots-reusing-dom-across-conversations)
- [Where this applies: what if your tree looks different](#6-where-this-applies-what-if-your-tree-looks-different)

## 1 renderDiff: replace only past the divergence point

In a tree conversation, what's rendered on screen is one root-to-leaf path. When switching branches, the new path and the old path share a prefix — from the root to the divergence point. Everything before the divergence is identical; its DOM must not be touched.

```text
old path:  A → B → C → D → E
new path:  A → B → C → F → G → H
                     ↑
              divergence point
              keep=3, remove 2, add 3
```

`renderDiff` does three things: find the divergence point, remove the old DOM past it, append the new DOM.

```js
function renderDiff(oldPathIds) {
  const newPath = getPath();
  const newIds = newPath.map(n => n.id);

  // Find the divergence: compare old and new path IDs one by one
  let divIdx = 0;
  while (divIdx < oldPathIds.length &&
         divIdx < newIds.length &&
         oldPathIds[divIdx] === newIds[divIdx]) {
    divIdx++;
  }

  // No shared prefix — give up on diffing, fall back to a full render
  if (divIdx === 0) { renderAll(); return; }

  // Remove the old DOM past the divergence
  const removedSet = new Set(oldPathIds.slice(divIdx));
  for (const el of container.querySelectorAll('.msg')) {
    if (removedSet.has(el.dataset.id)) el.remove();
  }

  // Append the new path from the divergence on
  const tail = newPath.slice(divIdx);
  const frag = document.createDocumentFragment();
  tail.forEach(node => {
    frag.appendChild(node.role === 'user' ? mkUser(node) : mkAI(node));
  });
  container.appendChild(frag);
}
```

Take a 500-message conversation with a branch switch at message 490. `renderDiff` leaves the first 489 messages' DOM untouched, removes 11, and mounts the new ones. Against a full `renderAll`, that's 98% of the work saved.

> **Why a Set instead of deleting from the tail?** Past the divergence, the old and new paths can differ in length, and the DOM may contain lazy-loading shells. Deleting by ID match through a `Set` is more robust than deleting by reverse index — it doesn't depend on DOM element order and count matching the path array.

## 2 Temporarily overriding content-visibility

`content-visibility: auto` hands every unrendered message an estimated height (`contain-intrinsic-size: auto 400px`). When `renderDiff` appends new nodes, the estimate bites in two ways:

**Problem 1: the streaming tail after edit/retry.** After the user edits or retries, the last node `renderDiff` appends is an empty husk — the AI reply hasn't arrived yet; content will stream in and fill it word by word. Its true initial height is near zero, but `content-visibility: auto` estimates it at 400px. Scrolled to the bottom, the browser sees a 400px-inflated husk; as the reply streams in and real height grows, the 400px collapses to the truth and the viewport lurches violently.

**Problem 2: the anchored element on a navigator flip.** When the user flips branches mid-conversation, the first new node `renderDiff` appends is the anchoring target — its bottom edge must be measured precisely for scroll correction. If `content-visibility: auto` gives it a 400px estimate, the measurement comes out wrong.

The fix: for exactly these two kinds of nodes, temporarily force `content-visibility: visible`.

```js
tail.forEach((node, i) => {
  const el = node.role === 'user' ? mkUser(node) : mkAI(node);

  // Streaming tail, or anchoring target: skip the 400px estimate, use the real height
  if (isLiveTail || (isNavFlip && i === 0)) {
    el.style.contentVisibility = 'visible';
  }

  frag.appendChild(el);
});
```

`content-visibility: visible` tells the browser to lay this element out fully, right now, no estimates. The cost is a slightly slower first render for that one element; the payoff is no height collapse and no viewport jump afterwards.

## 3 Navigator anchoring

A tree conversation's navigator (the ‹ › branch-switch arrows) sits at the bottom edge of the message being flipped. Flipping rapidly replaces that message's DOM again and again, and sibling branches can differ in height — without anchoring, every flip bounces the whole viewport and the arrows fly around under the user's finger.

The anchoring move: before replacing the DOM, record the screen coordinate of the flipped message's bottom edge; after replacing, measure the new message's bottom edge; correct the difference with `scrollBy`.

```js
// Before: remember the old message's bottom edge on screen
const anchorEl = container.querySelector(`.msg[data-id="${anchorId}"]`);
const bottomBefore = anchorEl.getBoundingClientRect().bottom;

// ... renderDiff runs here — remove old, append new ...

// After: measure the new message's bottom edge, correct the scroll position
const freshEl = container.querySelector(`.msg[data-id="${newTail[0].id}"]`);
const bottomAfter = freshEl.getBoundingClientRect().bottom;
root.scrollBy({ top: bottomAfter - bottomBefore, behavior: 'instant' });
```

The effect: whether the new message is taller or shorter than the old one, the navigator arrows keep their position on screen. The height difference is absorbed above the viewport — taller messages grow upward, shorter ones shrink from above. The user's finger keeps tapping the same spot to flip.

> **Why scrollBy instead of scrollTop +=?** On mobile (iOS Safari especially), reading `scrollTop` during momentum scrolling returns a stale value — adding an offset to that stale value and writing it back drags the viewport to where the momentum began. `scrollBy` is a relative operation, applied by the browser against the true current offset, and immune to the staleness.

## 4 Edit and retry: branch switches, not single swaps

In a linear conversation, editing a message = replacing that message's DOM ([swapMsgEl](README.md#5-surgical-dom-replacement)). In a tree conversation, editing a message means something entirely different — it creates a new branch at the edit point:

```text
before:   A → B → C → D → E
                   ↑ edit C
after:    A → B → C' → (awaiting AI reply)
               ↗
old branch:  A → B → C → D → E   (still exists; you can switch back)
```

After editing C, everything after C (D, E) belongs to the old branch — still present in the data layer, no longer on the current path. The frontend must remove C, D, E's DOM and mount C'. That is exactly one `renderDiff`, with the divergence at B.

Retry works the same way. Retrying AI reply E produces E′ — forking at E's parent D. Remove E's DOM, mount E′. Divergence at D.

So in a tree conversation, edit and retry render through `renderDiff`, not `swapMsgEl`. `swapMsgEl` only serves the linear scenario of "one message changed, everything else stays."

## 5 DOM slots: reusing DOM across conversations

When the user hops back and forth between conversations, triggering a full `renderAll` on every switch is wasteful — the conversation they left 30 seconds ago still has warm DOM.

The fix: keep a DOM slot per opened conversation — a hidden container element preserving that conversation's complete message DOM.

```js
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
  // 1. Save the current conversation's scroll position, hide it
  const prev = root.querySelector('.conv-slot.active');
  if (prev) {
    const prevSlot = convSlots.get(prev.dataset.conv);
    if (prevSlot) prevSlot.scrollTop = root.scrollTop;
    prev.classList.remove('active');
    prev.style.display = 'none';
  }

  // 2. Activate the target conversation's slot (create if missing)
  let slot = convSlots.get(convId);
  if (!slot) slot = createSlot(convId);
  slot.el.style.display = '';
  slot.el.classList.add('active');

  // 3. Restore the scroll position
  root.scrollTop = slot.scrollTop || 0;

  return slot;
}
```

Switching back to a previously opened conversation, its slot already exists — message DOM intact, lazy-loading state intact, scroll position intact. `display: none` → `display: ''`, and nothing re-renders.

This composes with `content-visibility: auto`: no message inside a hidden slot gets laid out or painted, so inactive slots cost no render time. Only the visible messages in the active slot participate in rendering.

## 6 Where this applies: what if your tree looks different

These methods look tightly bound to trees. It's the opposite — **none of this cares about the tree; it only cares about the one line currently on screen.** `renderDiff`'s input is two lists of message IDs: old path, new path. The tree enters at `getPath()` and exits right after. Sort each mechanism by what it attaches to, and portability becomes obvious:

```text
per message       content-visibility · shell hydration · image lazy loading · height write-back
                  → structure-agnostic; take as is

per scroll        scroll anchor · pinBottom · navigator anchoring
container         → one set per scroll container; not applicable without a scrollbar

per path          renderDiff · shared prefix
                  → applies whenever the screen shows one line

data layer        tree · DAG · graph
                  → never enters the picture — speaks only through getPath()
```

### Deeper, wider trees: take it as is

More forks, deeper nesting — not one line changes. `renderDiff`'s cost tracks **path length**, not tree shape or branching factor. A hundred children per node is fine; the screen still shows one root-to-leaf line.

### Graphs and DAGs: two things to check first

Structures that fork and then re-merge, nodes with multiple parents — still fine, as long as what's displayed is one line. Check two things before porting:

1. **No node ID may appear twice on one path.** The `[data-id]` lookups and the `Set` deletion both use IDs as unique keys. Cycles, or a node visited twice on one path, break them — switch to position+ID keys there.
2. **renderDiff only harvests the shared prefix.** If two paths are "same start, different middle, merged ending" (the classic merge-node shape), the merged tail gets torn down and rebuilt for nothing. Correctness survives — the worst case degenerates to a full render, with `renderAll` as the floor — you just save less. If it matters to you, add shared-suffix detection; in most scenarios it isn't worth it.

### More than one line on screen: port it in pieces

Side-by-side branch comparison, multi-column parallel views, canvas views that draw the whole tree — these interfaces can't take the package whole, but it splits cleanly: **the per-message mechanisms all carry over** (content-visibility, shells, lazy loading are per-element and structure-blind) — run one set per column; **the per-scroll-container mechanisms need redoing** — they assume one vertical scroll container, so give each column its own anchor set, and a canvas view positioned by transforms has no scrollbar at all — scroll anchor and pinBottom simply don't apply. `renderDiff`'s "untouched parts stay" becomes "untouched columns stay" — the idea survives; the code gets rewritten.

### Two well-hidden assumptions

Finally, two defaults that are easy to miss. **Bottom-pinning assumes "newest at the bottom"** — a chat-interface habit. A top-down, document-style interface swaps pin-bottom for pin-top; the idea is unchanged. **"Edit = new branch" (§4) is a product decision, not a rendering requirement** — if your edits are in-place and keep no old branch, you're back to [the main article's swapMsgEl](README.md#5-surgical-dom-replacement); the two coexist fine.

One sentence to sum it up: **however weird the tree gets, it doesn't matter — it's the screen getting weird that matters.** Let the data layer grow however it likes; as long as the view layer is still "one scrollable line," everything here generalizes.

---

8.1 First edition.

8.1 Second-pass review + English edition. — fable5

<sub>Architecture & documentation: Opus 4.6 · Second-pass review & English translation: Fable 5</sub>
