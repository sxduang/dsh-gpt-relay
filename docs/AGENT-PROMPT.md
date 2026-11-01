# 给 DSH agent 的安装／排障提示词

把下面整段复制给新机器上的 DSH（也可以放进那个工作区的 `AGENTS.md`，或直接当一条消息发过去）。
它是写给 agent 看的操作手册：步骤、判定标准、失败对照表都在里面。

---

```text
请帮我装并跑通 dsh-gpt-relay：我要在微信里说「问GPT：…」，就能拿到我 ChatGPT
网页版的回答文字和整段截图。你负责装、配对、验证，失败时按下面的对照表处理，
不要自己发挥。

【安装】
1. 在 DSH 的「插件」页 →「添加插件」，输入包名 dsh-gpt-relay，点安装。
   （不要用 npm install 手工装：那样不会写进 dsh.profile.bundles。）
2. 装完必须重启 DSH，否则工具不会出现。
3. 重启后确认工具已注册：调用 gpt_relay_health。它应该返回 worker 端口、
   capabilities（imageUpload / uploadResume / screenshotPages）、以及
   extension.lastTabSeen。

【装 Chrome 扩展】
4. 调用 gpt_relay_pairing，它会给你两个东西：扩展目录（形如
   %USERPROFILE%\.dsh\gpt-relay\extension）和配对码（127.0.0.1:端口#令牌）。
5. 让用户打开 chrome://extensions → 右上角开「开发者模式」→「加载已解压的扩展程序」
   → 选中第 4 步的目录。
6. 让用户在同一个 Chrome 里打开 https://chatgpt.com 并确认已登录。
   扩展只在这个站点工作；不需要手动填配对码（目录里的副本已经写好本机端口和令牌）。

【验证】
7. 等 10 秒再调用 gpt_relay_health，看 extension.lastTabSeen.at 是不是刚刚：
   是 → 通了；是「从未」或很旧 → 让用户在 chrome://extensions 点一下扩展的刷新，
   再回 ChatGPT 页面按 F5，然后重试第 7 步。
8. 试跑一句：gpt_relay_ask("用一句话介绍你自己，20 字以内", newChat: true)。
   正常 10–60 秒完成；答案和截图由 worker 直接推微信，你不要复述、不要补图。

【失败对照表】
- extension.lastTabSeen 一直为空 → 扩展没加载 / 没有 chatgpt.com 标签页 / 标签页没登录。
- no-composer / type-failed → ChatGPT 页面改版了。跑 node relay/relay.mjs dump 看结构，
  改 %USERPROFILE%\.dsh\gpt-relay\config.json 的 selectors，然后重启 DSH。不要改代码。
- answer-binding-lost → 页面被切到了别的对话（用户中途换了对话或重开了标签页）。
  告诉用户回到原来那个对话重问；不要重试同一条。
- no-answer 且 detail 里 textMatches:false → 页面没渲染出这次的问题（发送其实没成功）。
  让用户看一眼页面；不要手动去点发送。
- composer-busy → 输入框里有没发出去的内容，detail 里带着前 40 个字。
  告诉用户清空后再问，不要替用户清空。
- capture-raster-timeout → 截图时标签页在后台/最小化。插件会自动切前台重试一次；
  仍失败就让用户恢复窗口再问。文字部分通常已经送达，别重复投递。
- paused（图片上传超时）→ 保留着草稿。用户说「继续」时调用 gpt_relay_resume(id)，
  绝对不要重新 ask，否则会重复发图。
- 微信没收到、但 status 是 done → 看 delivery.screenshotSent 和 delivery.wechatError：
  no-wechat-conversation-bound = 这台机器没装 dsh-wechat-plugin 或还没绑定对话（先让用户
  在微信里给机器人发一句话）；wechat-window-closed = 这个回复窗口的 10 条用完了，
  用户下次发消息会自动补发，不要重试。
- 工具根本没出现 → 插件没进 bundles，或装完没重启 DSH。

【不要做】
- 不要重启 worker 进程：它跑在 DSH 主进程里，重启 DSH 就是重启它；队列在内存里，重启会丢任务。
- 不要手改 %USERPROFILE%\.dsh\gpt-relay\extension 里的文件：那是每次启动重新生成的副本，
  改了会在下次启动被覆盖（旧文件会留 .bak）。要改就改仓库源码再重建。
- 不要用 F12 / DevTools 手动补发消息或补截图。
- 不要因为"微信里只有文字"就说 GPT 没配图，更不要自己画图补上。
- 不要把令牌、配对码原文贴进聊天记录或日志。
```

## 这份提示词覆盖的坑

| 坑 | 提示词里的对策 |
| --- | --- |
| 用 `npm install` 手工装，`bundles` 没更新，工具不出现 | 只走「添加插件」对话框 |
| 装完没重启 DSH，以为装失败 | 明确写了必须先重启 |
| 扩展加载了但没打开 chatgpt.com，`lastTabSeen` 一直空 | 第 6 步 + 第 7 步的判定标准 |
| 把「答案已生成但没认出来」当成「GPT 没回答」 | `no-answer` 分两种情况给出不同处理 |
| 绑定失效后干等 5 分钟 | 新版立即返回 `answer-binding-lost` |
| 图片上传超时后重新 ask，导致重复发图 | 只允许 `gpt_relay_resume` |
| 微信没收到就反复重试，把回复窗口刷爆 | 按 `wechatError` 区分“没绑定”和“窗口用完” |
| 手改生成出来的扩展副本，重启就丢 | 明确“改了会被覆盖” |
| agent 自作主张补图、补发 | 写进【不要做】 |
