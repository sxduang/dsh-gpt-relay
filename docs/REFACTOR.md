# GPT Relay 重构交接说明

日期：2026-11-01。项目位置：`<repo>`。

## 本轮范围

本轮是保持现有业务行为的结构重构。继续使用原来的 DSH Node、已登录 Chrome、MV3 扩展、本地 HTTP 协议和微信插件 CLI。没有引入 npm 依赖、TypeScript 编译环境或新的服务。

主要变化：

- `relay/worker.mjs` 只负责启动和退出；HTTP、任务队列、结果处理、投递策略和外部适配器分别维护。
- 日志、工作区背景、答案、图片、journal 和会话映射改用异步文件操作；同一 journal、日志和会话映射写入串行化。
- 会话映射通过临时文件和重命名发布，减少写到一半损坏 JSON 的风险。
- 安装根目录根据模块位置计算，CLI 的当前目录仍表示用户提问所在工作区。
- `relay/config.json` 成为扩展端口和 token 的配置来源；构建时生成浏览器入口，避免手工修改多处。
- 扩展可维护源码位于 `extension/src/`，Chrome 仍加载 `extension/content.js` 和 `extension/background.js`。
- 增加可注入依赖的服务工厂与隔离回归测试。

## 维护入口

| 需求 | 文件 |
| --- | --- |
| 调整 HTTP 接口 | `relay/worker-app.mjs`、`relay/http.mjs` |
| 调整任务生命周期 | `relay/core/jobs.mjs` |
| 调整结果保存和状态处理 | `relay/results.mjs` |
| 调整微信文字/截图/图片投递策略 | `relay/core/delivery.mjs` |
| 调整微信进程参数 | `relay/adapters/wechat.mjs` |
| 调整存储、journal、映射和日志 | `relay/adapters/{storage,threads,logger}.mjs` |
| 调整首句背景 | `relay/core/context.mjs` |
| 调整命令参数与输出 | `relay/relay.mjs` |
| 调整页面寻找、输入与等待 | `extension/src/content/{ui,typing,wait-answer}.mjs` |
| 调整 Markdown/图片提取 | `extension/src/content/{extract,images}.mjs` |
| 调整长截图 | `extension/src/background/capture.mjs` |
| 调整扩展消息路由 | `extension/src/background/messages.mjs` |
| 调整轮询与导航恢复 | `extension/src/content/runtime.mjs` |

## 验证命令

在 PowerShell 中使用 DSH 自带 Node：

```powershell
$relayNode = '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
Set-Location '<repo>'
& $relayNode scripts/check.mjs
```

这个检查依次进行 JavaScript 语法检查、扩展生成文件一致性检查和自动化测试。无需安装 npm 依赖。测试使用临时目录、随机本机端口和模拟微信发送器，不向真实微信发消息，不使用真实会话记录。

修改扩展源码或端口/token 后先构建：

```powershell
& $relayNode scripts/build-extension.mjs
& $relayNode scripts/check.mjs
```

`GPT_RELAY_ROOT` 可覆盖 Node 侧安装根目录，主要用于隔离测试；通常无需设置。扩展构建读取本安装目录的 `relay/config.json`。仅调整 selectors、超时或分片大小不需要重新生成扩展，但 worker 需要重启读取配置。

## 生效和回退

本次交付更新源码及已生成的扩展入口，不会自动重启原有 worker 或重载浏览器。Node 已加载的模块和 Chrome 已注入的脚本不会因磁盘文件更新而自动切换。

生效前先用 `relay/relay.mjs health` 确认没有正在运行或排队的任务。旧实现和本轮实现的队列都在内存里，重启会丢失其中任务。

随后按现有方式重启 worker，在 `chrome://extensions` 重载 GPT Relay Bridge，并刷新相关 ChatGPT 标签页。原有启动脚本路径和两个入口文件路径均保留。无需改动微信插件，也无需创建新的浏览器 profile。

安装时会把被覆盖文件备份到项目 `backups/refactor-<时间>/`；其中 `install-manifest.json` 列出每个文件是否原来存在、备份前哈希和安装后哈希。回退时先停止 worker，从该备份恢复原有文件，再重启 worker、重载扩展和刷新页面。新增模块不被旧入口引用，可以保留；不要用目录镜像删除工作区答案、日志或会话数据。

## 已验证范围和限制

自动化检查覆盖 HTTP 和 CLI 契约、会话绑定、背景规则、存储位置、journal 追加、微信投递策略、发送串行化、扩展构建和部分页面提取逻辑。具体测试名称见 `tests/`；本轮测试记录见随交付提供的验证记录。

没有执行真实 ChatGPT → 微信端到端发送，也没有验证真实页面上超过 2000 字的长截图。截图算法本轮仅搬迁，不能把结构重构视为截图缺陷已经修复。今后页面改版仍需在用户已登录的 Chrome 上单独验证。

## 保留的既有行为与技术债

- `--silent` 只抑制成功 ask 的发送，并跳过原图保存；错误、超时、排队提醒和 images 任务仍可能发送微信。
- `done` 在投递结束前设置，`/result` HTTP 响应仍等待投递完成。此行为已纳入回归测试。
- 重复或迟到的 `/result` 仍被接受，可能重复发送；本轮没有增加幂等键、租约、心跳或重启恢复。
- `jobs` 不自动清理；重启会丢失所有内存任务。原文档“重启后排队任务继续等到超时”的描述与代码不符。
- 同一会话在第一条结果绑定之前连续排队多个问题，仍可能各自按新对话构造；本轮没有更改绑定时机。
- 短纯文本回答不一定投递截图。原图全部保存，最多向微信投递四张。
- 页面选择器、生成结束判断、导航恢复、弹窗选择和截图滚动算法保持原有逻辑。
- HTTP 请求体仍保留原来的约 200 万字符限制；很大的截图回传需要另行评估协议和限制。

租约与恢复、幂等投递、截图修复、选择器候选链和更完整的协议校验都涉及实际行为，建议单独确认范围后实现。
