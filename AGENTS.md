# 这个工作区的约定

## GPT 网页中转

用户说「问GPT…」「转给GPT」「让GPT看看」之类时，走本机中转，不要自己回答、也不要重复发到微信（中转程序答完会自动把文字和截图推给用户）。

优先用插件工具。worker 现在跑在 DSH 进程里，随 DSH 启动，不再需要单独的服务进程：

- `gpt_relay_ask(question, waitSec?)` — 提交问题，返回 job id；`waitSec` 内完成就一并返回答案
- `gpt_relay_status(id, waitSec?)` — 查任务（paused 时确认 resumable，用 resume，不要重新问）
- `gpt_relay_resume(id, waitSec?)` — 继续 paused 的图片任务，保留原草稿
- `gpt_relay_health()` — worker、队列、扩展最近连接、微信投递、能力标志
- `gpt_relay_pairing()` — 给浏览器扩展用的 `主机:端口#令牌`

流程：
1. 调用 `gpt_relay_ask`，拿到 job id。
2. 立刻回用户一句「已发给 GPT，答完自动推给你」——一句话就够。
3. 答案本身由中转程序直接推微信，不需要你复述。

命令行等价物（脚本或排查时用；node 路径是 DSH 自带的，不要用系统 node）：

```
C:\Users\duang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe D:\GPTtalkwithmeforDSH\relay\relay.mjs ask "用户的原话"
```

- `relay.mjs health` — 看 worker 是否在跑、扩展是否连着
- `relay.mjs status <id> [--wait 秒]` — 查某个任务
- `relay.mjs log 30` — 看最近日志
- `relay.mjs dump` / `dryrun` / `probe --file spec.json` — 排查页面结构（一般不用）

排查顺序（用户说“没反应/没收到”时）：

1. `gpt_relay_health`：`扩展最近连接` 不在最近几分钟内——说明 Chrome 里那个 ChatGPT 标签页关了或没刷新。
2. 任务进了 `queued` 但没人领取 → 让用户在 `chrome://extensions` 里点一下扩展的 ↻，再回 GPT 页按 F5。
3. `failed` 且 `error=no-composer` / `type-failed` → 页面大概率改版，跑 `dump` 看结构，改运行配置里的 `selectors`，重启 DSH（worker 在 DSH 进程内）。
4. 截图报 `capture-raster-timeout` → 先确认 ChatGPT 标签页没被最小化；代码已会自动切到前台并重试一次。
5. 中文乱码只出现在控制台输出，写入的文件是 UTF-8，不用管。

## 文件位置

- `extension/src/` — Chrome 扩展源码；`extension/{background.js,content.js,manifest.json,options.html,options.js}` 是 `node scripts/build-extension.mjs` 的产物，改源码后必须重新构建
- `lib/index.js` — DSH 插件入口（注册工具、启动内嵌 worker、生成运行配置、物化扩展）
- `relay/` — worker 核心（`core/`、`adapters/`、`http.mjs`）与 `relay.mjs` 命令行
- 运行配置：`C:\Users\duang\.dsh\gpt-relay\config.json`（端口、令牌、node、wechatCli、selectors）；日志在 `C:\Users\duang\.dsh\gpt-relay\relay\relay.log`
- 已加载的扩展副本：`C:\Users\duang\.dsh\gpt-relay\extension`
- 答案与截图：`<工作区>\.gpt-relay\sessions\<会话id>\`
- 启动：DSH 启动时插件自动拉起 worker；旧的 `GPT-Relay-Worker.vbs` 已改名 `.disabled`

## 把微信图片发给 GPT

用户要求「把这张图/这些图发给 GPT」「让 GPT 看图」时，使用微信消息附件提供的真实本地图片路径，将原话和图片放进同一次 ask。重复 --image 可提交多张图片；不要把文件路径仅写进问题文本，GPT 网页读不到本机路径。

```powershell
& 'C:\Users\duang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'D:\GPTtalkwithmeforDSH\relay\relay.mjs' ask '用户的问题' --image '第一张图片的绝对路径' --image '第二张图片的绝对路径' --wait 0
```

- 保留原有 DSH_SESSION_ID 与当前工作区，不新建无关会话。
- 可只提供图片，默认问题为「请分析这些图片。」；有用户原话时使用原话。
- 支持 PNG/JPEG/WebP，每次最多 4 张，单张最多 10 MiB，总计最多 20 MiB。
- 现有微信插件会把附件保存到会话工作区并交给 agent。使用本次消息给出的路径；缺少路径时定位本次附件，不猜路径、不随意选旧图；仍未取得时明确说明。
- 上传失败时不要自动改为仅发文字，不重新绘图，也不要自动重试整个 ask，以免重复提问。
- 新版 worker 和扩展都需加载。错误提示旧 worker 时先排查服务版本；任务一直 queued 时检查扩展是否重载。
- 微信插件不用修改；本节只规定中转 CLI 的调用方式，不改变普通微信聊天行为。

## 截图投递状态与浏览器操作（2026-11-01 更新，优先于旧的截图说明）

- 每次成功回答都应发截图，短回答和带原图的回答也不例外。截图在网页侧最多尝试 4 次，不重新提交问题、不重画答案。
- status=done 只表示 GPT 答案已生成，不表示截图已发送。只有 /status 的 delivery.screenshotSent=true 才能告诉用户截图发送器已确认投递；delivery.status=pending 时继续等，partial/failed 或 screenshotSent=false 时如实说明截图未送达。
- 任务总体 done 但 meta.screenshotError 有值时，也需要说明截图失败，不能说“原文和截图都在”。图片是否存在与截图是否成功是两件事。
- 排查中转仅使用 relay.mjs health/status/log/dump/probe，以及读取已有日志/答案文件。不要右键“检查”、按 F12、Ctrl+Shift+I/J/C，不在 DevTools Console 输入内容，不通过浏览器开发者工具补发问题或手工截图。
- 出现 debugger-busy 表示页面已被其他调试器占用。不要通过快捷键盲目切换 DevTools；它可能把本来关闭的面板打开。报告准确原因，不连续重复提交 ask。
- 用户询问截图时，先查看该任务的 delivery.screenshotFile、screenshotSent、screenshotError 和 meta.screenshotDetail。有已保存的截图且用户明确要求补发时，可使用现有微信发送工具补发这个文件；不要另开检查面板临时制作截图。
- 微信用户看不到电脑屏幕和路径。回复用简短文字说明结果或失败原因，不能让用户去打开本机文件路径。

## 图片慢加载与继续原任务（2026-11-01 更新，优先于旧故障处理）

- 图片只随用户原问题提交一次，重复 --image 支持多图。必须保留原任务 id 和当前 DSH_SESSION_ID；不要为了上传失败切换/新建 DSH 会话。
- CLI 等待结束不等于任务失败。status=queued/running、phase=uploading 时只查询原任务 status，不再次 ask，不添加 --new，不打开新 GPT 对话。
- 上传自动等待最多 240 秒。就绪后自动发送；超过等待窗口则 status=paused，保留同一页面的原问题和附件，不清空草稿。
- 用户说「图片加载好了」「继续发」「现在好了」时，先查询原任务状态。若 paused 且 resumable=true，执行下面的 resume 原任务命令；若仍在运行只等待。绝不能把这句话作为新的问题或重新上传图片。
- 继续命令：C:\Users\duang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe D:\GPTtalkwithmeforDSH\relay\relay.mjs resume <原任务id> --wait 90
- resume 只在原标签页、原 URL、同一任务草稿上继续，不重新输入/上传，不自动切页。文字或附件变化、已经尝试发送、任务过期或不存在时都停止；不要绕过检查重新 ask。
- image-send-unconfirmed 表示已经点击过发送但未确认，不能再次点击、按 Enter、重新 ask 或新建对话来重试。先核对原页面/原任务是否已有回答，避免重复消息。
- 遇到暂停不要自动重启 worker、重载扩展或刷新网页；这会丢失内存任务或网页附件。worker 重启后旧任务不能直接 resume，必须如实说明，不能伪造恢复成功。
- 禁止用延长超时、修改源码/配置、反复重启、检查面板、切换会话作为自动补救循环。保留状态并准确报告具体问题。
- 升级后 health.capabilities.uploadResume=1 表示新版 worker；lastTabSeen.uploadResume=true 表示扩展已加载新协议。两者都就绪后再执行新的图片任务。

## 截图必须对应原任务的问题（2026-11-01 修复补充）

- 用原任务 id 查询 delivery.screenshotFile；不得拿最近修改的文件、上一任务的截图、当前浏览器画面充当本次回答截图。
- 新版成功结果在 meta.answerBinding 记录 questionKey 与 answerKey，revision=question-bound-v1。必须核对原任务和对应关系；旧结果缺少绑定信息时不能猜测。
- no-answer、answer-binding-lost、answer-anchor-lost 或 conversation-not-ready 都不能用历史答案兜底。不要为了取得截图重复 ask、加 --new 或改会话。
- 补截图只针对已确认的原问题与回答消息 id；不能凭“页面最后一条”判断。没法确定时明确说明尚未取得本次截图，不发旧图顶替。
- conversation-not-ready 表示原对话尚未加载完。图片任务 paused 时待原页面加载完成后按原 id resume；文字草稿保留，停止自动重提。

## 超长回答连续多张截图（capture-pages-v4）

- 截图会沿同一回答从头到尾连续生成，单张最长约 25,000 实际像素；其余部分接着生成下一张，最后一张可以较短。多张均由中转按 1/N、2/N 顺序发送，不要仅取第一张。
- delivery.screenshotFiles 是有序文件列表，delivery.screenshotPages 记录每张 index/file/sent/error。旧字段 screenshotFile 仅指第一张，不能据此认定整条回答只有一张图。
- 只有 screenshotSent=true 才代表所有截图页均经发送器确认。screenshotsSent/screenshotCount 分别表示成功数/总数；部分失败需准确说明页码，不重新 ask。
- 用户明确要求补发时，仅按原任务 screenshotPages 补发指定或失败页；不要拿其他任务文件替代，也不要把前几张发送成功说成全部完成。silent 任务仅保存，不表示微信已发送。
- 后台 health.capabilities.screenshotPages=1、截图元数据 revision=capture-pages-v4 表示本次升级已生效。不要通过缩小字号、改视口或重绘内容来压缩超长回答。
