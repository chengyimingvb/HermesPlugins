# Hermes Turn Indicator

Hermes 桌面端（Electron）单文件插件：在输入框上方常驻一行"本轮在干什么"的指示器，并把对话里的工具行从视图里去掉，只留对话本身。

不改 Hermes 核心代码，全部通过 `@hermes/plugin-sdk` 的 `ctx.register` + 一条 `<style>` 实现，禁用插件即完全恢复原状。

## 效果

| 元素 | 行为 |
|---|---|
| 输入框上方一行 | 像素方块 + 实时文案 + 秒数，整轮对话期间常显，空闲时整行不渲染 |
| 文案 | 跟随真实动作：`思考中` / `编辑 plugin.js` / `执行命令` / `读取 a.md` / `搜索代码` / `查阅资料` / `生成回复` / `整理上下文` … |
| 工具行 | 全部隐藏（`[data-slot="tool-block"]`），含 `+N −N` 编辑行与运行中进度 |
| 收尾卡「N 个文件已更改」 | 保持显示，不受影响 |
| 审批卡 | 保持显示，必须由用户处理 |

## 安装

插件是**纯前端 ESM**，无需构建：

```bash
# Windows 默认（本机）
copy plugin.js "%LOCALAPPDATA%\hermes\desktop-plugins\turn-indicator\plugin.js"

# 或 $HERMES_HOME 下
mkdir -p "$HERMES_HOME/desktop-plugins/turn-indicator"
cp plugin.js "$HERMES_HOME/desktop-plugins/turn-indicator/plugin.js"
```

文件夹名必须等于插件 `id`（`turn-indicator`）。放好后在应用里按 `⌘K` → **Reload desktop plugins**；首次是全新文件夹，热重载不保证自动发现。

保存 `plugin.js` 即热重载，无需重启。

## 卸载

删掉 `desktop-plugins/turn-indicator/` 目录，或 Settings → Plugins 里禁用。

## 实现要点

- **挂载点**：`COMPOSER_AREAS.top`（输入卡片内、输入框正上方）。空闲时组件返回 `null`，外层 `empty:hidden` 塌陷，不留空隙。
- **动画**：Web Animations API（`element.animate` + `iterations: Infinity`），插件没有自己的样式表；尊重 `prefers-reduced-motion`。
- **文案来源**：`ctx.onEvent` 订阅 `tool.start` / `tool.complete` / `tool.generating` / `message.delta` / `thinking.delta` / `status.update` / `message.complete`，按 `event.session_id` 只认聚焦会话，丢弃 `replayed` 帧。
- **去抖**：`message.delta` 约 30 次/秒，同值不 set（nanostores 同值 set 也会通知）。
- **样式清理**：`<style>` 不是 contribution，用 `ctx.onDispose` 挂掉，禁用/重载时移除。
- **只用内联样式**：插件的类名不进 Tailwind 构建，用 `var(--ui-*)` 主题变量。

## 已知边界

- 只影响桌面端；CLI 与消息平台的工具进度由 `display.tool_progress` 控制，与本插件无关。
- 隐藏是视觉层（`display:none`），DOM 仍渲染；要从渲染层彻底去掉需改核心的 `message-parts.tsx`。
- 收尾卡只在"最新一条消息且该轮已结束"时存在（核心 `assistant-message.tsx` 的 `SettledChangedFiles`），发下一条消息它就退休 —— 这是核心行为，插件不改。

## 目录

```
plugin.js          # 全部逻辑（单文件 ESM）
README.md          # 本文件
.gitattributes     # 行尾规范，避免 Windows CRLF 把 .sh/.json 签出坏掉
```

## 兼容性

- Hermes 0.22.7 桌面端（打包版）实测。
- SDK 面：`atom` / `useValue` / `host.state` / `ctx.register` / `ctx.onEvent` / `ctx.onDispose`。
