# dsh-open-folder-fix

修正 DSH Web GUI 里「打开工作区」按钮在 Windows 上的行为。

## 问题

DSH 的 Session 头部有一个「在应用中打开工作目录」的分裂按钮。在 Windows 上，
它走 `shell-open` 通道，最终由 `@deepseek-ai/dsh-native-command` 执行：

```
explorer.exe "<目录的 file:// URI>"        ← 0.1.7-rc.1 的写法
```

更早的版本走的是另一条命令（`powershell.exe -NoProfile -Command
"Invoke-Item -LiteralPath '<目录>'"`）；两者症状相同，见下。

**上游的 explorer 调用在某些 Windows 主机上不起作用，而且不报错。** 这是上游
自己记录在案的已知限制（`dsh-native-command/README.md`，Known Limitations）：

> 非交互会话（服务、或无交互登录的计划任务）里，`explorer.exe` 不调用任何文件
> 关联，并在约 1 秒后仍然以退出码 1 返回……于是「打开」**报告成功却什么都没打开**。

上游的成功判据就是退出码：`runExplorer` 把退出码 1 当作"已交接给桌面进程"而
吞掉，`runShellOpen` 再用 `launchWatchMs` 看门狗兜底。于是"窗口开了"和"什么都
没发生"在 DSH 看来完全一样，按钮照常变回空闲、不报错。

### 实测：上游写法在本机失败

Windows 10 19045.7663，直接用上游模块的真实代码路径调用：

| 调用 | 报告结果 | Explorer 窗口数变化 |
| --- | --- | --- |
| `openNativePath('D:\Projects\dshell')`（上游 0.1.7-rc.1） | **成功** | **5 → 5（Δ0）** |
| `explorer.exe /e,D:\Projects\dshell`（本插件） | — | **6 → 7（Δ1）** |

两者都用 `execFile` 调用 `explorer.exe`，唯一差别是参数。上游那次**报告成功、
一个窗口都没开**——正是上面那段 Known Limitation 描述的情形。

## 修法

改用 `explorer.exe /e,<目录>`，实测能稳定新开窗口。`explorer.exe` 交出控制权后
一律返回退出码 1，这是委派交接而非失败（上游 `runExplorer` 也按此处理）：

| 命令 | 行为 |
| --- | --- |
| `explorer.exe <file:// URI>`（上游现状） | 本机不弹窗，但报告成功 |
| `explorer.exe /e,<目录>`（本插件） | 连续 6 次均新建窗口；目录已开着时同样新建 |
| `explorer.exe <目录>` | 也新建窗口 |
| `explorer.exe /select,<父目录>` | 新建并选中目标 |

`Invoke-Item`（更早版本的上游写法）的表现记录在此备查：它执行该目录的默认
shell 动词，把请求交给 shell 后立刻返回退出码 0，多数情况新建、偶尔复用，且
成功与否没有信号。

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
