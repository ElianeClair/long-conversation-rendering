# Long-Conversation Open-Window Optimization

[中文原文](README.zh-CN.md)

When an AI chat window has accumulated a few hundred messages, opening it becomes a performance disaster — the browser parses, lays out, and paints every DOM node, and render time balloons from a few seconds to tens of seconds — or minutes. The mainstream answer is virtual scrolling: render only the elements visible in the viewport. But virtual scrolling kills the browser's native search (Cmd+F), breaks scroll positions, and is notoriously hard to tame with variable-height content.

These notes describe an alternative: every message stays in the DOM, but `content-visibility` + tiered lazy rendering + surgical DOM replacement let the browser skip everything that can't be seen. It pulls the rendering cost down from the tens-of-seconds-to-minutes range into second-level territory, with no libraries. Native JS + CSS, keeping every native browser capability.

> *Prerequisite*  This article assumes you already have a chat frontend that renders a message list — framework or vanilla. The core ideas are framework-agnostic: `content-visibility` is a CSS property, `IntersectionObserver` is a browser API, `DocumentFragment` is a DOM interface. React versus vanilla only changes the spelling, not the principle.

## Strategy overview

**This article (open-window optimization)**

- **content-visibility + contain-intrinsic-size** — one line of CSS skips layout and paint for off-viewport messages while keeping the DOM intact ([§2](#2-one-line-of-css-does-most-of-the-work))
- **Two-tier rendering** — the last 8 messages get full builds; every older message gets a 3-node featherweight shell, hydrated by an IntersectionObserver 600px before it scrolls into view ([§3](#3-two-tier-rendering-shells-and-full-messages))
- **Image lazy loading** — a 1×1 transparent pixel placeholder; the real request fires within 300px of the viewport; the only strategy here that needs the backend's help ([§4](#4-three-intersectionobservers))
- **Lazy Markdown rendering (optional)** — the minimal alternative when you don't want shells ([§4](#4-three-intersectionobservers))
- **Surgical replacement** — edit/retry `replaceWith`s exactly one element; pin its top edge back, force visible to skip the "birth frame" ([§5](#5-surgical-dom-replacement))
- **The scroll-correction trio** — a ResizeObserver writes real heights back; a scroll anchor detects and corrects drift; pinBottom holds the floor after opening and lets go the instant a gesture arrives ([§6](#6-scroll-position-correction))

**[The nonlinear companion](nonlinear-rendering.md)**

- **renderDiff** — branch switches tear down and rebuild only what's past the divergence point; the shared prefix is never touched
- **Temporary content-visibility override** — streaming tails and flip anchors get forced visible for honest measurements
- **Navigator anchoring** — branch flips pin the message's bottom edge in place so the ‹ › arrows stay under the user's finger
- **DOM slots** — every opened conversation keeps a hidden container; switching back re-renders nothing
- **Where this applies** — which layers survive deeper trees / DAGs / multi-column views

## Contents

1. [Why opening is slow](#1-why-opening-is-slow)
2. [One line of CSS does most of the work](#2-one-line-of-css-does-most-of-the-work)
3. [Two-tier rendering: shells and full messages](#3-two-tier-rendering-shells-and-full-messages)
4. [Three IntersectionObservers](#4-three-intersectionobservers)
5. [Surgical DOM replacement](#5-surgical-dom-replacement)
6. [Scroll position correction](#6-scroll-position-correction)
7. [Versus virtual scrolling](#7-versus-virtual-scrolling)
8. [Checklist](#8-checklist)

## 1 Why opening is slow

A message's DOM typically contains: avatar, username, timestamp, body (possibly Markdown-rendered HTML), images, code blocks, branch-navigation arrows. One message runs 10–50 DOM nodes. A 500-message window totals 5,000–25,000 nodes.

The browser renders them in three steps:

```text
Parse      build the DOM and CSSOM trees
Layout     compute every node's size and position
Paint      put pixels on screen
```

All three apply to every node — including the ones far outside the viewport that the user cannot see. For a 500-message window, the browser attempts a full layout and paint over twenty-odd thousand nodes the moment it opens. **The user waits tens of seconds and sees only the last few messages.** The layout and paint of the other 499 was pure waste.

The fix is intuitive — since the user only sees the bottom, render only the bottom. The question is how.

## 2 One line of CSS does most of the work

`content-visibility: auto` is a CSS property that tells the browser: if this element isn't near the viewport, skip its layout and paint. The element stays in the DOM — findable by `Cmd+F`, reachable from JavaScript — but the browser spends no time computing its style and position.

```css
.msg {
  content-visibility: auto;
  contain-intrinsic-size: auto 400px;
}
```

Two lines. The first turns on render-on-demand. The second hands the browser a height estimate — before the element has ever been laid out, the browser assumes `400px` when sizing the scrollbar. The `auto` keyword means: if the browser has rendered this element before and remembers its real height, use that; otherwise use `400px`.

This one rule solves most of the rendering cost. In a 500-message window the browser fully lays out and paints only the dozen-odd messages near the viewport and skips everything else. This step alone drops the open time by an order of magnitude.

> **Why not virtual scrolling?** `content-visibility: auto` and virtual scrolling attack the same problem (don't render what can't be seen) in completely different ways. Virtual scrolling deletes invisible elements from the DOM and recycles their nodes; `content-visibility` leaves elements in the DOM and just tells the browser not to draw them. One is deletion, the other is invisibility. Invisibility keeps every native browser capability — search, scrollbar, text selection, accessibility.

## 3 Two-tier rendering: shells and full messages

`content-visibility` skips layout and paint, but not DOM construction. The full DOM of all 500 messages still has to be built — Markdown-to-HTML, code highlighting, image tags — even if none of it will be painted. That construction takes real time by itself.

The fix: split messages into two tiers.

```text
                      ┌───────────────────────────┐
  a 500-message path  │ first 492  →  shells      │  mkLazyMsg()
                      │ last 8     →  full builds │  mkUser() / mkAI()
                      └───────────────────────────┘
```

**Full messages**: the last 8 (the part the user is actually looking at), built with the complete constructors — Markdown parsing, code highlighting, images, every interactive element. These 8 are visible and usable immediately.

**Shells**: every older message gets only a featherweight placeholder — a `<div class="msg">` holding a 100-character plain-text preview at 30% opacity. No Markdown, no interactive elements, no image requests. Node count per placeholder drops from 30+ to 3.

```js
function mkLazyMsg(node) {
  const el = document.createElement('div');
  el.className = 'msg msg-lazy';
  el.dataset.id = node.id;

  // A plain-text preview only — no rendering of any kind
  const preview = (node.content || '').slice(0, 100);
  el.innerHTML = `<div class="msg-preview" style="opacity:0.3">${escapeHtml(preview)}</div>`;

  // Park the full data in a Map; build when scrolled near
  lazyMsgData.set(node.id, node);
  lazyMsgHydrator.observe(el);   // hand it to Observer 1 (§4) — omit this line and shells never hydrate

  return el;
}
```

The opening render flow:

```js
function renderAll(pathNodes) {
  const TAIL = 8;
  const tail = pathNodes.slice(-TAIL);
  const older = pathNodes.slice(0, -TAIL);

  // 1. Render the tail first, batch-inserted via DocumentFragment
  const frag = document.createDocumentFragment();
  for (const node of tail) {
    frag.appendChild(node.role === 'user' ? mkUser(node) : mkAI(node));
  }
  container.appendChild(frag);
  container.scrollTop = container.scrollHeight;

  // 2. Then prepend shells for the older messages
  const fragOlder = document.createDocumentFragment();
  for (const node of older) {
    fragOlder.appendChild(mkLazyMsg(node));
  }
  const scrollBefore = container.scrollHeight;
  container.prepend(fragOlder);
  // Compensate the scroll position — prepend changed scrollHeight
  container.scrollBy(0, container.scrollHeight - scrollBefore);
}
```

Tail first, shells prepended after, so the user sees the newest content first. Inserting the shells doesn't repaint the visible region (they all land above the viewport), and with `content-visibility: auto` the browser doesn't lay them out either.

> **Why 8?** A viewport typically fits 5–10 messages. Eight guarantees the visible bottom region is fully covered. The number depends on your average message height and viewport size — too few exposes shells at the bottom, too many inflates the initial render.

## 4 Three IntersectionObservers

A shell can't stay a shell. As the user scrolls up, those 30%-opacity text previews should become full messages. That's a job for `IntersectionObserver` — the browser's native "element entered the viewport" detector.

### Observer 1: message hydration

When a shell comes within 600px of the viewport, replace it with a fully rendered message.

```js
const lazyMsgHydrator = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    const id = el.dataset.id;
    const node = lazyMsgData.get(id);
    if (!node) continue;

    // Build the full message DOM
    const full = node.role === 'user' ? mkUser(node) : mkAI(node);
    el.replaceWith(full);          // one-shot replacement
    lazyMsgData.delete(id);        // release the data reference
    lazyMsgHydrator.unobserve(el); // stop observing
  }
}, { rootMargin: '600px 0px' });
```

`rootMargin: '600px 0px'` widens the trigger zone to 600px above and below the viewport. A message finishes hydrating a screenful before the user reaches it — the shell-to-full swap never flickers in view.

### Observer 2: lazy Markdown rendering

Markdown-to-HTML has a cost — the parse time of a long message with code blocks is not negligible. For an already-hydrated message, the body can start as raw text and get its Markdown pass only when it nears the viewport.

```js
const lazyObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    el.innerHTML = md(el.dataset.lazyMd);   // parse Markdown only now
    delete el.dataset.lazyMd;
    lazyObserver.unobserve(el);
  }
}, { rootMargin: '600px 0px' });
```

> **This tier is optional.** It predates two-tier rendering (§3) — back when every message was fully built, Markdown parsing was one of the biggest first-paint costs, and deferring it paid off handsomely. With shells, an old message's Markdown parse already happens at hydration time (600px out), and this tier has no independent job left — our prototype eventually retired it. If you've built two-tier rendering, skip this tier; if you want the minimal change and no shells, this tier alone still buys back a big slice of first-paint parse time.

### Observer 3: image lazy loading

Images in a conversation should not load when the window opens — one window can hold dozens, each its own HTTP request. Set the image's `src` to a 1×1 transparent pixel first; when it comes within 300px of the viewport, set the real URL.

```js
const lazyImgObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src = img.dataset.lazySrc;   // request the image only now
    lazyImgObserver.unobserve(img);
  }
}, { rootMargin: '300px 0px' });
```

The three observers are independent, with no overlapping duties:

```text
Observer 1  rootMargin 600px   shell → full message
Observer 2  rootMargin 600px   raw text → Markdown HTML (optional)
Observer 3  rootMargin 300px   transparent pixel → real image
```

The image observer's rootMargin is smaller than the message observers' because image loading costs network requests — triggering too early wastes bandwidth — and 300px is usually enough to finish loading before the user scrolls to the image.

> **This one needs the backend to carry half.** Every other strategy in this article is frontend-only; image lazy loading has a prerequisite: there must be a "real URL" to set. If your images are already URLs (object storage, static files), the frontend part is all you need. But if images ride inline as base64 in the conversation payload, swapping in placeholders buys nothing — megabytes of image bytes still download with the open-window request; all you save is decode and paint. To collect the full win, the backend must put the payload on a diet: the conversation endpoint replaces image blocks with light stubs (block index + media type, no data), and a per-block image endpoint serves the bytes when the frontend asks. Ship one guard with it: if clients echo whole message arrays back on save, restore the stubs from the stored copy before writing to disk — otherwise a stub can overwrite real data.

## 5 Surgical DOM replacement

The opening render happens once. The interactions after it — editing a message, retrying an AI reply — must not re-render the whole window.

> If your conversations support tree branching, switching branches also needs a `renderDiff` — find where the old and new paths diverge and replace only the DOM past that point. That part is covered in [Rendering optimization for nonlinear conversations](nonlinear-rendering.md).

### swapMsgEl: replacing a single message

On edit or retry, exactly one message changed. Find that message's DOM element, build the new one, `replaceWith`. The scroll compensation pins **the new element's top edge**, not the height delta — the user is looking at this message, and what must survive is its position on screen; compensating by height delta shoves the content being read whenever the message is still inside the viewport.

```js
function swapMsgEl(node) {
  const stale = container.querySelector(`[data-id="${node.id}"]`);
  if (!stale) return;

  const fresh = node.role === 'user' ? mkUser(node) : mkAI(node);
  // Born in-viewport — skip content-visibility's 400px "birth frame"
  fresh.style.contentVisibility = 'visible';

  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  const topBefore = stale.getBoundingClientRect().top;
  stale.replaceWith(fresh);

  if (nearBottom) {
    // Following the bottom — re-pin the floor after the swap (hand off to pinBottom (§6) if still settling)
    container.scrollTop = container.scrollHeight;
  } else {
    // Reading mid-window — pin the new element's top edge back; the viewport must not move
    container.scrollBy(0, fresh.getBoundingClientRect().top - topBefore);
  }
}
```

Two traps worth naming. **The birth frame**: a freshly built element enters the DOM carrying `content-visibility: auto` and the 400px estimate; the browser doesn't classify it as "in viewport" until the next frame, so for one frame it participates in layout at the estimated height — a visible jump. Since you already know it's born on screen, mark it `visible` and skip the classification. **Replacements above the viewport**: if the replaced message sits above the viewport, its top edge doesn't move, but its height change shifts everything below it — that class of drift is not `swapMsgEl`'s job; the scroll anchor of §6 corrects it. Each mechanism owns one segment; together they add up to "nothing jumps."

> **Why not virtual-DOM diffing?** Virtual DOM (the React-family approach) minimizes real DOM operations by comparing new and old virtual trees. But in a message list we already know which message changed — no diffing algorithm is needed to "discover" it. A direct `replaceWith` beats any diff, because it skips the comparison entirely.

## 6 Scroll position correction

`content-visibility: auto` has a side effect: when the browser first lays out an element it has never rendered, the real height almost never equals the `400px` estimate. The height change moves the scroll position — the message the user is reading suddenly jumps up or down by tens of pixels.

Fixing this takes three parts:

### ResizeObserver: write the real height back

```js
const msgHeightObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    const el = entry.target;
    const h = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
    if (h > 0) el.style.containIntrinsicSize = `auto ${h}px`;
  }
});
```

Whenever a message is rendered and its real height computed, the `ResizeObserver` writes that height back into `contain-intrinsic-size`. The next time this message leaves the viewport and the browser skips its layout, it uses the real height instead of the `400px` guess. The `h > 0` guard keeps hidden or just-detached elements from poisoning the estimate with `0`.

### Scroll anchor: detect and correct drift

```js
let scrollAnchorEl = null;
let scrollAnchorOff = 0;

function updateScrollAnchor() {
  // No anchor while following the bottom — there, the floor is the position authority
  if (atBottom()) { scrollAnchorEl = null; return; }
  // Remember the first visible message at the top of the viewport, and its offset from the scroll position
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

// Inside the ResizeObserver callback — correct drift
if (scrollAnchorEl && !scrollAnchorEl.isConnected) {
  // The anchored message was just replaceWith'd — a detached node reads offsetTop 0,
  // and drift math against it would fling the viewport thousands of pixels.
  // Re-pick the anchor from the live DOM.
  updateScrollAnchor();
}
if (scrollAnchorEl && !atBottom()) {
  const drift = (scrollAnchorEl.offsetTop - container.scrollTop) - scrollAnchorOff;
  if (Math.abs(drift) > 1) container.scrollBy(0, drift);
}
```

The offset uses `offsetTop - scrollTop` (relative to the scroll container) rather than `getBoundingClientRect().top` (relative to the viewport) — a software keyboard or a page-level layout shift moves the container itself, and the former doesn't care. The anchor is the first visible message at the top of the viewport, not the middle: the goal is "the line being read doesn't move," and reading starts at the top edge.

> *replaceWith kills anchors*  This article calls `replaceWith` in several places: shell hydration (§4) and surgical replacement (§5). Whenever the element replaced happens to be the anchor, the anchor now points at a detached, dead node. Ship both guards: transfer the anchor at the replacement site (one line in Observer 1 and `swapMsgEl`: `if (scrollAnchorEl === el) scrollAnchorEl = full;`), and re-pick with an `isConnected` check before correcting drift. Miss this layer and hydrating one old message can fling the viewport — the most hidden trap in the anchor scheme.

### pinBottom: hold the floor after opening

For the first seconds after opening, shells hydrate in bulk and `content-visibility` estimates get corrected — the scroll height keeps changing. A `requestAnimationFrame` loop keeps the viewport pinned to the bottom through the turbulence:

```js
function pinBottom() {
  const gestures = ['wheel', 'touchstart', 'mousedown'];
  let stopped = false;
  const stop = () => { stopped = true; gestures.forEach(ev => window.removeEventListener(ev, stop)); };
  // Exit 1: a real gesture arrives — let go instantly; never fight the user for the scrollbar
  gestures.forEach(ev => window.addEventListener(ev, stop, { passive: true }));

  const t0 = performance.now();
  let calmSince = null;
  (function tick() {
    if (stopped) return;
    scrollAnchorEl = null;   // while pinned, the floor is the only position authority
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (dist > 1) {
      container.scrollTop = container.scrollHeight;
      calmSince = null;      // still collapsing — restart the calm timer
    } else if (calmSince === null) {
      calmSince = performance.now();
    }
    const now = performance.now();
    // Exit 2: layout calm for a full second (after a 5s minimum, for late-arriving images)
    // Exit 3: 15s hard cap
    if ((now - t0 > 5000 && calmSince !== null && now - calmSince > 1000) || now - t0 > 15000) { stop(); return; }
    requestAnimationFrame(tick);
  })();
}

// Pin the floor after opening; wait out the height collapse
pinBottom();
```

Of the three exit conditions, the one that matters most is the first: **let go the instant a gesture arrives**. A fixed-duration, uninterruptible pin loop fights the user for the scrollbar — they scroll up, the loop drags the viewport back to the bottom every frame, for fifteen seconds straight. Clearing `scrollAnchorEl` while pinned is the same idea: anchor correction, bottom pinning, and bottom-following are three "position authorities" that all want the wheel, and only one may hold it at a time — otherwise they tear the viewport apart. Once the pin lets go, the scroll anchor takes over drift correction naturally.

## 7 Versus virtual scrolling

Virtual scrolling (react-virtualized, TanStack Virtual, vue-virtual-scroller, …) keeps **only the visible elements in the DOM**; elements scrolled out are removed, their DOM nodes recycled for elements scrolling in. A wheel of death and rebirth.

This article keeps **every element in the DOM** — the invisible ones just aren't rendered by the browser.

| | Virtual scrolling | content-visibility |
|---|---|---|
| DOM node count | viewport + buffer | all (shells included) |
| Native Cmd+F search | broken | works |
| Scrollbar | hand-computed heights | browser-native |
| Variable heights | needs elaborate height caches | browser handles it |
| Element state | lost on scroll-out | always retained |
| Memory | low | slightly higher (negligible at hundreds) |
| Complexity | high (recycling pool to manage) | low (CSS + 3 observers) |

**Virtual scrolling fits** lists from the tens of thousands up — chat exports, log viewers — where DOM node count itself becomes the memory bottleneck.

**`content-visibility` fits** conversation windows from the hundreds to the low thousands — enough messages that naive rendering chokes, not enough that DOM nodes eat your memory. In that range, one line of CSS and a few observers buy the performance virtual scrolling needs an entire library to deliver, while keeping every native browser capability.

## 8 Checklist

1. **`content-visibility: auto` is the foundation.** It tells the browser to skip layout and paint for invisible elements while preserving the full DOM. `contain-intrinsic-size` supplies a height estimate so the scrollbar doesn't convulse between pre- and post-render.
2. **Two-tier rendering splits fast from slow.** The last few messages render in full; the rest are shell placeholders, hydrated into full messages by an `IntersectionObserver`.
3. **Images always lazy-load.** Start as a 1×1 transparent pixel; request only near the viewport.
4. **Edit/retry uses `replaceWith` on exactly one element.** Mark the new element `content-visibility: visible` to skip the birth frame; pin the floor when at the bottom, otherwise pin the new element's top edge back in place. For branch switches, see [the nonlinear companion](nonlinear-rendering.md).
5. **The scroll-correction trio:** `ResizeObserver` writes real heights back; the scroll anchor detects and corrects drift (transfer or re-pick the anchor when it gets `replaceWith`'d); `pinBottom` holds the floor right after opening (and lets go the instant a gesture arrives). The three are mutually exclusive position authorities — only one on duty at a time.
6. **Never run two render paths at once.** Opening a window reuses its previous DOM slot instead of destroying and rebuilding. Switching back to a previously opened conversation finds its slot's DOM still warm — just activate it.

---
.177...

8.1 First edition: main article + nonlinear companion + snippets.

8.1 Second-pass review: fixed TOC anchors and cross-links; added the strategy overview; anchor hand-off added to snippets; English edition. — fable5

8.1 Retired the specific second-counts from title and body (never actually measured); orders of magnitude until we instrument. — fable5

<sub>Architecture & documentation: Opus 4.6 · Second-pass review & English translation: Fable 5</sub>
