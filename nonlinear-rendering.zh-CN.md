# 非线性会话的渲染优化

[English](nonlinear-rendering.md)

树形分支对话中，用户可以在任意位置分叉、回溯、切换不同路径。每次切换分支，前端需要更新屏幕上的消息列表——但不应该重新渲染整个窗口。这篇笔记记录了分支切换时的定点DOM替换、导航器锚定、以及对话间DOM复用。

本文是[长对话的开窗优化](README.zh-CN.md)的分支篇。通用的渲染优化（`content-visibility`、分层懒加载、滚动校正）在那篇展开，这里只讲树形结构特有的部分。

> *前提*  本文假设你的对话是树形结构——每条消息是节点、每次分叉创建兄弟节点、前端沿一条从根到叶的路径渲染。具体的树怎么存（父指针、子节点数组、邻接表……）不影响这里的渲染优化——只要能提取出"当前路径"作为有序列表，下面的方法都适用。

## 目录

- [renderDiff：只替换分歧点之后](#1-renderdiff只替换分歧点之后)
- [content-visibility 的临时覆盖](#2-content-visibility-的临时覆盖)
- [导航器锚定](#3-导航器锚定)
- [编辑和重试：分支切换而非单条替换](#4-编辑和重试分支切换而非单条替换)
- [DOM Slot：对话间的DOM复用](#5-dom-slot对话间的dom复用)
- [适用边界：你的树不长这样怎么办](#6-适用边界你的树不长这样怎么办)

## 1 renderDiff：只替换分歧点之后

在树形对话中，当前屏幕上渲染的是一条从根到叶的路径。切换分支时，新路径和旧路径共享一段前缀——从根节点到分歧点。分歧点之前的消息完全相同，不需要碰它们的DOM。

```text
旧路径:  A → B → C → D → E
新路径:  A → B → C → F → G → H
                    ↑
                  分歧点
                  keep=3, 删2, 加3
```

`renderDiff` 做三件事：找到分歧点、删掉分歧点之后的旧DOM、追加新DOM。

```js
function renderDiff(oldPathIds) {
  const newPath = getPath();
  const newIds = newPath.map(n => n.id);

  // 找分歧点：逐个比较旧路径和新路径的节点ID
  let divIdx = 0;
  while (divIdx < oldPathIds.length &&
         divIdx < newIds.length &&
         oldPathIds[divIdx] === newIds[divIdx]) {
    divIdx++;
  }

  // 如果没有共享前缀，放弃diff，走全量渲染
  if (divIdx === 0) { renderAll(); return; }

  // 删掉分歧点之后的旧DOM
  const removedSet = new Set(oldPathIds.slice(divIdx));
  for (const el of container.querySelectorAll('.msg')) {
    if (removedSet.has(el.dataset.id)) el.remove();
  }

  // 追加新路径从分歧点开始的节点
  const tail = newPath.slice(divIdx);
  const frag = document.createDocumentFragment();
  tail.forEach(node => {
    frag.appendChild(node.role === 'user' ? mkUser(node) : mkAI(node));
  });
  container.appendChild(frag);
}
```

假设500条消息的对话，用户在第490条处切了一个分支。`renderDiff` 保留前489条的DOM不动，只删掉后11条并换上新的。比起全量 `renderAll`，节省了98%的工作量。

> **为什么用 Set 而不是从尾部遍历删除？** 旧路径和新路径在分歧点之后可能有不同的长度，而且DOM中可能存在懒加载的壳子。用 `Set` 按ID匹配删除比按索引倒序删除更可靠——它不依赖DOM元素的顺序和数量与路径数组一致。

## 2 content-visibility 的临时覆盖

`content-visibility: auto` 给每个未渲染的消息一个预估高度（`contain-intrinsic-size: auto 400px`）。当 `renderDiff` 追加新节点时，这个预估高度会带来两种问题：

**问题一：编辑/重试的流式尾部。**用户编辑或重试后，`renderDiff` 追加的最后一个节点是一个空壳——AI的回复还没到，内容会通过流式传输逐字填充。这个节点的初始高度接近0，但 `content-visibility: auto` 把它估算成400px。滚动到底部时，浏览器看到的是一个400px的膨胀壳；回复开始流入、真实高度逐渐增长时，400px塌缩为真实值，视口剧烈跳动。

**问题二：导航器翻页时的锚定元素。**用户在对话中间翻分支时，`renderDiff` 追加的第一个新节点是锚定目标——它的底边位置需要被精确测量来做滚动校正。如果 `content-visibility: auto` 给了它一个400px的预估高度，测量出来的位置就是错的。

解决方法：对这两种节点，临时强制 `content-visibility: visible`。

```js
tail.forEach((node, i) => {
  const el = node.role === 'user' ? mkUser(node) : mkAI(node);

  // 流式尾部 或 锚定目标：跳过400px预估，用真实高度
  if (isLiveTail || (isNavFlip && i === 0)) {
    el.style.contentVisibility = 'visible';
  }

  frag.appendChild(el);
});
```

`content-visibility: visible` 告诉浏览器立刻对这个元素做完整布局，不使用预估值。代价是这一个元素的首次渲染稍慢，但避免了后续的高度塌缩和视口跳动。

## 3 导航器锚定

树形对话的导航器（分支切换箭头 ‹ ›）位于被翻页消息的底边。用户快速连续翻页时，每次翻页都会替换DOM中的消息内容，不同分支的消息可能高度不同——如果不做锚定，每次翻页都会让整个视口上下跳动，导航器箭头跟着乱飞。

锚定的做法：在替换DOM之前，记住被翻页消息底边的屏幕坐标；替换之后，测量新消息底边的屏幕坐标；用 `scrollBy` 修正差值。

```js
// 替换前：记住旧消息底边的屏幕位置
const anchorEl = container.querySelector(`.msg[data-id="${anchorId}"]`);
const bottomBefore = anchorEl.getBoundingClientRect().bottom;

// ... 执行 renderDiff，删旧追新 ...

// 替换后：测量新消息底边，修正滚动位置
const freshEl = container.querySelector(`.msg[data-id="${newTail[0].id}"]`);
const bottomAfter = freshEl.getBoundingClientRect().bottom;
root.scrollBy({ top: bottomAfter - bottomBefore, behavior: 'instant' });
```

效果：不管新消息比旧消息高还是矮，导航器箭头在屏幕上的位置不变。高度差被吸收到视口上方——更高的消息向上生长，更矮的消息从上方收缩。用户的手指始终在同一个位置点击翻页。

> **为什么用 scrollBy 而不是 scrollTop +=？** 在移动端（尤其是iOS Safari），惯性滚动期间读取 `scrollTop` 得到的是过期值——把这个过期值加上偏移量再写回去，会把视口拽回到惯性滚动开始时的位置。`scrollBy` 是增量操作，不受这个过期值影响。

## 4 编辑和重试：分支切换而非单条替换

在线性对话中，编辑一条消息 = 替换那条消息的DOM（[swapMsgEl](README.zh-CN.md#5-定点dom替换)）。在树形对话中，编辑一条消息的语义完全不同——它在编辑位置创建了一条新分支：

```text
编辑前:  A → B → C → D → E
                    ↑ 编辑C
编辑后:  A → B → C' → (等待AI回复)
               ↗
旧分支:  A → B → C → D → E   (仍然存在，可以切回)
```

编辑C之后，C之后的所有消息（D、E）属于旧分支——它们在数据层仍然存在，但不在当前路径上了。前端需要删掉C、D、E的DOM，换上C'的DOM。这就是一次 `renderDiff`，分歧点在B。

重试也是同理。重试AI的回复E，生成E'——从E的父节点D开始分叉。前端需要删掉E的DOM，换上E'的DOM。分歧点在D。

所以树形对话中，编辑和重试的渲染路径是 `renderDiff`，不是 `swapMsgEl`。`swapMsgEl` 只负责线性对话中"一条消息变了，其余不动"的场景。

## 5 DOM Slot：对话间的DOM复用

当用户在多个对话之间来回切换时，每次切换都触发一次完整的 `renderAll` 是浪费的——用户30秒前刚离开的那个对话，它的DOM还热乎着。

解决方法：为每个打开过的对话保留一个DOM slot——一个隐藏的容器元素，里面保存着那个对话的完整消息DOM。

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
  // 1. 保存当前对话的滚动位置，隐藏它
  const prev = root.querySelector('.conv-slot.active');
  if (prev) {
    const prevSlot = convSlots.get(prev.dataset.conv);
    if (prevSlot) prevSlot.scrollTop = root.scrollTop;
    prev.classList.remove('active');
    prev.style.display = 'none';
  }

  // 2. 激活目标对话的slot（没有就新建）
  let slot = convSlots.get(convId);
  if (!slot) slot = createSlot(convId);
  slot.el.style.display = '';
  slot.el.classList.add('active');

  // 3. 恢复滚动位置
  root.scrollTop = slot.scrollTop || 0;

  return slot;
}
```

切回之前打开过的对话时，它的slot已经存在——消息DOM还在、懒加载状态还在、滚动位置还在。只需要 `display: none` → `display: ''`，不需要重新渲染。

这和 `content-visibility: auto` 形成配合：隐藏的slot中所有消息都不会被浏览器布局和绘制，不占渲染开销。只有被激活的slot中的可见消息才参与渲染。

## 6 适用边界：你的树不长这样怎么办

本文的方法看起来和树绑得很紧，其实相反——**整套逻辑不关心树，只关心屏幕上正在显示的那一条线**。renderDiff 的输入就是两串消息ID：旧路径和新路径。树只在 `getPath()` 那一步进场，选完路径就退场了。按每个机制依附的对象分层，能不能搬一目了然：

```text
单条消息级   content-visibility · 壳子水合 · 图片懒加载 · 高度写回
             → 结构无关，照搬

滚动容器级   scroll anchor · pinBottom · 导航器锚定
             → 一个滚动容器一套；没有滚动条的视图不适用

路径级       renderDiff · 共享前缀
             → 屏幕显示的是一条线就适用

数据层       树 · DAG · 图
             → 从不进场——只通过 getPath() 说话
```

### 更深、更宽的树：直接搬

分叉更多、层级更深的树一行都不用改。renderDiff 的开销只跟**路径长度**有关，跟树的形状、分叉数完全无关——每个节点分一百叉也一样，屏幕上仍然只有根到叶的一条线。

### 图和DAG：两个自查前提

分叉之后又合并、一个节点有多个父节点的图状结构，只要显示的还是一条线，也能用——但搬之前查两件事：

1. **同一条路径里节点ID不能出现两次。**`[data-id]` 查询和 `Set` 删除都拿ID当唯一键。有环、或同一节点在路径中被访问两次的图会让它们翻车——那时要换成"位置+ID"做键。
2. **renderDiff 只白捡共享前缀。**两条路径要是"开头同、中间不同、结尾又合流"（合并节点的典型形状），合流后那段会被白白删掉重建。这不影响正确性——最坏就是退化成全量渲染，反正有 `renderAll` 兜底——只是省得少。真在乎可以再加共享后缀检测，多数场景不值得。

### 同屏不止一条线：拆开搬

两条分支左右并排对比、多列平行视图、把整棵树画出来的canvas视图——这类界面不能整套照搬，但可以拆开：**单条消息级的机制全部照旧**（content-visibility、壳子、懒加载都是"每个元素"级别的，跟结构无关），每列跑一套即可；**滚动容器级的机制要重做**——它们假设一个垂直滚动容器，多列就每列各配一套锚，canvas视图用 transform 定位、跟滚动条无关，scroll anchor 和 pinBottom 整个不适用。renderDiff 的"没变的部分不动"思想在多列下变成"没变的列不动"——思想还在，代码要重写。

### 两个藏得深的假设

最后是两条容易被忽略的默认前提。**钉底假设"最新的在底部"**——聊天式界面的习惯。自上而下的文档式界面把钉底换成钉顶，思路不变。**"编辑=开新分支"（第4节）是产品决定，不是渲染逻辑的要求**——如果你的编辑是原地改、不保留旧分支，那就回到[正篇的 swapMsgEl](README.zh-CN.md#5-定点dom替换)，两套互相兼容。

一句话总结：**树越怪越没关系，屏幕越怪才有关系。**数据层随便长，只要视图层还是"一条会滚动的线"，这套方法就是通用的。

---

8.1 初版上站。

8.1 二编审查 + 英文版。—— fable5

<sub>Architecture & documentation: Opus 4.6 · 二编审查 & 英文翻译：Fable 5</sub>
