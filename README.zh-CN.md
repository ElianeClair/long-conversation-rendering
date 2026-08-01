# 长对话的开窗优化：从30秒到2秒

[English](https://github.com/ElianeClair/long-conversation-rendering#readme)

当一个AI对话窗口堆积了几百条消息时，打开它就成了一次性能灾难——浏览器要解析、布局、绘制所有DOM节点，渲染时间可以从几秒膨胀到半分钟。主流方案是虚拟滚动（Virtual Scrolling），只渲染视口内可见的元素。但虚拟滚动会杀死浏览器原生搜索（Cmd+F）、破坏滚动位置、并且在可变高度内容上极其难以调教。

这篇笔记记录了一种替代方案：所有消息都存在于DOM中，但通过 `content-visibility` + 分层懒加载 + 定点DOM替换让浏览器跳过不可见内容的渲染。从30秒降到2秒，不依赖任何库。格式为原生JS + CSS，保留浏览器全部原生能力。

> *前置条件*  本文假设你已经有一个能渲染消息列表的聊天前端——不管是用框架还是原生JS。核心思路和具体框架无关：`content-visibility` 是CSS属性，`IntersectionObserver` 是浏览器API，`DocumentFragment` 是DOM接口。你在React里做还是在原生JS里做只影响写法，不影响原理。

## 策略速览

**本文（开窗优化）**

- **content-visibility + contain-intrinsic-size** —— 一行CSS跳过视口外消息的布局和绘制，DOM完整保留（[§2](#2-一行css解决大部分问题)）
- **两层渲染** —— 尾部8条完整构建，旧消息只建3个节点的轻壳；滚近600px时由 IntersectionObserver 水合成真身（[§3](#3-两层渲染壳子和真身)）
- **图片懒加载** —— 1×1透明像素占位，进视口300px内才发请求；全文唯一需要后端搭手的一条（[§4](#4-三个-intersectionobserver)）
- **Markdown懒渲染（可选）** —— 不想引入壳子时的最小替代方案（[§4](#4-三个-intersectionobserver)）
- **定点替换** —— 编辑/重试只 `replaceWith` 一个元素；顶边钉回原位，强制 visible 免"出生帧"（[§5](#5-定点dom替换)）
- **滚动校正三件套** —— ResizeObserver 写回真实高度；scroll anchor 检测漂移并修正；pinBottom 开窗初期钉底、手势一来立刻松手（[§6](#6-滚动位置校正)）

**[非线性会话篇](nonlinear-rendering.zh-CN.md)**

- **renderDiff** —— 切分支只删换分歧点之后，共享前缀一个节点不碰
- **content-visibility 临时覆盖** —— 流式尾部和翻页锚定元素强制 visible，拿真实高度做测量
- **导航器锚定** —— 翻分支时把消息底边钉在原地，‹ › 箭头始终在手指下
- **DOM slot** —— 每个打开过的对话保留一个隐藏容器，切回时零重渲染
- **适用边界** —— 更深的树 / DAG / 多列视图各自能搬走哪几层

## 目录

1. [开窗为什么慢](#1-开窗为什么慢)
2. [一行CSS解决大部分问题](#2-一行css解决大部分问题)
3. [两层渲染：壳子和真身](#3-两层渲染壳子和真身)
4. [三个 IntersectionObserver](#4-三个-intersectionobserver)
5. [定点DOM替换](#5-定点dom替换)
6. [滚动位置校正](#6-滚动位置校正)
7. [和虚拟滚动的对比](#7-和虚拟滚动的对比)
8. [注意事项摘要](#8-注意事项摘要)

## 1 开窗为什么慢

一条消息的DOM结构通常包含：头像、用户名、时间戳、消息正文（可能包含Markdown渲染后的HTML）、图片、代码块、分支导航箭头。一条消息的DOM子节点数量在10到50之间。当对话窗口有500条消息时，DOM节点总数在5000到25000之间。

浏览器渲染这些节点分三步：

```text
Parse      构建DOM树和CSSOM树
Layout     计算每个节点的尺寸和位置
Paint      把像素画到屏幕上
```

三步全部作用于所有节点——包括那些远在视口之外、用户根本看不见的。对于一个500条消息的窗口，浏览器在打开的瞬间尝试对两万多个节点做一次完整的布局和绘制。**用户等了30秒，但只看到最底下的几条消息。**上面那499条的布局和绘制全是浪费。

解决思路很直觉——既然用户只看得见底部，就只渲染底部。问题是怎么做。

## 2 一行CSS解决大部分问题

`content-visibility: auto` 是一个CSS属性，它告诉浏览器：如果这个元素不在视口附近，跳过它的布局和绘制。元素仍然存在于DOM中——可以被 `Cmd+F` 搜到、被JavaScript访问——但浏览器不花时间计算它的样式和位置。

```css
.msg {
  content-visibility: auto;
  contain-intrinsic-size: auto 400px;
}
```

两行。第一行开启按需渲染。第二行给浏览器一个高度估算值——在元素还没被真正布局之前，浏览器用 `400px` 作为它的预估高度来计算滚动条。`auto` 关键字的含义是：如果浏览器之前已经渲染过这个元素并记住了它的真实高度，就用真实值；否则用 `400px`。

这行CSS解决了大部分渲染性能问题。500条消息的窗口，浏览器只对视口附近的十几条做完整布局和绘制，其余的全部跳过。打开窗口的时间从30秒降到3秒左右。

> **为什么不是虚拟滚动？** `content-visibility: auto` 和虚拟滚动解决的是同一个问题（不渲染不可见的内容），但实现方式完全不同。虚拟滚动从DOM中删除不可见元素然后回收利用；`content-visibility` 把元素留在DOM中只是告诉浏览器别画。前者是删除，后者是隐身。隐身保留了所有浏览器原生能力——搜索、滚动条、选中文字、无障碍访问。

## 3 两层渲染：壳子和真身

`content-visibility` 跳过了布局和绘制，但没有跳过DOM构建。500条消息的完整DOM仍然需要被创建——包括Markdown转HTML、代码块语法高亮、图片标签——即使它们不会被画出来。这个DOM构建过程本身就需要时间。

解决方法：把消息分成两层。

```text
                        ┌─────────────────────┐
    500条消息的路径      │  前492条  →  壳子    │  mkLazyMsg()
                        │  后8条    →  真身    │  mkUser() / mkAI()
                        └─────────────────────┘
```

**真身**：最后8条消息（用户当前正在看的部分），使用完整的消息构建函数渲染——Markdown解析、代码高亮、图片、所有交互元素。这8条立刻可见可用。

**壳子**：前面所有旧消息，只构建一个极轻的占位符。一个 `<div class="msg">` 里面放一个100字的纯文本预览，30%透明度。不做Markdown渲染、不构建交互元素、不请求图片。占位符的DOM节点数从30+降到3个。

```js
function mkLazyMsg(node) {
  const el = document.createElement('div');
  el.className = 'msg msg-lazy';
  el.dataset.id = node.id;

  // 只放一段纯文本预览，不做任何渲染
  const preview = (node.content || '').slice(0, 100);
  el.innerHTML = `<div class="msg-preview" style="opacity:0.3">${escapeHtml(preview)}</div>`;

  // 把完整数据存在Map里，等滚到附近再构建
  lazyMsgData.set(node.id, node);
  lazyMsgHydrator.observe(el);   // 交给 Observer 1 盯着（第4节）——漏掉这行，壳子永远不会水合

  return el;
}
```

开窗时的渲染流程：

```js
function renderAll(pathNodes) {
  const TAIL = 8;
  const tail = pathNodes.slice(-TAIL);
  const older = pathNodes.slice(0, -TAIL);

  // 1. 先渲染尾部真身，用 DocumentFragment 批量插入
  const frag = document.createDocumentFragment();
  for (const node of tail) {
    frag.appendChild(node.role === 'user' ? mkUser(node) : mkAI(node));
  }
  container.appendChild(frag);
  container.scrollTop = container.scrollHeight;

  // 2. 再渲染旧消息的壳子，prepend 到顶部
  const fragOlder = document.createDocumentFragment();
  for (const node of older) {
    fragOlder.appendChild(mkLazyMsg(node));
  }
  const scrollBefore = container.scrollHeight;
  container.prepend(fragOlder);
  // 补偿滚动位置——prepend 改变了滚动高度
  container.scrollBy(0, container.scrollHeight - scrollBefore);
}
```

先插尾部、再 prepend 旧消息，是为了让用户先看到最新内容。旧消息的壳子插入后不会触发可见区域的重绘（因为它们都在视口上方），加上 `content-visibility: auto`，浏览器也不会对它们做布局。

> **为什么是8条？** 视口通常能容纳5到10条消息。8条保证了最下面的可见区域被完整覆盖。这个数字取决于你的消息平均高度和视口尺寸——太少会在底部露出壳子，太多会增加初始渲染时间。

## 4 三个 IntersectionObserver

壳子不能永远是壳子。用户往上滚的时候，那些30%透明度的文字预览应该被替换成完整的消息。这件事交给 `IntersectionObserver`——浏览器原生的"元素进入视口"检测器。

### Observer 1：消息水合

当壳子元素进入视口附近600px范围时，把它替换成完整渲染的真身。

```js
const lazyMsgHydrator = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    const id = el.dataset.id;
    const node = lazyMsgData.get(id);
    if (!node) continue;

    // 构建完整消息DOM
    const full = node.role === 'user' ? mkUser(node) : mkAI(node);
    el.replaceWith(full);          // 一次性替换
    lazyMsgData.delete(id);    // 释放数据引用
    lazyMsgHydrator.unobserve(el); // 不再观察
  }
}, { rootMargin: '600px 0px' });
```

`rootMargin: '600px 0px'` 让触发范围扩大到视口上下各600px。用户在滚动到某条消息之前的一屏距离，它就已经被水合完了。用户不会看到壳子替换成真身的闪烁。

### Observer 2：Markdown懒渲染

Markdown转HTML是有成本的——包含代码块的长消息的解析时间不可忽略。对于已经水合的消息，它的正文部分可以先放原始文本，等进入视口再做Markdown渲染。

```js
const lazyObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    el.innerHTML = md(el.dataset.lazyMd);   // 此时才解析Markdown
    delete el.dataset.lazyMd;
    lazyObserver.unobserve(el);
  }
}, { rootMargin: '600px 0px' });
```

> **这一层是可选的。**它诞生在两层渲染（第3节）之前——当年所有消息都完整构建，Markdown解析是首屏最大的开销之一，把它推迟到进视口才做很划算。有了壳子之后，旧消息的Markdown解析本来就发生在水合那一刻（进入视口附近600px时），这一层没有独立的活儿可干了——本文的原型实现后来退役了它。做了两层渲染就可以跳过这层；只想最小改动、不想引入壳子的话，单独用它也能省下一大块首屏解析时间。

### Observer 3：图片懒加载

对话中的图片不应该在开窗时一起加载——一个窗口里可能有几十张图片，每张都是一个HTTP请求。图片的 `src` 先设成1×1透明像素，进入视口附近300px时再设成真实URL。

```js
const lazyImgObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src = img.dataset.lazySrc;   // 此时才请求图片
    lazyImgObserver.unobserve(img);
  }
}, { rootMargin: '300px 0px' });
```

三个Observer各自独立，职责不重叠：

```text
Observer 1  rootMargin 600px   壳子 → 真身
Observer 2  rootMargin 600px   原始文本 → Markdown HTML（可选）
Observer 3  rootMargin 300px   透明像素 → 真实图片
```

图片Observer的rootMargin比消息Observer小，因为图片加载涉及网络请求，太早触发会浪费带宽；但300px通常足够在用户滚到图片位置之前完成加载。

> **这一条需要后端搭一半手。**本文其余策略都是纯前端，唯独图片懒加载有个前提：得先有"真实URL"可设。如果你的图片本来就是URL（对象存储、静态文件），前端部分就够了。但如果图片是以base64内联在会话数据里的，光换占位符没用——几MB的图片字节仍然跟着开窗请求下载，省掉的只有解码和绘制。要吃到全部收益，后端要做**载荷瘦身**：会话接口把图片块替换成轻存根（块索引+媒体类型，不带数据），另开一个按块取图的端点，前端滚近时才请求。配套一道守卫：若客户端保存时会把整条消息数组回传，落盘前必须用磁盘上的正本还原存根——否则存根会覆盖真数据。

## 5 定点DOM替换

开窗渲染只发生一次。之后的交互——编辑消息、重试AI回复——不应该重新渲染整个窗口。

> 如果你的对话支持树形分支，切换分支时还需要一个 `renderDiff`——找到新旧路径的分歧点，只替换分歧点之后的DOM。这部分的渲染优化在[非线性会话的渲染优化](nonlinear-rendering.zh-CN.md)中展开。

### swapMsgEl：单条替换

编辑或重试时，只有一条消息变了。找到那条消息的DOM元素，构建新的，`replaceWith`。补偿滚动时钉的是**新元素的顶边**，不是高度差——用户正看着这条消息，要保住的是它此刻在屏幕上的位置；按高度差补偿，消息还在视口里时反而会把正在看的内容推走。

```js
function swapMsgEl(node) {
  const stale = container.querySelector(`[data-id="${node.id}"]`);
  if (!stale) return;

  const fresh = node.role === 'user' ? mkUser(node) : mkAI(node);
  // 出生即在视口内——跳过 content-visibility 的400px"出生帧"
  fresh.style.contentVisibility = 'visible';

  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  const topBefore = stale.getBoundingClientRect().top;
  stale.replaceWith(fresh);

  if (nearBottom) {
    // 正贴底跟读——替换后直接钉回底部（塌缩没完时交给 pinBottom，见第6节）
    container.scrollTop = container.scrollHeight;
  } else {
    // 在中间阅读——把新元素的顶边钉回原位，视口纹丝不动
    container.scrollBy(0, fresh.getBoundingClientRect().top - topBefore);
  }
}
```

两个容易踩的坑。**出生帧**：新建的元素带着 `content-visibility: auto` 和400px的估算高度进入DOM，浏览器要到下一帧才判定它"在视口内"，这一帧里它以估算高度参与布局，肉眼可见地跳一下。既然已知它出生就在视口里，直接标 `visible` 跳过判定。**视口上方的替换**：如果被替换的消息在视口上方，它的顶边没动，但高度变化会把下面的内容整体推移——这类漂移不归 `swapMsgEl` 管，交给第6节的 scroll anchor 修正。两套机制各管一段，拼起来才是完整的"不跳"。

> **为什么不用虚拟DOM diffing？** 虚拟DOM（React等框架的做法）通过比较新旧虚拟树来最小化真实DOM操作。但对于消息列表这种场景，我们已经知道哪条消息变了——不需要diffing算法来"发现"变化。直接 `replaceWith` 比任何diffing都快，因为它跳过了比较步骤。

## 6 滚动位置校正

`content-visibility: auto` 有一个副作用：当浏览器对一个之前没渲染过的元素做首次布局时，元素的真实高度几乎一定和预估的 `400px` 不同。高度变化会导致滚动位置跳动——用户正在看的那条消息突然上移或下移了几十像素。

解决这个问题需要三个零件：

### ResizeObserver：把真实高度写回去

```js
const msgHeightObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    const el = entry.target;
    const h = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
    if (h > 0) el.style.containIntrinsicSize = `auto ${h}px`;
  }
});
```

每当一条消息被渲染并计算出真实高度后，`ResizeObserver` 把那个高度写回 `contain-intrinsic-size`。下次这条消息离开视口，浏览器跳过它的布局时，用的就是真实高度而非 `400px` 的猜测。`h > 0` 的守卫防止隐藏中或刚脱离文档的元素把 `0` 写进估算值。

### Scroll Anchor：检测并修正漂移

```js
let scrollAnchorEl = null;
let scrollAnchorOff = 0;

function updateScrollAnchor() {
  // 贴底跟读时不设锚——那时底部才是位置权威
  if (atBottom()) { scrollAnchorEl = null; return; }
  // 记住视口顶部第一条可见消息，和它相对滚动位置的偏移
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

// ResizeObserver 回调中修正漂移
if (scrollAnchorEl && !scrollAnchorEl.isConnected) {
  // 锚点消息刚被 replaceWith 换掉——脱离文档的节点 offsetTop 读出来是0，
  // 照着它算漂移会把视口甩出几千像素。重新从活DOM里选锚。
  updateScrollAnchor();
}
if (scrollAnchorEl && !atBottom()) {
  const drift = (scrollAnchorEl.offsetTop - container.scrollTop) - scrollAnchorOff;
  if (Math.abs(drift) > 1) container.scrollBy(0, drift);
}
```

偏移量用 `offsetTop - scrollTop`（相对滚动容器）而不是 `getBoundingClientRect().top`（相对视口）——软键盘弹起、页面级布局变化会移动容器本身，前者不受牵连。锚选视口顶部第一条可见消息而非中央：修正的目标是"正在读的那行不动"，读的起点在视口上沿。

> *锚点会被 replaceWith 杀死*  本文有多处 `replaceWith`：壳子水合（第4节）、定点替换（第5节）。哪一次换掉的恰好是锚点消息，锚就指向了一个脱离文档的死节点。两道保险都要上：替换的地方顺手把锚转移到新元素（在 Observer 1 和 `swapMsgEl` 里加一句 `if (scrollAnchorEl === el) scrollAnchorEl = full;`），修正漂移前再用 `isConnected` 兜底重选。漏掉这层，水合一条旧消息就可能把视口甩飞——这是锚点方案最隐蔽的坑。

### pinBottom：开窗后钉住底部

开窗的前几秒，大量壳子被水合、`content-visibility` 的预估高度被修正，滚动高度在持续变化。一个 `requestAnimationFrame` 循环在这段时间内持续把视口钉在底部：

```js
function pinBottom() {
  const gestures = ['wheel', 'touchstart', 'mousedown'];
  let stopped = false;
  const stop = () => { stopped = true; gestures.forEach(ev => window.removeEventListener(ev, stop)); };
  // 退出条件一：真实手势一来，立刻松手——绝不和用户抢滚动条
  gestures.forEach(ev => window.addEventListener(ev, stop, { passive: true }));

  const t0 = performance.now();
  let calmSince = null;
  (function tick() {
    if (stopped) return;
    scrollAnchorEl = null;   // 钉底期间，底部是唯一的位置权威
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (dist > 1) {
      container.scrollTop = container.scrollHeight;
      calmSince = null;      // 还在塌缩，重新计时
    } else if (calmSince === null) {
      calmSince = performance.now();
    }
    const now = performance.now();
    // 退出条件二：布局静止满1秒（至少钉5秒，等晚到的图片）
    // 退出条件三：15秒硬上限兜底
    if ((now - t0 > 5000 && calmSince !== null && now - calmSince > 1000) || now - t0 > 15000) { stop(); return; }
    requestAnimationFrame(tick);
  })();
}

// 开窗后钉住底部，等高度塌缩稳定
pinBottom();
```

三个退出条件里最重要的是第一个：**手势一来立刻松手**。固定时长、不可打断的钉底循环会和用户抢滚动条——用户往上滚，循环每帧把视口拽回底部，一抢就是十几秒。钉底期间清空 `scrollAnchorEl` 也是同一件事：锚点修正、钉底、贴底跟读是三个都想说了算的"位置权威"，同一时刻只能有一个在岗，否则它们互相拉扯视口。松手之后，scroll anchor 机制自然接管漂移校正。

## 7 和虚拟滚动的对比

虚拟滚动（react-virtualized、tanstack virtual、vue-virtual-scroller 等）的做法是**只在DOM中保留视口内可见的元素**，滚出视口的元素被从DOM中移除、它们的DOM节点被回收给新进入视口的元素使用。一套生死轮回。

本文的做法是**所有元素都在DOM中**，只是不可见的不被浏览器渲染。

| | 虚拟滚动 | content-visibility |
|---|---|---|
| DOM节点数 | 视口内 + 缓冲区 | 全部（含壳子） |
| Cmd+F 原生搜索 | 不可用 | 可用 |
| 滚动条 | 人工计算高度 | 浏览器原生 |
| 可变高度支持 | 需要复杂的高度缓存 | 浏览器自动处理 |
| 元素状态保留 | 滚出即丢失 | 始终保留 |
| 内存占用 | 低 | 略高（百条级别可忽略） |
| 复杂度 | 高（需要管理回收池） | 低（CSS + 3个Observer） |

**虚拟滚动更适合**万级以上的超长列表——聊天记录导出、日志查看器——DOM节点数量本身成为内存瓶颈的场景。

**`content-visibility` 更适合**百级到千级的对话窗口——消息数量大到裸渲染卡死，但没大到DOM节点本身吃光内存。在这个区间里，它用一行CSS和几个Observer就拿到了虚拟滚动需要一个库才能实现的性能，同时保留了所有浏览器原生能力。

## 8 注意事项摘要

1. **`content-visibility: auto` 是基础。**它告诉浏览器跳过不可见元素的布局和绘制，保留DOM的完整性。`contain-intrinsic-size` 给浏览器一个高度估算，避免滚动条在渲染前后剧烈跳动。
2. **两层渲染拆快慢。**尾部几条完整渲染，其余用壳子占位。壳子被 `IntersectionObserver` 水合成真身。
3. **图片永远懒加载。**初始为1×1透明像素，进入视口附近才请求。
4. **编辑/重试用 `replaceWith`，只替换那一个元素。**新元素标 `content-visibility: visible` 免出生帧；贴底时钉底，其余时候把新元素的顶边钉回原位。分支切换的定点替换见[非线性会话篇](nonlinear-rendering.zh-CN.md)。
5. **滚动位置校正三件套：**`ResizeObserver` 写回真实高度、scroll anchor 检测漂移并修正（锚点被 `replaceWith` 换掉时要转移或重选）、`pinBottom` 在开窗初期钉住底部（手势一来立刻松手）。三者是互斥的位置权威，同一时刻只能有一个在岗。
6. **不要同时开两个渲染路径。**打开新窗口时，复用之前的DOM slot，不要销毁再重建。切回一个之前打开过的对话时，那个slot的DOM还在，直接激活。

---
.177...

8.1 初版上站：正篇 + 非线性篇 + snippets。

8.1 二编审查：修目录锚点与跨篇断链；策略速览入 README；snippets 补锚点转移；英文版上线。—— fable5

<sub>Architecture & documentation: Opus 4.6 · 二编审查 & 英文翻译：Fable 5</sub>
