# 向 GPT 发送图片

2026-11-01。代码位置：<repo>。

## 使用方式

在微信发送图片，并告诉 DSH「把这些图发给 GPT，帮我比较一下」。DSH 应使用微信附件的真实本地路径，将问题和图片放入同一次命令；本项目 AGENTS.md 已补充调用约定。现有微信插件的 README 确认附件会保存进会话工作区并交给 agent，无需修改插件。

```powershell
$relayNode = '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $relayNode '<repo>\relay\relay.mjs' ask '比较这两张图片' --image 'D:\images\第一张.png' --image 'D:\images\第二张.jpg' --wait 0
```

支持文字加图片，或只传图片（默认问题「请分析这些图片。」）。支持 PNG、JPEG、WebP；中转自身限制为最多 4 张、单张 10 MiB、总计 20 MiB。此限制不代表 ChatGPT 账号额度或网页限制。

## 生效

等待现有任务结束后，重启 worker，在 chrome://extensions 重载 GPT Relay Bridge，再刷新 ChatGPT 页面。DSH 下一次转图时应读取项目更新后的 AGENTS.md；已缓存旧约定的会话可直接告知它用 ask --image 的新用法。CLI 图片请求会先检查 worker 能力，旧 worker 会明确报错；旧扩展无法领取图片任务，不会把图片任务误当成纯文字发送。

## 实现

- CLI 增加可重复的 --image 参数，读取本地文件并验证真实文件头，不仅依赖扩展名。
- 纯文字请求仍使用原来的 text/plain。图片请求使用 JSON：question 与 images[{name,data}]，data 为 base64。
- worker 验证数量、大小、类型后入队。任务下发和 sessionStorage 仅保存附件元数据，避免多图占满导航恢复空间。
- 扩展通过带 token 的 /attachment?id=...&index=... 按需取图片；只允许读取 running 任务附件。完成、失败、超时后释放内存里的原图字节。
- 网页端使用文件输入框，或在输入区粘贴图片 File。等待所有预览出现、上传进度消失、发送按钮启用且状态稳定后再发送。
- 上传失败、缺少预览、已有草稿附件或发送状态无法确认时停止；不降级成纯文字，也不自动重发整条图片消息。失败时已填入的草稿留在网页供查看，清理后再试。
- 新增 relay/core/attachments.mjs、extension/src/content/attachments.mjs；同时更新 CLI、任务协议、后台消息路由与测试。

## 验证边界

自动化测试覆盖两图一次提交、中文和空格路径、格式及大小校验、鉴权、旧版本保护、导航元数据、上传等待与失败、已有附件保护和原有截图回归。所有网络投递测试使用模拟接口，未发送真实微信或向真实 ChatGPT 提交测试图片。

网页附件结构属于外部依赖：若当前页面的预览或进度标记不匹配，会报 image-upload-failed 并停止发送，需要结合页面诊断调整选择器。真实微信 → DSH → ChatGPT 图片验收尚待重启并重载后的实测。
