# HermesPlugins

Hermes 桌面端（Electron）插件集合。纯前端 ESM 部分无构建步骤，不改 Hermes 核心代码，禁用即完全恢复原状。

| 插件 | 作用 |
|---|---|
| [`turn-indicator`](./turn-indicator) | 输入框上方常驻一行「本轮在干什么」：常亮方块 + 实时文案 + 秒数（整轮保持挂载）；`::turn{}` 内联指令；对话里隐藏全部工具行；**气泡下方的状态行整行隐藏**；本轮那口气泡的边缘呼吸光（只作用于气泡本身）。以上都在 **Settings ▸ Plugins ▸ Turn indicator** 里可调 |
| [`read-only-mode`](./read-only-mode) | 输入框 `+` 右侧的只读开关（对应 Cursor 的 Ask 模式），开启后每条消息带只读约束 |
| [`git-ops`](./git-ops) | 右侧 Git 面板 + 9 个 agent 工具：多仓库扫描、状态 / diff / log、生成提交信息、按显式路径提交、推送验证、拉取、放弃修改（含 `dashboard/plugin_api.py` 后端；放弃只动已提交过的文件，新文件（未跟踪的、或只 `git add` 过的）只取消暂存并在结果里报出，绝不删除、也不整批失败）。点工作区文件行按 TortoiseGit → VS Code → 面板内 diff 三级降级打开；文件搜索树里点文件行直接用 VS Code 打开，悬停行右侧出现复制按钮，复制其工程内相对路径。提交/推送/拉取/放弃后同步刷新输入框上方的 coding status bar（分支 / 领先落后 / ±）。面板计时器全部走 `ctx.setTimeout`（重载不残留轮询）、中英文文案走 `ctx.i18n`、忽略后缀 / 轮询间隔 / 扫描深度在 **Settings ▸ Plugins ▸ Git Ops** 里配 |

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

也可以手动把 `<id>/desktop/plugin.js` 拷到 `$HERMES_HOME/desktop-plugins/<id>/plugin.js`（开发时用下面的同步脚本）。应用对 `desktop-plugins/` 根目录有 fs watch，新目录出现即自动加载，无需手动 Reload。

## 结构

```
<id>/
  plugin.yaml        # 清单：name / version / description / requires_hermes / capabilities
  desktop/plugin.js  # 全部逻辑（单文件 ESM，仅 import @hermes/plugin-sdk / react）
  README.md
tools/
  sync-desktop-plugins.mjs   # 开发同步：仓库 → 桌面端插件根目录（见下）
  test-plugins.mjs           # 测试门：静态检查 + 用假时钟直接驱动已发布的逻辑
```

## 开发：改完仓库一条命令生效

```bash
node tools/sync-desktop-plugins.mjs                  # 刷新已装在桌面端的插件（不安装新的）
node tools/sync-desktop-plugins.mjs turn-indicator    # 点名同步 / 首次拷入
node tools/sync-desktop-plugins.mjs --watch           # 保存即同步（Ctrl-C 退出）
node tools/sync-desktop-plugins.mjs --home <PATH>     # 非默认 HERMES_HOME
```

把 `<id>/desktop/` 整棵树同步到 `<HERMES_HOME>/desktop-plugins/<id>/`，只改写有差异的文件并打印结果。
应用自己监听那份拷贝，`register()` 随即重跑 —— 不用 Reload，不用重启。

- 不点名时只刷新**已存在**于桌面端根目录的插件，缺的打 `not installed`；要点名才会拷入，免得顺手装上没打算装的插件。
- 拒绝同步带 `.hermes-package.json` 的目录：那是 `hermes plugins install` 托管的半边，应用会自己覆盖。
- 不能用软链代替：仓库放在 `<id>/desktop/plugin.js`，加载器读 `<root>/<id>/plugin.js`，两者不同构。

## 校验

```bash
hermes plugins validate ./turn-indicator
hermes plugins validate ./read-only-mode
```

两个都通过。`turn-indicator` 会带两条 catalog rule 8 复核提示：它用 `[data-slot="tool-block"]` 这一核心 markup 选择器隐藏工具行，若要走官方 catalog 需先改成 SDK 正路。

## 测试

```bash
node tools/test-plugins.mjs              # 全部插件
node tools/test-plugins.mjs turn-glow    # 指定插件（静态部分）
```

无依赖、无浏览器，两层：

1. **静态** —— 每个 `<id>/desktop/plugin.js` 能否按 ES module 解析、`import` 是否只用了加载器能解析的三个包
   （`react` / `react/jsx-runtime` / `@hermes/plugin-sdk`）、是否纯 LF、**有没有忘记删的调试探针**；
   `plugin.yaml` 的 `name` 是否等于目录名。`requires_hermes` 只给 WARN（加载器不读它）。
2. **逻辑** —— 把**已发布源码**里的片段抽出来直接驱动（不是手抄一份镜像）：`turn-indicator` 的回合闩（假时钟，
   覆盖"工具在飞时 busy 掉"、"发出去等首个 token"、"别的会话在跑"、"回合真结束后才收"、以及"同一个 tick 顺手重贴气泡"），
   `describeTool` 的文案映射，注入 CSS 的契约（工具行仍被隐藏、呼吸光只落在气泡、`from`/`to` + `alternate`、
   光的那部分不写 `!important`、不自造圆角）。

跑完打印 `ALL PASS` / `N FAILURE(S)` 并给出退出码。

**真机那一半跑不了无头**（打包版不开 CDP）：做法是让插件自己 `console.error('[<tag>] …')`，
再 `grep '<tag>' "$HERMES_HOME/logs/desktop.log"` —— 每个插件 README 的实现要点里都有具体样例。

## 兼容性

Hermes 0.22.7 桌面端（打包版）实测。SDK 面：`ctx.register` / `ctx.onEvent` / `ctx.onDispose` / `ctx.storage` / `atom` / `useValue` / `host.state` / `Button` / `Codicon` / `Tip` / `GHOST_ICON_BTN`。

## License

MIT
