# dsh-open-folder-fix

修正 DSH Web GUI 里「打开工作区」按钮在 Windows 上的行为。

## 问题

DSH 的 Session 头部有一个「在应用中打开工作目录」的分裂按钮。在 Windows 上，
它实际执行的命令是：

```
powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '<目录>'"
```

`Invoke-Item` 执行的是该目录的**默认 shell 动词**。它一旦把请求交给 shell 就
立刻返回退出码 0，**不管窗口最终有没有出现在你眼前**。

上游选这条通道是有注释记录的：catalog 里 `finder` / `explorer` 都用
`shell-open`，注释说明理由是"对目录来说文件管理器就是 OS 默认程序，而直接
`explorer.exe <dir>` 不总能可靠地弹出窗口"。也就是说，上游要的是"用系统默认
方式打开目录"这个抽象，并不是想实现"已打开就跳过去"。

### 那个动词到底有多不可靠

实测（Windows 10 19045.7663），对**同一个已打开的目录**再执行 `Invoke-Item`：

| 已有窗口状态 | 实际结果 |
| --- | --- |
| 已打开且在前台 | 又新建一个窗口（窗口数 1 → 2） |
| 已打开但在别的窗口后面 | 又新建一个窗口（2 → 3），没有任何窗口被提到前台 |
| 已打开但最小化 | 又新建一个窗口，旧的最小化窗口仍留着（1 → 2） |

结论：它**既不复用，也不跳转**，行为更像每次新建，但会随窗口来源不同而变化
（观测到过一次真正复用）。所以现象不是三种确定模式，而是**由窗口状态决定的
不确定行为**。

真正的问题在于**没有可靠的成功信号**：`Invoke-Item` 交出控制权即返回 0，
后端的成功判据就是退出码（`launchWatchMs` 看门狗 + exit 0）。于是"其实什么
都没发生"与"成功"在 DSH 和系统日志里完全一样，按钮照常变回空闲、不报错。

## 修法

改用 `explorer.exe /e,<目录>`，它对两种情况都稳定地新开窗口。实测
（PowerShell，`explorer.exe` 交出控制权后一律返回退出码 1，这是委派交接而非失败）：

| 命令 | 行为 |
| --- | --- |
| `Invoke-Item <目录>`（原状） | 多数情况新建，偶尔复用；成功与否无信号 |
| `explorer.exe /e,<目录>` | 连续 6 次均新建窗口；目录已开着时同样新建 |
| `explorer.exe <目录>` | 也新建窗口 |
| `explorer.exe /select,<父目录>` | 新建并选中目标 |

## 结构

```
package.json        bundle 清单：声明 dsh.bundle.patch 与 dsh.client
cordis.patch.yml    禁用上游 ui-open-in-app，插入本插件的 Host 行
index.js            Host 半边：注册 POST /open-folder-fix/open
client.js           浏览器半边：接管 Session 头部的分裂按钮
```

两半的分工：

- **Host** 只加一个路由，路径刻意**不**与上游 `/open-in-app/*` 重叠。
  `webServer.register` 对重复的 (kind, path) 会直接抛错，所以覆盖上游路由
  会让插件在加载时炸掉。
- **浏览器** 自己从 `/open-in-app/apps` 读取已安装应用列表，对
  `explorer` 这一个 id 路由到本插件的路由，其余应用（VS Code、Windows
  Terminal、Git Bash 等）**原样转发给上游** `/open-in-app/open`，
  因此上游的应用探测、图标和启动策略都不受影响。

上游 `@deepseek-ai/dsh-host-open-in-app` **保持挂载**，因为本插件需要它提供
应用目录与图标。

## 为什么要禁用上游的浏览器半边

上游 `ui-open-in-app` 与本插件会争抢同一个 slot cell id（`open-in-app`）。
插槽文档说明复用 id 会替换那个 cell，但两个注册者的胜出取决于激活顺序，
不确定。因此 patch 显式禁用上游浏览器半边，保证只有一个注册者：

```yaml
- id: ui-open-in-app
  disabled: true
```

## 配置

`launchWatchMs`（默认 1500）：`explorer.exe` 交接的早期失败观察窗口。
启动成功与否不与进程退出绑定——Explorer 把请求交给正在运行的 shell 后就退出，
所以只有 spawn 错误（如 ENOENT）才算失败。

### `Config` 必须导出 Standard Schema

**这是本项目踩过的坑，改 `Config` 前务必读完。**

cordis 的 `resolveConfig` 只要发现插件导出了 `Config`，就**无条件**读
`Config['~standard'].validate(config)`：

```js
// @deepseek-ai/cordis  lib/index.js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)  // ← 无保护的属性读取
  ...
}
```

因此 `Config` 必须是符合 [Standard Schema](https://standardschema.dev) 的对象
（含 `~standard.validate`）。如果写成看起来更自然的样子：

```js
// ✗ 错误：会让整个 dsh 起不来
export const Config = {
  launchWatchMs: { type: 'number', min: 1, max: 600000, default: 1500 },
}
```

普通对象没有 `~standard`，上面那行读出 `undefined`，紧接着 `.validate(...)`
抛 `TypeError`。这个异常发生在**组合树启动阶段**，结果是整个 dsh 无法启动，
而不只是本插件失效——排查时会以为坏的是别处。

正确写法见 [index.js](index.js) 的 `Config`：自带 `validate`，负责填默认值、
校验范围，并返回 `{ value }` 或 `{ issues }`。

## 已知边界

- **仅 Windows 有意义**。非 win32 上路由返回 501；macOS/Linux 请沿用上游行为。
- 图标沿用上游 `/open-in-app/icon/explorer`。上游的目录表里本来就有
  `explorer` 条目，因此图标正常解析。
- 与上游 `@deepseek-ai/dsh-native-command` 的 `revealNativePath`
  （`explorer.exe /select,`，用于"在资源管理器中显示某个文件"）无关：
  那条路径是按文件定位，不是打开工作目录，本次未改动。

## 依赖说明

本插件只用 Node 内置模块。**不要**在这里 import
`@deepseek-ai/dsh-host-open-in-app`：该包只导出 `Config`、`apply`、`inject`、
`name`，目录解析不在公开面上，依赖它等于依赖 alpha 版本的内部实现。
与上游的全部交互都走公开 HTTP 路由。

## 重新安装

同路径重复 `install_bundle` 会因上游 plugin-manager 的判定逻辑报
`ambiguous-install`（它靠"dependencies 是否变化"来识别装了哪个包，
包已存在时识别不到）。包在 profile 里是**符号链接**，所以改完代码刷新页面
即可生效，不需要重装。
