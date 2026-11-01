# dsh-gpt-relay

[![ci](https://github.com/sxduang/dsh-gpt-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/sxduang/dsh-gpt-relay/actions/workflows/ci.yml)

在 DeepSeek Harness 里说一句「问GPT：……」，它会借用**你自己已登录的 Chrome** 打开 ChatGPT 网页版提问，把答案（文字 + 整段回答截图）推回微信，并把要点交还给 agent。

它不调用 OpenAI API，不需要 API key，也不保存你的 ChatGPT 账号密码——只是替你操作那个已经登录的标签页。

```
微信「问GPT：…」
      │
      ▼
DSH agent ── 工具 gpt_relay_ask ──▶ 本机 worker（127.0.0.1，仅本机可访问）
                                        │  HTTP 轮询
                                        ▼
                              Chrome 扩展（只在 chatgpt.com 生效）
                                        │
                                        ▼
                             你已登录的 ChatGPT 网页 → 回答 + 截图
                                        │
                                        ▼
                             答案落盘 →（可选）dsh-wechat-plugin 推微信
```

## 前置条件

| 需要 | 说明 |
| --- | --- |
| DeepSeek Harness | 插件装进某个 profile（默认 `desktop`） |
| Node.js ≥ 24 | DSH 自带的运行时即可 |
| Chrome + 已登录的 ChatGPT | 免费版可用；页面语言中文或英文都可 |
| dsh-wechat-plugin | **可选**。装了才会把答案推微信并回你；没装则只回给 agent |
| 能访问 chatgpt.com | 需要代理时先开好代理 |
| 能访问 npm registry | 默认从 npm 安装；界面里可切「中国大陆镜像源」。若改走 GitHub 安装，则需要能访问 `codeload.github.com` |

## 安装

### 1. 装插件

打开 DSH →「插件」页 →「添加插件」，在输入框里填：

```
dsh-gpt-relay
```

安装源保持默认即可（选「中国大陆镜像源」更快），点「安装」。装完包名会自动出现在这个 profile 的 `dsh.profile.bundles` 里，**不用手改 `package.json`**。

> 这一步用的是 pnpm（DSH 自带）。实测 4.2 秒装完 `0.1.0`。

不用界面、想走命令行的话（等价于上面那步，`dsh` 在 `DSH 安装目录\resources\runtime\cli\bin\dsh.cmd`）：

```powershell
dsh plugin add dsh-gpt-relay
```

`dsh plugin` 会把参数原样转给 pnpm，也会把包名写进 `bundles`。**不要**用 `npm install` 手动装——那样 `bundles` 不会更新，插件不会加载。

#### 装不上 npm 的备选

同样贴在「添加插件」的输入框里：

| 情况 | 填什么 |
| --- | --- |
| 想跟仓库最新代码 | `github:sxduang/dsh-gpt-relay`（本机要有 git） |
| 机器上没有 git | `https://codeload.github.com/sxduang/dsh-gpt-relay/tar.gz/refs/heads/master#v.tar.gz` |
| 已经下到本地 | 目录绝对路径，如 `D:\code\dsh-gpt-relay` |

- 第二行末尾的 `#v.tar.gz` 不是 GitHub 的路径，是骗过界面后缀检查用的（对话框只收以 `.tar.gz`/`.tgz` 结尾的地址），pnpm 下载时会忽略它。
- 这两种都跟着 `master` 走，更新时要先卸载再装；npm 包名那种可以直接升级。
- 「安装源」那个下拉只对 npm 包名生效，对 Git 地址和压缩包无效。

### 2. 重启 DSH

插件在宿主进程内启动 worker（默认 `127.0.0.1:8123`，被占用会自动顺延到下一个端口），并生成运行时配置：

```
%USERPROFILE%\.dsh\gpt-relay\config.json      # 端口、令牌、微信 CLI 路径……
%USERPROFILE%\.dsh\gpt-relay\extension\        # 已写入本机端口和令牌的扩展副本
%USERPROFILE%\.dsh\gpt-relay\sessions\<id>\    # 每个 DSH 对话一个目录：answer.md、journal.md、media/
```

### 3. 装 Chrome 扩展

让 agent 调用工具 `gpt_relay_pairing`，它会告诉你**扩展目录**（就是上面那个 `extension` 副本）。

1. 打开 `chrome://extensions`，右上角打开「开发者模式」；
2. 「加载已解压的扩展程序」→ 选中该目录；
3. 打开一个 `https://chatgpt.com` 标签页并保持登录（扩展只会在这个站点工作）。

扩展里已经写好了端口和令牌，**通常不需要手动配对**。换机器、换端口或重装时才需要：点扩展的「选项」，粘贴 `gpt_relay_pairing` 给出的配对码（形如 `127.0.0.1:8123#<32位令牌>`），保存后刷新 ChatGPT 标签页。

### 4. 试一句

在微信里对 agent 说：

> 问GPT：用一句话介绍你自己，20 字以内。

### 5. 装不上？让 DSH 自己装

不想一步步手动装，可以把 [`docs/AGENT-PROMPT.md`](docs/AGENT-PROMPT.md) 里那段提示词整段发给 DSH：它按步骤装、配对、验证，常见失败（扩展没连上、页面改版、绑定失效、微信没收到）都有对照处理。也可以存进你那个工作区的 `AGENTS.md`，以后就不用再解释。

## 使用

| 你说 | 发生什么 |
| --- | --- |
| 「问GPT：…」/「转给GPT」/「让GPT看看…」 | agent 调用 `gpt_relay_ask`，答案与截图由 worker 直接推微信 |
| 「继续」 | 若任务因图片上传超时暂停，用 `gpt_relay_resume` 续跑，**不会**重新提问 |
| 「GPT 那边好了吗」 | `gpt_relay_status` 查状态 |
| 「中转正常吗」 | `gpt_relay_health` 看 worker、扩展连接、能力 |

给 GPT 带图：

```bash
node relay/relay.mjs ask "看看这两张图" --image D:\data\a.png --image D:\data\b.png
```

CLI 与工具等价，工具里用 `images: ["D:\\data\\a.png"]`（最多 4 张，单张 ≤10 MiB，PNG/JPEG/WebP）。

### 绑定关系

- **一个 DSH 对话 ↔ 一个 ChatGPT 对话**：首次提问时新开，之后复用（`threads.json`）。
- 想换上下文：在 DSH 里 `/new` 开新对话，或 `gpt_relay_ask` 传 `newChat: true`。
- 提问只会在该对话的**第一条**附带工作区背景（`README.md` 或 `.gpt-relay/brief.md` + 目录列表），之后不再重复。

## 配置

`%USERPROFILE%\.dsh\gpt-relay\config.json`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `port` | `8123` | worker 端口，被占用会自动换 |
| `token` | 随机 32 位 | 扩展访问 worker 的令牌 |
| `node` | 当前进程 | 调微信 CLI 用的 node |
| `wechatCli` | 自动探测 | `dsh-wechat-plugin/cli.js` 路径；空 = 不推微信 |
| `dshHome` | `~/.dsh` | DSH 根目录 |
| `jobTimeoutSec` | `600` | 单任务超时 |
| `chunkChars` | `1400` | 微信文字分片长度 |
| `queueHintSec` | `45` | 无人领取多久后提醒 |
| `selectors` | 见文件 | 页面选择器；ChatGPT 改版时改这里 |

也可以在 `cordis.patch.yml` 里覆盖：`- id: gpt-relay` + `config: { port: 9000 }`。

## 隐私与安全

- worker 只监听 `127.0.0.1`，所有请求都要带令牌。
- 问答内容只经过你自己的浏览器和你自己的 ChatGPT 账号；插件不上传任何东西到第三方服务器。
- 扩展权限：`debugger`（只为给回答截图）、`storage`（存配对信息）、`https://chatgpt.com/*` 与 `http://127.0.0.1/*`。
- 答案与会话映射保存在本机 `.dsh/gpt-relay/`，删掉即清理。

## 已知限制

- **只支持 ChatGPT 网页版**，且依赖当前页面结构；改版后改 `selectors` 即可，不用改代码。
- 自动化操作网页可能违反 OpenAI 的服务条款，风险自负；不要用它刷量。
- 免费账号有额度限制（尤其图像生成）。
- 同一时刻只处理一个任务，其余排队。
- 截图时会把 ChatGPT 标签页切到前台（后台标签页不出帧，截不到），期间会短暂抢焦点。
- 生成的画布（canvas）类回答无法截图，会明确报错而不是发半张图。
- `%USERPROFILE%\.dsh\gpt-relay\extension\` 是**每次启动重新生成的副本**：手改会在下次启动被覆盖（旧文件留成 `.edited-<时间>.bak`，日志里会写一句）。要改扩展请改仓库里的 `extension/src/**` 再 `node scripts/build-extension.mjs`。
- 一个 DSH 对话只对应一个 ChatGPT 对话；你在网页里手动切到别的对话，这一条就会以 `answer-binding-lost` 结束，而不是猜。
- 扩展的 `manifest.version` 跟 npm 包版本一致（构建时写入），所以「装的是哪个版本」看插件版本即可。

## 故障排查

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| `gpt_relay_health` 里「扩展最近连接：从未」 | 扩展是否已加载、ChatGPT 标签页是否开着 | 重载扩展 + F5 |
| 任务 `queued` 一直不动 | 标签页是否被关掉/睡死 | 打开标签页，等 20 秒 |
| `no-composer` / `type-failed` | 页面改版 | 跑 `node relay/relay.mjs dump` 看结构，改 `config.selectors`，重启 DSH |
| 截图失败 | `screenshotError` 的具体码 | 见 `docs/DESIGN.md` 的截图一节 |
| 截图 `capture-raster-timeout` | ChatGPT 标签页是否在后台、窗口是否最小化 | 插件会先把标签页切前台并重试一次；仍失败就恢复窗口再问 |
| 答案已生成却报 `no-answer` | `meta.answerBinding` 里有没有 `questionKey` | 旧版拿整段 prompt 和页面气泡做严格相等；新版改用问题原文做锚点，并在 detail 里附诊断 JSON |
| 报 `answer-binding-lost` | 用户是否在网页里换了对话 | 新对话提交后 URL 会从 `/` 变成 `/c/<id>`，这不算换对话；真换了就在原来那个对话重问 |
| 报 `composer-busy` | detail 里的 `text`（前 40 字）和附件数 | 输入框里有没发出去的内容，插件不会替你清空；让用户自己清 |
| 报 `paused` | 是否在传图 | 用户说「继续」时用 `gpt_relay_resume`，**不要**重新 `ask`（会重复发图） |
| 微信没收到 | `delivery.wechatError.reason` | `no-wechat-conversation-bound` = 微信插件没绑定对话；`wechat-window-closed` = 本轮 10 条用完，下次发消息会自动补发 |
| 微信没收到 | 是否装了 `dsh-wechat-plugin` | 没装时答案只回 agent |

排查开关：`node relay/relay.mjs health | status <id> | log 30 | dump | probe`。

## 开发

```bash
node scripts/check.mjs       # 语法 + 扩展产物一致性 + 全部测试
node scripts/build-extension.mjs          # 重建 extension/*.js（本地，含令牌）
node scripts/build-extension.mjs --public # 发布用：令牌留空
node --test tests/*.test.mjs
```

`scripts/` 和 `tests/` 现在随 npm 包装——从 npm 装上之后可以直接在 `node_modules/dsh-gpt-relay`
里跑上面这些命令（`npm run check` / `npm run build:public`），不用另外 clone 仓库。

- `extension/src/**` 是扩展源码，`extension/{background.js,content.js,manifest.json,options.*}` 是**构建产物**，不要手改。
- `relay/` 是 worker 与命令行；`lib/index.js` 是 DSH 插件入口。
- 设计说明见 [`docs/DESIGN.md`](docs/DESIGN.md)，重构记录见 [`docs/REFACTOR.md`](docs/REFACTOR.md)。

## 发布

发布由 CI 完成，不要在本地手工 `npm publish`。

1. 改 `package.json` 的 `version`，提交并推送。
2. 打标签并推送：`git tag v0.1.1 && git push origin v0.1.1`。
3. `.github/workflows/release.yml` 会校验「标签 = v + version」，重跑一遍检查，然后 `npm publish --provenance --access public`，并创建同名 GitHub Release。

一次性准备：在 npm 注册账号（建议开启 2FA），创建 **Granular Access Token**：权限选 `Read and write (publish and stage)` + `All packages`，并勾上 **Bypass two-factor authentication (2FA)**（账号开了 2FA 却不勾，发布会报 `403 ... bypass 2fa enabled is required`）。把令牌存到仓库 `Settings → Secrets and variables → Actions`，名字必须是 `NPM_TOKEN`；没有这个 secret 时发布任务会直接报错退出。

`npm publish` / `npm pack` 会自动跑 `prepack`（`--public` 构建，扩展内令牌为空），结束后 `postpack` 还原本地构建。手工打包时请确认 `extension/background.js` 里的 `"token":""`，避免把自己的令牌带出去。

发布产物自带 [provenance](https://docs.npmjs.com/generating-provenance-statements)：npm 页面上会显示「Built and signed on GitHub Actions」，证明包确实由这个仓库的这次提交构建。

## License

MIT
