# Hermes Turn Indicator

Hermes 桌面端（Electron）单文件插件：在输入框上方常驻一行"本轮在干什么"的指示器，并把对话里的工具行从视图里去掉，只留对话本身。

不改 Hermes 核心代码，全部通过 `@hermes/plugin-sdk` 的 `ctx.register` + 一条 `<style>` 实现，禁用插件即完全恢复原状。

## 效果

| 元素 | 行为 |
|---|---|
| 内联读数（`composer.top`，输入框正上方、卡片内一行） | 方块（常亮，不闪）+ 实时文案 + 秒数，整行宽度；**整轮全程挂载**，回合真的结束（网关与工具都静默）后约 3s 才收起；空闲时不渲染。**可在设置里整体关掉** |
| 文案 | 跟随真实动作：`思考中` / `编辑 plugin.js` / `执行命令` / `读取 a.md` / `搜索代码` / `查阅资料` / `生成回复` / `整理上下文` … |
| 工具行 | 整段对话里一律不显示（含本轮运行中）：运行中的进度只由输入框上方那行承担，历史里也不留 |
| 气泡下方的状态行（核心的 `aui_turn-activity`） | 默认**整行隐藏**：脉冲方块 + hint + 秒数。上方那行已经是同一件事的重述，而且这行是 `aria-live` 的，留着它屏幕阅读器会每秒念一次。**可在设置里关掉**（关掉即恢复核心原状） |
| 气泡下方的进度方块（仅在上一项关掉时） | 工具行隐藏后，核心那行本该在"工具正在跑"和"进展间隔 <2s"时消失（核心假设工具行自己在报进度）。插件改为在这两个窗口里补同一个方块（气泡下方、原位置），回合结束即撤 |
| 气泡呼吸光 | 本轮你发的那口气泡（`.composer-human-message`）外沿呼吸光，只在回合进行中亮，回合结束后 ~3s 收起；**只作用于气泡本身**，不碰助手侧正文块、不碰周围组件 |
| `::turn{}` 内联指令 | 模型在回复里写 `::turn{}`（或 `::turn{text="…"}`），该段在**流式期间**渲染成小胶囊，本轮结束即消失 |
| 收尾卡「N 个文件已更改」 | 保持显示，不受影响 |
| 审批卡 | 保持显示，必须由用户处理 |

## 安装

三种方式，插件是**纯前端 ESM**，无需构建。

**A. 从 GitHub 装**

```bash
hermes plugins install chengyimingvb/HermesPlugins/turn-indicator
```

装完在桌面端 Settings → Plugins 里打开这个插件（带 `.hermes-package.json` 标记的 desktop 半边是 opt-in）。

**B. 手动拷贝**

```bash
# Windows 默认（本机）
copy desktop/plugin.js "%LOCALAPPDATA%\hermes\desktop-plugins\turn-indicator\plugin.js"

# 或 $HERMES_HOME 下
mkdir -p "$HERMES_HOME/desktop-plugins/turn-indicator"
cp desktop/plugin.js "$HERMES_HOME/desktop-plugins/turn-indicator/plugin.js"
```

**C. 开发同步（改完仓库即生效，本机正在用）**

```bash
cd D:\GitWork\HermesPlugins
node tools/sync-desktop-plugins.mjs turn-indicator          # 同步一次，应用随即热重载
node tools/sync-desktop-plugins.mjs --watch turn-indicator  # 保存即同步（Ctrl-C 退出）
```

把 `<id>/desktop/` 同步到 `$HERMES_HOME/desktop-plugins/<id>/`，只改写有差异的文件；应用监听那份拷贝，保存即 `register()` 重跑，不用 Reload、不用重启。

### B / C 装好后怎么确认它在跑（实测）

- 新文件夹**无需手动 Reload**：应用对 `desktop-plugins/` 根目录挂了 fs watch，新目录出现即自动 reconcile 并加载。
- 无 `.hermes-package.json` 的目录被当作独立插件，**默认启用**（有标记的才是 opt-in），不用去 Settings ▸ Plugins 打开。
- 目录结构必须保持 `<root>/<id>/plugin.js`，且 `id` 等于文件夹名。
- 实测证据：探针记录 `rows=44 hidden=44`（工具行全隐藏）、指示器节点 `1/3` 有布局且文案 `调用 computer_use 14s` 在走秒。

## 设置

**Settings ▸ Plugins ▸ Turn indicator**（`ctx.registerSettingsPage` + `ctx.storage`，按 profile 保存，保存后立即生效）：

| 参数 | 默认 | 范围 | 作用 |
|---|---|---|---|
| 显示输入框上方的状态行 | 开 | 开关 | 关掉后那行完全不渲染（注册仍在，热重载不丢）；工具行/气泡光各自独立，不受影响 |
| 隐藏对话里的工具行 | 开 | 开关 | 关掉后工具行照常显示（核心行为） |
| 隐藏气泡下方的状态行 | 开 | 开关 | 关掉后恢复核心那行（脉冲方块 + hint + 秒数），插件也重新补 idle 窗口的方块；不影响上方那行 |
| 本轮气泡的边缘呼吸光 | 开 | 开关 | 关掉后完全不碰气泡样式 |
| 呼吸单程时长 | 1200 ms | 400–4000 | 一次亮→暗的时间，来回 = ×2 |
| 呼吸强度 | 55 % | 5–100 | 峰值亮度（暗端自动取 1/3） |
| 回合结束后收起延迟 | 3000 ms | 500–20000 | 回合真正结束后那行还留多久 |
| `::turn{}` 内联胶囊 | 开 | 开关 | 关掉后内联指令不渲染 |

规矩：**读**走的是一套强制转换（非布尔不当真、数字解析不出用默认、越界夹到边界），**写**在入口再夹一次，
所以手改过或写了一半的记录不会把行弄坏；设置页用本地草稿，点保存才落盘（每键一写会把半截数字推进活规则里）。

## 卸载

`hermes plugins remove turn-indicator`；或删掉 `desktop-plugins/turn-indicator/` 目录；或 Settings → Plugins 里禁用。

## 实现要点

- **挂载点**：`area: 'composer.top'` —— 输入卡片内、文本框正上方的一整行，外层 `empty:hidden`，空闲返回 `null` 不留空。
- **注意**：SDK 运行时**没有**导出区域常量（`PANES_AREA`、`COMPOSER_AREAS` 都会抛 `ReferenceError: X is not defined`，构建后的 barrel 比源码窄），所以 area id 一律写字面量。
- **样式**：`width: 100%` + `11px` + `white-space: nowrap`，无边框无底色，读起来像输入框的一部分。
- **方块常亮不闪**：不做透明度脉冲 —— 0.28→1 的呼吸在深色底上读起来就是「一会显示一会隐藏」。回合内的"活着"由实时文案与秒数承担，`::turn{}` 胶囊同理。
- **回合闩（不闪，也不中途消失）**：挂载条件不是网关的 `busy` —— 那个标志在两次工具调用之间、长工具执行中、以及一条消息结束时都会掉，而且 `busy` **跟随 tile 焦点**，点一下别的面板就掉；每次掉都把整行卸掉，就是"它会消失一会儿"。现在的门是：`busy || awaitingResponse（发出到首个 token） || 聚焦会话自己 mid-turn || 聚焦会话有工具在飞`，并且**每次复核都把这当成一次活信号刷新时钟**（否则回合里一段长时间的静默会让窗口从"最后一个事件"起算，`busy` 一抖就关）；只有全部静默超过 `settleMs`(3000ms) 才收起，`message.complete` 只清文案。**只认聚焦会话**（0.6.0 改）：`composer.top` 是一个面板的那行，后台 bot / Kanban 任务或另一个 tile 的回合不再点亮你正在打字的这条。`node tools/test-plugins.mjs` 用假时钟跑这套状态机的断言。
- **没有任何轮询**（0.6.0 改）：闭合窗口是**一次 deadline timer**（`armClose`/`close`，每 `settleMs` 醒一次），标签重贴由 `MutationObserver`（`childList`+`subtree`，200ms 去抖）驱动 —— 旧版每条 400ms tick 要跑 4~6 次全文档 `querySelectorAll` 加 2 次 `getClientRects()`（强制布局），整轮不停。
- **"有工具在飞"按会话记账，且不过 `isMine` 过滤**（0.5.2 修）：原先是单个全局计数，而 `tool.complete` 又要过"只认聚焦会话"的过滤 —— 在 A 会话发起工具、切到 B 再让它完成，complete 被丢掉，计数永久 >0，行与呼吸光再也不收起。现在 `pendingBySession` 按 `session_id` 累加/递减（负数夹到 0），只有**文案**跟随焦点；`close()` 真正收起时整表清零，兜住网关断连丢事件的情况。
- **复位只在上升沿**（0.6.0 修）：状态订阅原先每次都 `resetPending(聚焦会话) + setActivity('')`，而 `$busyBySession` 是 computed，`$sessionStates` 每写一次就换一个新对象（token 用量、心跳、工具活动），于是"在飞工具"计数每秒被清零、跑着工具的文案被打回`思考中`。现在只记 `wasFocusedBusy`，真正的 `not busy → busy` 边沿才清。测试门里有回归断言（把无条件复位放回去 2 条 FAIL）。
- **文案来源**：`ctx.onEvent` 订阅 `tool.start` / `tool.complete` / `tool.generating` / `message.delta` / `thinking.delta` / `status.update` / `message.complete`，按 `event.session_id` 只认聚焦会话（**工具计数除外**，见上），丢弃 `replayed` 帧；`message.complete` 同样受这两道过滤（别人的回合结束不该清掉本轮的文案）。
- **去抖**：`message.delta` 约 30 次/秒 —— SDK 的 `atom` 就是 nanostores 的那个，`set` 对同值已经直接返回（实测：同值 set 不通知），手动去重是多余的，已删。
- **样式清理**：`<style>` 不是 contribution，用 `ctx.onDispose` 挂掉，禁用/重载时移除。**不要再用 owner 守卫**：`runtime-loader` 每次加载都用新的 blob URL 重新求值模块，且**先 dispose 旧实例再 register 新实例**（`unloadRuntimePlugin` → `activate`），模块级 atom 不可能被上一个实例影响。
- **一个样式元素承担两件事**（隐藏工具行 + 气泡呼吸光）：元素 id `turn-indicator-hide-changes` **故意不改名** —— 已装版本的元素就是这个 id，改名会把旧元素留在文档里继续用旧规则；保留同一个 id、每次 `register()` 重写 `textContent` 才是稳的。
- **重贴是事件驱动的**：`MutationObserver` 看到转录挂新节点（助手分段 / 工具行是随回合推进挂载的）才重贴，且**只写差值**：给已带属性的节点重新写属性会重启它的 CSS 动画，呼吸就会顿。
- **`removeAttribute` 收的是属性名，不是选择器**（0.5.1 修）：写成 `el.removeAttribute('[data-turn-glow]')` 浏览器**不抛错**（实测 `no-throw`，属性仍在），等于什么都没删 —— 每个结束回合的气泡于是永久呼吸。同理 `paintGlow()` 必须同时看 `$turn`：它在**每次保存设置**和 `register()` 时都会跑，那一刻"最新回合"已是历史，贴上标签后没有任何 settle 链会来清。两条都在 `tools/test-plugins.mjs` 里有回归断言（把 bug 放回去 4 条全部 FAIL）。
- **只亮气泡**：助手消息没有气泡外形（正文块是全宽、`border-radius: 0`），给它套光圈只能自己造一个圆角矩形包住整列正文 —— 那看起来就是"光跑到气泡周围的组件上"，所以只对 `.composer-human-message` 生效。
- **只用内联样式**：插件的类名不进 Tailwind 构建，用 `var(--ui-*)` 主题变量。
- **无障碍**（0.6.0 修）：状态行是 `role="status"`（隐式 `aria-live="polite"`），秒数那个 span 必须带 `aria-hidden` —— 否则读数每秒变一次，读屏会每秒把整行播报一遍。`::turn{}` 胶囊同理。
- **工具行的显隐**：一条规则 `[data-slot="tool-block"] { display: none !important }`，对话里的工具行全时段
  不显示（运行中也不显示）；在跑什么由上方的内联读数承担。审批卡是另一个 slot，不受影响。
- **隐藏工具行会让核心的进度方块消失**（0.5.3 修）：核心 `status.tsx` 的 `active` 判据里有一条 `!toolNarrating` —— 只要尾部有一条未结束的工具调用就成立（`turn-activity.ts:77`），另加 `TURN_QUIET_S` 2 秒静默门槛。这两条在工具行可见时是对的（工具行自带计时器，不重复报），但本插件把工具行全藏了，于是这两段成了完全空白。修法是给回合进行中最新的 `[data-slot="aui_turn-activity"]` 打 `data-ti-live`，CSS 只在 `data-state="idle"` 时解除 `sr-only` 并用 `::before` 画同一个 dither 方块（12px、`repeating-conic-gradient`、继承 `currentColor`）；`active` 时仍用核心的真节点（带秒数），不会双份。开关跟随「隐藏对话里的工具行」：不藏工具行就不补。**0.6.0 修正**：Tailwind v4 的 `.sr-only` 是 `clip-path: inset(50%)`（根本没有 `clip`），旧规则只复位 `clip`，于是行虽然 `position:static`、量到 `753x12`，但整块仍被裁空 —— 补的方块其实一点没画。现在多了 `clip-path: none`。验证方式：把核心与插件的原文规则放进一个页面跑，取 `getComputedStyle` 与中心点 `elementFromPoint`（未修：`inset(50%)` + 命中 BODY；修后 `none` + 命中自身），测试门也有断言。活窗边界不变：回合最开头、核心行还没 mount（无产出、无工具）的那 2 秒仍无方块 —— 那时 DOM 里没有节点，插件无从补。**0.6 起整行可关**（`hideActivityRow`，默认开）：一条 `[data-slot="aui_turn-activity"] { display: none !important }`，`paintActivity` 同时短路不再打 `ti-live`（补一个看不见的节点是白费），关掉这项就回到上面描述的行为。用 `display:none` 而不是视觉隐藏：这行是 `aria-live`，秒数每秒变，留着它屏幕阅读器会每秒念一遍。

## 已知边界

- 只影响桌面端；CLI 与消息平台的工具进度由 `display.tool_progress` 控制，与本插件无关。
- 隐藏是视觉层（`display:none`），DOM 仍渲染；要从渲染层彻底去掉需改核心的 `message-parts.tsx`。
- 收尾卡只在"最新一条消息且该轮已结束"时存在（核心 `assistant-message.tsx` 的 `SettledChangedFiles`），发下一条消息它就退休 —— 这是核心行为，插件不改。
- `hermes plugins validate ./turn-indicator` 现在报 **✗ `desktop surface — app DOM reach`**（catalog rule 8）：气泡呼吸光必须在 JS 里 `document.querySelector` 找到"最新回合对"才能只给本轮贴标记。合并前只有样式表里的核心选择器（⚠）；合并后带回 JS 触达，就成了硬失败。走官方 catalog 前需要 SDK 正路（或给核心提一个"回合装饰"钩子）。
- 窗口里多个已布局 transcript 会一起亮（实测 `tagged=3`）：除聚焦会话外，其它面板的最后一轮也会发光。要收窄到"只有我正在看的那个"，需要按布局盒与视口相交来筛。

## 目录

```
plugin.yaml        # 插件清单（name / version / requires_hermes）
desktop/plugin.js  # 全部逻辑（单文件 ESM）
README.md          # 本文件
```

## 兼容性

- Hermes 0.22.7 桌面端（打包版）实测。
- SDK 面：`atom` / `useValue` / `host.state` / `ctx.register` / `ctx.onEvent` / `ctx.onDispose`。
