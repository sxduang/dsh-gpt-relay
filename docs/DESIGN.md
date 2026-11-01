# GPT 网页中转：当前设计

更新日期：2026-11-01。代码根目录：`<repo>`。

这是保持现有行为的模块化重构版本。重构前完整设计与故障历史保存在 [DESIGN.before-refactor.md](DESIGN.before-refactor.md)；本轮改动、测试、生效、回退和已知限制见 [REFACTOR.md](REFACTOR.md)。本文的文件路径对应当前代码，旧版行号不再适用。

## 链路

```text
微信 → DSH agent → relay/relay.mjs → 本机 worker
                                      ↕ /job、/result
                           Chrome 扩展 → 已登录的 ChatGPT 页面
                                      ↓ 回答、图片、截图
                           工作区落盘 → 现有微信插件 CLI → 微信
```

继续使用 DSH 自带 Node、已有登录状态、MV3 扩展和本地 HTTP。没有新增包依赖或外部服务。原有启动脚本仍指向 `relay/worker.mjs`，CLI 入口仍为 `relay/relay.mjs`。

## 当前模块

| 职责 | 路径 |
| --- | --- |
| 进程入口、监听与退出 | `relay/worker.mjs` |
| 依赖组装与 HTTP 路由 | `relay/worker-app.mjs`、`relay/http.mjs` |
| 页面结果、状态、绑定与投递 | `relay/results.mjs` |
| 内存 FIFO、单 active、超时提醒 | `relay/core/jobs.mjs` |
| 首句工作区背景 | `relay/core/context.mjs` |
| 纯投递计划与执行 | `relay/core/delivery.mjs` |
| 文件、journal 与图片保存 | `relay/adapters/storage.mjs` |
| 会话映射加载和原子保存 | `relay/adapters/threads.mjs` |
| 顺序异步日志 | `relay/adapters/logger.mjs` |
| 现有微信 CLI 子进程和串行发送 | `relay/adapters/wechat.mjs` |
| 安装目录解析与配置加载 | `relay/config.mjs`、`relay/config.json` |
| CLI 命令与输出 | `relay/relay.mjs` |
| 微信排版与分片 | `relay/format.mjs` |
| 页面输入、等待、提取、诊断和导航 | `extension/src/content/` |
| HTTP、CDP 截图和扩展消息路由 | `extension/src/background/` |
| 无依赖扩展构建 | `scripts/build-extension.mjs` |
| 语法、生成一致性与测试 | `scripts/check.mjs`、`tests/` |

扩展内部模块索引见 [extension/README.md](../extension/README.md)。Chrome 仍加载生成的 `extension/content.js`、`extension/background.js` 和 `extension/manifest.json`。请编辑 `extension/src/` 后重新构建，不要直接修改生成文件。

## 配置与任务契约

Node 根据模块安装位置定位根目录。CLI 的 `process.cwd()` 仍表示发起问题的工作区，`DSH_SESSION_ID` 提供会话 ID，`--session` 可覆盖。可选环境变量 `GPT_RELAY_ROOT` 仅覆盖 Node 侧根目录，主要用于隔离测试。

`relay/config.json` 是配置权威来源。端口/token 修改后，构建工具同时生成扩展的连接参数与 host permission；选择器仍随任务下发。默认 8123 端口、360 秒超时、45 秒排队提醒、1400 字分片保持。

任务仍为内存 FIFO，状态为 queued → running → done/failed，一次只允许一个 active。异步背景读取通过串行创建链保证入队顺序。queued 超时记 no-tab，running 超时记 timeout；重启会丢失内存任务，本轮没有租约或重启恢复。

`threads.json` 将每个 DSH 会话绑定到一个 ChatGPT URL。未绑定或显式 --new 时附首句背景；背景优先读取 `.gpt-relay/brief.md`，其次 README，再附有限目录列表，绝不读取 AGENTS.md 内容。成功 ask 的 meta.url 更新绑定。页面导航续跑仍使用 sessionStorage。

publicJob 只包含 id/kind/text/newChat/conversationUrl/timeoutSec/selectors；不额外暴露 token、ws 或 session 字段。首句 text 中原有工作区背景仍含路径。

## HTTP 与 CLI

HTTP 仍监听 127.0.0.1，所有接口继续要求 token 查询参数。

| 路由 | 用途 |
| --- | --- |
| /health | uptime、queued、active、lastTabSeen、jobs、lastResult、threads |
| POST /hello | 页面最近联系时间 |
| POST /ask | 问题文本及 ws/session/new/silent/kind 参数 |
| /job | 按 FIFO 领取一个任务 |
| POST /result | 回传答案、图片、截图、报告或错误 |
| /status?id= | 查询状态、答案及文件路径 |
| /jobs | 最近 20 条摘要 |

CLI 的 ask、images、health、status、log、dump、dryrun、probe 保留。ask 默认等待 90 秒，--wait 0 立即返回 ID。成功后的“不评论图片有无、不自行补画”提示完整保留。

/result 仍先设置终态再保存和投递，HTTP 响应等待投递结束；未改为 202。重复/迟到结果仍可能重复投递。--silent 只抑制成功 ask 的发送，并跳过原图保存；错误、超时、提醒和 images 任务的既有发送行为保留。

## 存储与微信投递

答案仍保存在 `<ws>/.gpt-relay/sessions/<session>/<job>.md`，journal.md 追加，媒体放在 `media/<job>/`。无 session 时使用 `<ws>/.gpt-relay/`；工作区不存在时使用项目 answers/。报告、日志和映射位置保留。

存储改用异步文件操作；journal、日志和映射写入串行化；映射通过临时文件加重命名发布。

投递顺序保持：符合条件的长截图 → 微信格式文字分片 → 最多四张原图 → 网页链接。短纯文本不一定发截图；回答自带图片时不发长截图。超过四片正文时先发前三片，再附完整 Markdown 文件。所有有效原图保存，微信只发前四张。失败先发错误文字，再发送已回传的现场截图。

微信插件 CLI 仍是唯一实际发送器，串行调用和原有间隔保持。正文 Markdown 原文、UTF-8 编码和文件名保持。

## 页面与截图

后续截图优化已经启用正文坐标拼接、自适应稳定检测、悬浮层隐藏与成图留白；详见 [CAPTURE-IMPROVEMENTS.md](CAPTURE-IMPROVEMENTS.md)。以下描述为首轮重构时的历史状态：CDP 长截图算法移入 `extension/src/background/capture.mjs`，保持可见副本选择、滚动祖先寻找、对齐、分片、滚动停止、防遮挡、裁尾和 finally 恢复逻辑。原页面函数、选择器、弹窗处理和导航恢复逻辑保持。

离线测试覆盖隐藏副本、滚动停止、裁切坐标和失败后恢复，但没有进行真实 ChatGPT 长回答截图验收。原始截图故障历史和页面契约见旧设计第 7、9 节。

## 必须遵守的约束

- 使用用户已登录的 Chrome，不新建需要重新登录的 profile。
- 不改变视口宽高，不在页面使用 eval/new Function。
- 不为取图重新生成图片，不因没拿到图片而自行补画。
- 不修改、卸载或重装微信插件，不设计以 / 开头的用户指令。
- 不把 AGENTS.md 内容作为背景发给 ChatGPT。
- 会话绑定、发送规则、重试规则和页面行为的变化需要先确认需求。

完整的本轮验证边界、保留技术债、生效与回退步骤见 [REFACTOR.md](REFACTOR.md)。


## 图片输入扩展

已增加 ask --image，多张图片与文字一起提交；任务增加附件元数据、带鉴权的 /attachment 按需读取和扩展上传等待。具体协议、限制和生效方法见 [IMAGE-UPLOAD.md](IMAGE-UPLOAD.md)。

## 当前截图实现更新

截图已改为本次回答唯一标记定位、单次原生长截图；原逐屏拼接说明属于历史版本。当前算法、验证与生效步骤以 [CAPTURE-NATIVE.md](CAPTURE-NATIVE.md) 为准。

## 截图可靠性与投递状态更新

当前截图发送规则已变更为所有正常回答均发送可用截图；新增布局重拍、delivery 实际投递状态和输入前调试器占用检查。详见 [CAPTURE-RELIABILITY.md](CAPTURE-RELIABILITY.md)。旧版按回答长度/原图决定是否发截图的描述不再适用。

## 回答节点重建恢复更新

当前 ChatGPT 页面使用 data-chatgpt-selection-message-id 与 data-turn-key。截图已支持同一消息节点重建后的重新定位、虚拟列表高度保护和已有回答诊断截图；详见 [CAPTURE-ANCHOR-RECOVERY.md](CAPTURE-ANCHOR-RECOVERY.md)。


## 图片慢加载与原任务继续更新

图片任务现支持 paused 与 resume，保持原草稿并申请一次发送许可。当前行为、DSH 操作约定及升级要求见 [UPLOAD-RESUME.md](UPLOAD-RESUME.md)。

