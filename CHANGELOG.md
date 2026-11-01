# Changelog

## 0.1.1 — 2026-11-02

这一版主要修外部用户（第二台机器）实际踩到的问题。来源：issue 报告
`gpt-relay-issues-report.md`（DSH 0.2.1-rc.2 / Chrome 156 / Windows 11）。

### 修复

- **新对话首问必然失败**：发送后页面 URL 从 `chatgpt.com/` 变成 `/c/<id>`，旧代码比较整条 URL，
  绑定当场作废，5 分钟后报 `no-answer`（答案其实早就生成了）。现在只比较会话 id，并允许
  「新对话提交 id」这一次变化；复用已有对话的路径不受影响。
- **绑定失效后干等 5 分钟**：切到别的对话会立刻返回 `answer-binding-lost`，不再耗尽超时。
- **`composer-busy` 不说清原因**：现在附带草稿前 40 字与附件数，用户知道要清什么。
- **`no-answer` 文案误导**：改为「没有认出属于本次提问的回答（不代表 GPT 没回答）」，并附
  诊断 JSON（URL、会话 id、候选计数、匹配失败在哪一步）。
- **CLI 找不到配置**：装上 npm 包后包内没有 `relay/config.json`，`relay.mjs` 直接
  `ENOENT`。现在依次查找 `GPT_RELAY_CONFIG` → 包内 `relay/config.json` →
  `~/.dsh/gpt-relay/config.json`。
- **扩展副本被无条件覆盖**：用户手改 `~/.dsh/gpt-relay/extension` 后，重启即丢且无提示。
  现在按 sha256 比对只写变化的文件；发现自己写的那份被改过，先备份成
  `<文件名>.edited-<时间戳>.bak` 再覆盖，并在日志里说明。
- **发布包缺 `scripts/`**：装上之后没法重建扩展。`scripts/` 与 `tests/` 现在随包发布，
  `npm run check` / `npm run build:public` 在安装目录里就能跑。
- **扩展版本与包版本不一致**（包 0.1.0 / 扩展 0.2.0）：构建时把 `package.json` 的 version
  写进 `manifest.version`。
- **微信退出码只透传数字**：现在每条失败都带 `reason`
  （`no-wechat-conversation-bound` / `wechat-window-closed` / `wechat-send-failed`）与
  `stderr` 摘要，`status` 会翻成中文提示；不再出现「只看到一个 2」的困惑。

### 新增

- `docs/AGENT-PROMPT.md`：给 DSH agent 的安装／排障提示词（含失败对照表与「不要做」清单），
  README 的「装不上？让 DSH 自己装」指向它。
- 回归测试：新对话 URL 提交不失效、切走立刻失效、扩展副本备份、配置路径解析、微信原因映射。
  测试总数 102。

## 0.1.0 — 2026-11-01

首个公开版本：DSH 插件 + 本机 worker + Chrome 扩展，在微信里说「问GPT：…」即可拿到
ChatGPT 网页版的回答文字与整段截图，支持图片上传、长回答分页截图、断点续传。
