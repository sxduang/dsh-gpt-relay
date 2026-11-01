# GPT 网页中转（GPT Relay）设计说明

> 这份文档写给要接手重构的人（Codex）。它说明：这套东西为什么存在、由哪几块组成、每块代码在哪、彼此怎么通话、有哪些坑已经踩过、哪些地方是明确的债。
>
> 代码根目录：`<repo>`
> 最后核对时间：2026-11-01（对应扩展 v0.2.0、worker 566 行、content.js 862 行、background.js 306 行）

---

## 1. 它解决什么问题

用户在微信里跟一个 DSH agent 聊天。他希望某些问题**由 ChatGPT 网页版来回答**（用他自己的账号、他自己的对话历史），答案再回到微信。

所以他需要的链路是：

```
微信(用户) → DSH 微信插件 → DSH agent → 本机 CLI → worker → Chrome 扩展 → chatgpt.com 页面
                                                     ↑                        │
                                                     └──── 回答/图片/截图 ─────┘
                                                                  ↓
                                                      dsh-wechat-send → 微信(用户)
```

关键约束（都是硬约束，重构时不能破）：

| 约束 | 原因 |
| --- | --- |
| 必须用**用户已经登录的那个 Chrome**，不能新开 profile 重新登录 | 用户明确拒绝重登；Chrome 的 Cookie 是应用绑定的，复制 profile 无效 |
| 不能设计 `/xxx` 形式的指令 | 微信插件会截胡所有以 `/` 开头的消息，返回「未知指令」，根本到不了 agent |
| 不能把工作区的 `AGENTS.md` 喂给 ChatGPT | 那是给本 agent 的操作说明，GPT 会当成任务去执行，回一句「我无法运行该命令」 |
| 不改动、不重装 `dsh-wechat-plugin` | 用户明确要求「不要搞坏原有微信插件」 |
| 未经用户同意不改行为 | 之前擅自改过两次，用户明确要求「先问再改」 |

---

## 2. 三个进程，一个页面

| 角色 | 跑在哪 | 代码 |
| --- | --- | --- |
| **agent** | DSH 里，微信会话绑定的那个 | 无代码；只按 `AGENTS.md` 的约定执行 CLI |
| **CLI** | 一次性 node 进程 | `relay/relay.mjs` |
| **worker** | 常驻 node 进程，监听 `127.0.0.1:8123` | `relay/worker.mjs` |
| **Chrome 扩展** | 用户的 Chrome，只在 `chatgpt.com` 生效 | `extension/{manifest,background,content}.js` |
| **ChatGPT 页面** | 用户已登录的标签页 | 外部依赖，选择器见 §7 |

worker 由开机启动脚本拉起：
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\GPT-Relay-Worker.vbs`
（内容形如 `sh.Run """<node.exe>"" ""<repo>\relay\worker.mjs""", 0, False`）

node 必须是 DSH 自带的那个，不是系统 node：
`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

---

## 3. 文件清单与职责

```
<repo>\
├─ docs\DESIGN.md              ← 本文档
├─ AGENTS.md                   ← 给 agent 的行为约定（触发词、命令、排查顺序）
├─ extension\
│   ├─ manifest.json           528 B   MV3 清单：权限 storage+debugger，host 限 chatgpt.com 与 127.0.0.1
│   ├─ background.js         12798 B   service worker：所有跨域 HTTP、CDP 截图、图片抓取（306 行）
│   └─ content.js            31836 B   页面自动化：找输入框、打字、发送、等回答、抽取、截图编排（862 行）
├─ relay\
│   ├─ worker.mjs            20655 B   HTTP 服务 + 队列 + 存储 + 微信投递（566 行）
│   ├─ relay.mjs              6259 B   agent 唯一入口的 CLI（139 行）
│   ├─ config.json             643 B   端口/token/node 路径/选择器/超时（16 行）
│   ├─ format.mjs             1403 B   markdown → 微信文本、分片（48 行）
│   ├─ test-format.mjs         607 B   format 的临时测试
│   ├─ threads.json                    DSH 会话 ↔ ChatGPT 对话 映射（运行期数据）
│   ├─ relay.log                       JSON 行日志（worker 与 CLI 都写这里）
│   └─ debug\                          dump/probe/错误报告 JSON
├─ answers\                    兜底目录：工作区不存在时答案落这里
├─ spike\                      早期实验（Chrome profile 探针、CDP 脚本），与运行无关，可直接忽略/删除
└─ <任意工作区>\.gpt-relay\     每个工作区的答案仓库，见 §6
```

### 3.1 `relay/relay.mjs`（CLI，139 行）

| 命令 | 行为 |
| --- | --- |
| `ask "问题" [--new] [--wait 秒] [--silent] [--session id]` | POST `/ask`，默认等 90s 打印答案 |
| `images` | POST `/ask?kind=images`，取对话里已有的图 |
| `health` / `status <id>` / `log [行数]` | 诊断 |
| `dump` / `dryrun` / `probe --file spec.json` | 页面结构诊断（一般不用） |

要点：

- `ask` 用 `process.cwd()` 当工作区，用 `process.env.DSH_SESSION_ID` 当会话 id（`relay.mjs:60-61`）。**这是"单位是对话"的实现基础**。
- `relay.mjs:84-86` 在回答后面固定追加一段给 agent 的硬提示，压住"agent 看到没有图就自己补画"的老毛病。这段措辞是行为约定的一部分，别随手删。
- `ROOT` 在 `relay.mjs:12` 是硬编码。

### 3.2 `relay/worker.mjs`（566 行）

| 区块 | 行 | 说明 |
| --- | --- | --- |
| 常量 | `worker.mjs:18-23` | `ROOT` 硬编码；`LOG_FILE`、`DEBUG_DIR`、`FALLBACK_DIR` |
| `log()` | `worker.mjs:25` | 追加 JSON 行到 `relay.log`，**同步 IO** |
| 工作区背景 | `worker.mjs:32-90` | `buildContext()` `worker.mjs:52`、`buildPrompt()` `worker.mjs:87` |
| 微信发送 | `worker.mjs:92-123` | `sendOnce()` `worker.mjs:96`（spawn `dsh-wechat-send`）、`sendWechat()` `worker.mjs:116`（串行链，保证配额账本一次一个） |
| 存储 | `worker.mjs:125-173` | `scopeBase()` `worker.mjs:127`、`mediaBase()` `worker.mjs:136`、`saveImages()` `worker.mjs:142`、`journal()` `worker.mjs:163` |
| 投递决策 | `worker.mjs:175-243` | `deliverAnswer()`，见 §8 |
| 会话绑定 | `worker.mjs:245-261` | `threads.json` 读写 |
| 任务生命周期 | `worker.mjs:263-365` | `jobs` Map / `queue` / `activeId` / `startJobTimeout()` `worker.mjs:272` / `createJob()` `worker.mjs:301` / `takeJob()` `worker.mjs:339` / `publicJob()` `worker.mjs:355` |
| HTTP | `worker.mjs:367-557` | 路由见 §5 |
| 启动 | `worker.mjs:559-566` | 监听 `127.0.0.1`，SIGINT/SIGTERM 退出 |

### 3.3 `extension/background.js`（306 行）

| 位置 | 作用 |
| --- | --- |
| `background.js:12-13` | `WORKER`、`TOKEN` 硬编码 |
| `background.js:16` `jsonFetch` | 用 service worker 的 host_permissions 发请求，绕开页面 CORS/CSP |
| `background.js:31` `captureElement` | **截图核心**，见 §9 |
| `background.js:225-300` | 消息路由：`poll` → `/job`；`result` → `/result`；`hello` → `/hello`；`fetch-image` → 带 cookie 取图（`:252`）；`capture-viewport`（`:271`）；`capture`（`:288`） |

### 3.4 `extension/content.js`（862 行）

| 函数 | 行 | 作用 |
| --- | --- | --- |
| `editableCandidates` / `findComposer` | `content.js:42` / `content.js:46` | 找输入框（`div.ProseMirror[contenteditable]`） |
| `findSend` | `content.js:56` | `button[aria-label="发送"]`，空输入框时不存在 |
| `composerText` | `content.js:70` | 读输入框文本 |
| `assistantNodes` | `content.js:75` | 所有 assistant 消息节点 |
| `stopVisible` | `content.js:82` | 是否仍在生成（停止按钮） |
| `buttonsReport` | `content.js:91` | 诊断用 |
| `setText` | `content.js:105` | `execCommand('insertText')`，失败退 `ClipboardEvent('paste')` |
| `clearComposer` | `content.js:134` | 清空 |
| `waitSendReady` | `content.js:155` | 等发送键出现（≤4s） |
| `pressEnter` | `content.js:165` | 回车兜底 |
| `scrollToBottom` | `content.js:180` | 滚到底（虚拟列表，`window.scrollTo` 无效） |
| `visibleDialogs` / `clickMatchingButton` / `dialogSummary` / `dismissOverlays` | `content.js:214` / `:231` / `:244` / `:259` | 弹窗处理 |
| `waitAnswer` | `content.js:286` | 等回答完成（元素身份 + 文本停滞 + 停止按钮消失） |
| `tableToMd` / `extractMd` | `content.js:334` / `content.js:347` | DOM → Markdown |
| `usableImage` / `readImage` / `collectImages` | `content.js:409` / `:418` / `content.js:446` | 取图（过滤 favicon、要求 `naturalWidth>=120`、失败走后台带 cookie 取） |
| `screenshotNode` / `screenshotViewport` | `content.js:462` / `content.js:482` | 调后台截图 |
| `richness` | `content.js:491` | 统计 images/tables/boxes/math/canvas，供投递决策 |
| `labelChains` / `runProbe` / `dumpReport` | `content.js:506` / `:530` / `content.js:558` | 结构化诊断（**不能用 eval**，页面 CSP 禁 `unsafe-eval`） |
| `sendResult` | `content.js:580` | 回传 worker |
| `runDryrun` | `content.js:588` | 试打字再清空 |
| `runAsk` | `content.js:611` | **主流程**：关弹窗 → 必要时新建对话 → 找输入框 → 打字 → 发送 → 等回答 → 抽取 → 截图 |
| `runImages` | `content.js:715` | 滚一遍加载图片后收集 |
| `handle` | `content.js:754` | 按 kind 分发；含"对话不一致就先导航再续跑" |
| `poll` | `content.js:814` | 每 2s 问一次 `/job`（`POLL_MS`） |
| `resumePending` | `content.js:825` | 导航后从 `sessionStorage` 恢复任务 |

---

## 4. 数据模型

### 4.1 job

```js
{
  id: '8hex',              // randomUUID().slice(0,8)
  kind: 'ask' | 'images' | 'dump' | 'dryrun' | 'probe',
  question: '原始问题',
  text: '实际打进页面的文字',   // ask 且需要背景时 = buildPrompt(ws, question)
  ws: 'D:\\some\\workspace',
  session: 'DSH_SESSION_ID 或 null',
  conversationUrl: 'https://chatgpt.com/c/...' | '',
  newChat: true | false,
  withContext: true | false,   // 首句才带背景
  status: 'queued' | 'running' | 'done' | 'failed',
  createdAt, startedAt, finishedAt,
  silent: true | false,        // 只落盘不推微信（测试用）
  markdown, meta, answerFile, reportFile, error, detail
}
```

`publicJob`（`worker.mjs:355`）只暴露 `id/kind/text/newChat/conversationUrl/timeoutSec/selectors` 给页面——**不要把 token、ws 绝对路径、session id 暴露进去**。

### 4.2 result 载荷（页面 → worker，`POST /result`）

```js
{ id, kind, status: 'ok'|'error', error, detail, report, screenshot,
  markdown, images: [{alt, width, height, dataUrl}],
  meta: {durationMs, timedOut, sendBy, images, rich, url, screenshotInfo} }
```

`meta.url` 是**页面当前 URL**，worker 用它写 `threads.json`（`worker.mjs:471-474`）。这条链路是会话绑定的唯一来源。

---

## 5. HTTP 协议（全部要求 `?token=`，`worker.mjs:389`）

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok, uptimeSec, queued, active, lastTabSeen, jobs, lastResult, threads}` |
| POST | `/hello` | `{url}` | `{ok}`；更新 `lastTabSeen` |
| POST | `/ask` | body=问题文本；`ws`,`session`,`new=1`,`silent=1`,`kind=` | `{ok, job, ws, session}` |
| GET | `/job` | `tab=<页面 url>` | `{ok, job|null}` |
| POST | `/result` | 见 §4.2 | `{ok}` |
| GET | `/status` | `id` | 任务详情（含 markdown、meta、answerFile） |
| GET | `/jobs` | — | 最近 20 条摘要 |

语义要点：

- **一次只跑一个任务**：`takeJob`（`worker.mjs:339`）在 `activeId` 非空时返回 `null`，队列 FIFO。
- **超时 360s**（`config.jobTimeoutSec`）：`queued` 超时记为 `no-tab`，`running` 超时记为 `timeout`，都会推微信。
- **45s 没被领取**（`config.queueHintSec`）→ 推一条"检查标签页并刷新"的提示。
- 页面侧 `POST /result` 之后 worker 立即回 JSON，但 `worker.mjs:475` 的 `deliverAnswer` 是 `await` 的，所以 HTTP 响应会等微信发完；重构时可改成先 202 再后台投递。

---

## 6. 存储布局

答案落在**发起提问的那个工作区**里，不是项目里：

```
<ws>\.gpt-relay\sessions\<sessionId>\
├─ <jobId>.md        本次回答的 Markdown 原文
├─ journal.md        追加式问答记录（## 时间 · jobid / **问：** / **答：**）
└─ media\<jobId>\
    ├─ answer.png    整条回答的长截图
    ├─ img-1.png…    回答里的原图（≤4 张）
    └─ error.png     失败时的页面截图
```

- `scopeBase()` `worker.mjs:127`：`ws` 不存在就退回 `answers\`。
- `mediaBase()` `worker.mjs:136`：每次任务一个子目录，避免覆盖。
- 无 session id 时直接放 `<ws>\.gpt-relay\` 下。

---

## 7. 页面契约（chatgpt.com，2026-10 版）

| 用途 | 选择器 | 失效症状 |
| --- | --- | --- |
| 输入框 | `div.ProseMirror[contenteditable="true"]` | `no-composer` |
| 发送 | `button[aria-label="发送"]` | 发送键找不到 → 回退回车 |
| 停止生成 | `[data-testid="stop-button"]` | 会误判"已答完" |
| 回答正文 | `[data-markdown-text-style="assistant-message"]` | 抽不到正文 / `no-visible-element` |
| 角色标记 | `h4[data-conversation-role="assistant"]` | 仅诊断用 |
| 生成图 | `[data-testid="generated-image-preview"] img` | 只出现在 markdown 根**之外** |
| 虚拟列表 | `[data-virtualized-turn-content]` | 旧消息会卸载，不能靠计数 |

必须知道的页面事实：

1. **没有** `#prompt-textarea`、`article`、`data-message-author-role`、`.markdown`。
2. 页面 CSP 不含 `unsafe-eval`：**不能用 `new Function`/`eval` 做探针**，所有诊断都是结构化 spec（`runProbe` `content.js:530`）。
3. 对话是虚拟列表：同一个回答在 DOM 里可能有**多份副本（含 0×0 的隐藏副本）**，取 `[...].pop()` 会取错。
4. 聊天滚动发生在**内层容器**，`window.scrollTo` 无效；页面重排会自己弹回底部。
5. 后台标签页里消息会正常追加，但**不会自动滚到底**——用户回来看不到，以为没发。

---

## 8. 微信投递决策（`deliverAnswer` `worker.mjs:175`）

```
richScore = images + tables + boxes + math
needsLink = 有 canvas 或 正文 > 500 字
wantsShot = 有截图 && 回答没有自己的图 && (richScore > 0 || 正文 > 500)
```

发送顺序：

1. 有长截图 → 先发图片（`【GPT 回答·Ns·工作区】` 作标题文字）。
2. 正文按 `chunkChars=1400` 分片：1 片直接发；2–4 片逐条发（`（续 i/n）`）；>4 片发前 3 片 + `.md` 文件。
3. 回答自带的图（≤4 张）逐张发。
4. `needsLink` 时补一条 `🔗 网页原文：<url>`。
5. 失败时：先发错误文本，再发 `error.png` 现场截图。

分片与排版在 `relay/format.mjs`：`toWechat()` 去 `**`、`## `→`【】`、`- `→`· `、表格行→`a｜b｜c`、`[t](u)`→`t（u）`；`splitChunks()` 按空行切段、超长再硬切。

> `format.mjs` 的中文替换字符在某些 PowerShell 回显里会显示成乱码，但**文件本身是 UTF-8 正常内容**；改动前先跑 `node relay/test-format.mjs`。

---

## 9. 截图管线（最容易坏的地方）

目标：把"这一条回答"（可能几千像素高、在虚拟列表里、部分内容在视口外）截成一张干净的图，**不要输入框、不要重复、不要空白**。

调用链：`content.screenshotNode` `content.js:462` → `background` 的 `capture`（`background.js:288`）→ `captureElement`（`background.js:31`）。

`captureElement` 的步骤：

1. **pick**：从 `[data-markdown-text-style="assistant-message"]` 里**从后往前**找最后一个 `height>40 && width>100` 的节点（避开 0×0 隐藏副本）。
2. **prepare**：向上找第一个 `overflow-y ∈ {auto,scroll,overlay}` 且 `scrollHeight > clientHeight+20` 的祖先，找不到用 `document.scrollingElement`；状态存 `window.__gptRelayShot`。
3. **align**：把元素顶边贴到滚动容器顶边（容器用 `sc.scrollTop += delta`，window 用 `window.scrollBy`），最多 3 次、误差 <2px。
4. **逐片**：每片推进 `step = max(200, viewportH-80)`，用 `Page.captureScreenshot` + `clip` 取视口内矩形，画到 OffscreenCanvas 的 `offset` 处。
5. **防重复**：`if (prevScroll !== null && state.scroll === prevScroll) break` —— 滚不动立刻停。
6. **遮罩**：截图前把 `form, [data-testid="composer-background"], [data-testid="composer"]` 设 `visibility:hidden`（不触发重排），`finally` 恢复。
7. **裁尾**：按实际 `offset` 裁掉多余画布高度。
8. 一张都没成功 → `{ok:false, error:'capture-locked'}`。

历史故障（读代码时对照，避免重犯）：

| 症状 | 真实原因 |
| --- | --- |
| 200×1 / 103 字节空白图 | `pop()` 取到 0×0 隐藏副本，`Math.max(1,0)` 生成 1px 高画布 |
| 同一屏重复 3 遍 | 挑的"滚动祖先"不是真正滚动容器，`scrollTop` 写在滚不动的元素上 |
| 截到输入框 | 元素顶端在视口上方时从 y=0 裁切 |
| 页面被挤窄 | 曾用 `Emulation.setDeviceMetricsOverride` 改视口宽度——**绝对不要改视口尺寸** |

---

## 10. 已知缺陷与技术债（按优先级）

### P0（影响可用性）

1. **截图算法脆弱**：依赖"元素顶边对齐容器顶"与固定 `step`；虚拟列表在滚动中卸载节点会让 `placeAt` 落空。当前版本刚重写，**尚未在 >2000 字带表格的长回答上验证通过**（上次验证出现整屏重复）。
2. **选择器单点失效**：全部来自 `config.selectors`，页面一改版就 `no-composer`/`no-visible-element`，没有候选链与自愈。
3. **单任务串行 + 无租约**：`activeId` 只在内存里；worker 重启后 `queued` 任务会一直等到 360s 超时。
4. **同步 IO**：`log`/`writeFileSync`/`appendFileSync` 都在事件循环上，长回答落盘时会阻塞 HTTP。

### P1（维护性）

5. 三个大文件（862 / 566 / 306 行）无模块边界，`content.js` 是一个 IIFE 包 35 个函数。
6. 硬编码：`ROOT` 两处（`relay.mjs:12`、`worker.mjs:18`）、`TOKEN` 两处（`config.json`、`background.js:13`）、端口三处。
7. `jobs` Map 只增不减（内存泄漏）；`/jobs` 只取末 20 条但不清理。
8. 无测试（只有 `test-format.mjs`）、无类型、无 lint。
9. 错误码是自由字符串（`no-composer`/`type-failed`/`capture-locked`…），没有集中定义与映射。
10. HTTP 响应要等微信发完才返回（`worker.mjs:475`），CLI 因此可能等很久。

### P2（功能缺口）

11. 取图 `kind=images` 常报 `no-images`：生成图在 markdown 根之外，且依赖 DOM 中已有 `<img>`。
12. 交互式画布（canvas 图表）无法截图，只能靠 `🔗 网页原文` 链接兜底。
13. 免费账号图像生成有额度上限，命中后只能取旧图。
14. 一个 DSH 会话永久绑定一个 ChatGPT 对话，**没有解绑/重建**入口（只能删 `threads.json` 里那一条）。

---

## 11. 重构建议（给 Codex）

### 11.1 建议的目标结构

```
src/
├─ core/            纯逻辑，可单测，不碰浏览器/网络
│   ├─ job.ts           任务状态机（queued→leased→running→done/failed/cancelled）
│   ├─ protocol.ts      zod schema：/ask /job /result 的请求与响应
│   ├─ format.ts        toWechat / splitChunks（从 format.mjs 迁）
│   ├─ delivery.ts      投递决策（纯函数：richScore/needsLink/wantsShot → 计划）
│   └─ paths.ts         存储路径（注入 root，不硬编码）
├─ adapters/
│   ├─ wechat.ts        封装 dsh-wechat-send（spawn + 退出码 + 串行队列）
│   ├─ storage.ts       落盘（异步 fs.promises）+ journal
│   └─ page/            ← 这一层跑在扩展里
│       ├─ selectors.ts 版本化的选择器集合 + 候选链
│       ├─ ask.ts       打字/发送/等待
│       ├─ extract.ts   DOM → Markdown / 图片
│       └─ capture.ts   截图
├─ worker/              HTTP 壳，只做路由 + 状态推进
└─ cli/                 参数解析，薄
```

### 11.2 必须保留的语义（行为契约）

- 每次回答必须落 `<ws>\.gpt-relay\sessions\<session>\`，`journal.md` 追加不覆盖。
- 只有**新对话的第一句**带 `【工作区背景】`。
- 绝不读取 `AGENTS.md` 作为背景。
- 微信投递顺序：截图 → 文字分片 → 原图 → 链接。
- 失败必须推微信，且带现场截图。
- CLI 的 `ask` 在成功后要打印那段「不要评论图片」的提示（`relay.mjs:84-86`）。

### 11.3 建议的测试

- 纯函数单测：`toWechat`、`splitChunks`、投递决策、`extractMd`（喂一段静态 HTML）。
- 协议单测：用 `zod` 校验 `/ask` `/result` 的入参。
- 页面 e2e（可选，用 Playwright + 已登录 Chrome 的用户数据目录）：断言"短回答→有截图"、"长表格回答→截图不重复"。这是目前最容易回归的部分。

### 11.4 迁移顺序（低风险优先）

1. 抽 `core/format.ts` 与 `core/delivery.ts`（纯函数，先补测试）。
2. 抽 `adapters/wechat.ts`、`adapters/storage.ts`，去掉同步 IO 与硬编码 `ROOT`。
3. `worker` 改成显式状态机 + 租约（lease + heartbeat），支持重启恢复杂志。
4. 最后才动 `content.js`：先拆 selectors/extract，再重写 capture。
5. 配置改 env / `config.json` 单一来源，token 支持随机生成。

---

## 12. 运行与排查

```powershell
$node = '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node <repo>\relay\relay.mjs health      # worker 活着吗、扩展最近联系过吗
& $node <repo>\relay\relay.mjs log 30      # 最近日志
& $node <repo>\relay\relay.mjs status <id> --wait 120
```

排查顺序：

1. `health.lastTabSeen.at` 不在最近几分钟 → ChatGPT 标签页关了或没刷新（让用户 F5）。
2. 任务 `queued` 没人领 → `chrome://extensions` 点扩展 ↻，再回页面 F5。
3. `failed` 且 `no-composer` / `type-failed` → 页面改版，跑 `dump` 看结构，改 `config.selectors` 后重启 worker（不用动扩展代码）。
4. 截图异常 → 看 `meta.screenshotInfo.{height,width,slices}`：`height` 为 0 或个位数就是 pick 失败；`slices` 很大且图重复就是滚动容器挑错。

---

## 13. 禁忌清单

- ❌ 不要改 Chrome 视口尺寸来"方便截图"（用户明确反感页面被挤窄）。
- ❌ 不要用 `eval` / `new Function` 在页面里跑代码（CSP 拦截）。
- ❌ 不要为了取图而"重新生成"图片（浪费用户的免费额度）。
- ❌ 不要卸载/重装/修改 `dsh-wechat-plugin`。
- ❌ 不要把 `/` 开头的指令设计进交互（会被插件截胡）。
- ❌ 不要把工作区 `AGENTS.md` 当背景喂给 ChatGPT。
- ❌ 不要在 agent 没拿到图片时就断言"GPT 没有图"，更不要自己画图补上。
- ❌ 未经用户同意不要改行为（历史上有两次擅自改动引发返工）。

---

## 14. 时间线（压缩版）

| 时间 | 事件 |
| --- | --- |
| 2026-10-27 | 可行性验证：headless 被 Cloudflare 拦，有头可用；确定为「扩展 + 本机 worker」 |
| 2026-10-27 | 第一轮冒烟通过（6s 出答案） |
| 2026-10-28 | 单位从"工作区"改为"对话"，`threads.json` 绑定 + 导航续跑验证通过 |
| 2026-10-28 | 微信投递定稿：截图 + 文字分片 + 原图 + 链接 |
| 2026-10-29 ~ 10-31 | 出现 200×1 空白截图，定位为隐藏副本；截图管线两次重写（可见节点挑选 → 滚动容器/对齐/防重复/遮罩） |
| 2026-11-01 | 本文档编写时，截图重写版待长回答验证 |
