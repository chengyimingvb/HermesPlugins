# HermesPlugins

Hermes 桌面端（Electron）插件集合。纯前端 ESM 部分无构建步骤，不改 Hermes 核心代码，禁用即完全恢复原状。

| 插件 | 作用 |
|---|---|
| [`turn-indicator`](./turn-indicator) | 输入框上方常驻一行「本轮在干什么」：脉冲 + 实时文案 + 秒数；`::turn{}` 内联指令；运行中显示工具行 |
| [`read-only-mode`](./read-only-mode) | 输入框 `+` 右侧的只读开关（对应 Cursor 的 Ask 模式），开启后每条消息带只读约束 |
| [`git-ops`](./git-ops) | 右侧 Git 面板 + 9 个 agent 工具：多仓库扫描、状态 / diff / log、生成提交信息、按显式路径提交、推送验证、拉取、放弃修改（含 `dashboard/plugin_api.py` 后端）。点文件行按 TortoiseGit → VS Code → 面板内 diff 三级降级打开。提交/推送/拉取/放弃后同步刷新输入框上方的 coding status bar（分支 / 领先落后 / ±）。面板计时器全部走 `ctx.setTimeout`（重载不残留轮询）、中英文文案走 `ctx.i18n`、忽略后缀 / 轮询间隔 / 扫描深度在 **Settings ▸ Plugins ▸ Git Ops** 里配 |

## 安装

```bash
hermes plugins install chengyimingvb/HermesPlugins/turn-indicator
hermes plugins install chengyimingvb/HermesPlugins/read-only-mode
```

装完在桌面端 **Settings → Plugins** 里打开插件（包内 desktop 半边默认关闭）。卸载：`hermes plugins remove <id>`。

需要可复现的安装（锁到某个提交，`hermes plugins list` 不再报 `provenance: drift`）时加 `--ref <40 位 SHA>`：

```bash
hermes plugins install chengyimingvb/HermesPlugins/turn-indicator --ref <commit-sha>
```

也可以手动把 `<id>/desktop/plugin.js` 拷到 `$HERMES_HOME/desktop-plugins/<id>/plugin.js`，然后 ⌘K → **Reload desktop plugins**。

## 结构

```
<id>/
  plugin.yaml        # 清单：name / version / description / requires_hermes / capabilities
  desktop/plugin.js  # 全部逻辑（单文件 ESM，仅 import @hermes/plugin-sdk / react）
  README.md
```

## 校验

```bash
hermes plugins validate ./turn-indicator
hermes plugins validate ./read-only-mode
```

两个都通过。`turn-indicator` 会带两条 catalog rule 8 复核提示：它用 `[data-slot="tool-block"]` 这一核心 markup 选择器隐藏工具行，若要走官方 catalog 需先改成 SDK 正路。

## 兼容性

Hermes 0.22.7 桌面端（打包版）实测。SDK 面：`ctx.register` / `ctx.onEvent` / `ctx.onDispose` / `ctx.storage` / `atom` / `useValue` / `host.state` / `Button` / `Codicon` / `Tip` / `GHOST_ICON_BTN`。

## License

MIT
