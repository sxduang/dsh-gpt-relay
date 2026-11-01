# 扩展源码与构建

Chrome 继续加载此目录中的 `manifest.json`、`background.js` 和 `content.js`。这三个文件由构建脚本生成并随项目保存；编辑 `src/` 中的源码后重新构建即可，无需安装 npm 依赖。

```powershell
$node = 'C:\Users\duang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node scripts/build-extension.mjs
& $node scripts/build-extension.mjs --check
& $node --test tests/extension.test.mjs
```

在项目根目录执行。`--check` 只比较输出是否与当前源码和配置一致，不写文件。

| 源码 | 职责 |
| --- | --- |
| `src/content/shared.mjs` | 原有选择器默认值、等待时间、共享 WeakSet |
| `src/content/ui.mjs` | 定位输入框、按钮和回答节点 |
| `src/content/typing.mjs` | 输入、清空、发送与滚到底部 |
| `src/content/overlays.mjs` | 原有弹窗关闭和选择逻辑 |
| `src/content/wait-answer.mjs` | 判断回答开始、稳定和超时 |
| `src/content/extract.mjs` | Markdown、表格和富内容计数 |
| `src/content/images.mjs` | 图片读取与已有图片任务 |
| `src/content/capture.mjs` | 页面侧截图请求 |
| `src/content/diagnostics.mjs` | 结构化 probe、dump |
| `src/content/ask.mjs` | 提问和 dryrun 编排 |
| `src/content/transport.mjs` | 结果回传 |
| `src/content/runtime.mjs` | 轮询、任务分派、导航恢复 |
| `src/background/http.mjs` | HTTP 请求与等待工具 |
| `src/background/capture.mjs` | 保留原算法的 CDP 拼接截图 |
| `src/background/messages.mjs` | 后台消息路由 |
| `src/manifest.json` | 清单模板；本机地址由配置生成 |

源码使用显式 ESM 命名导入与导出。`scripts/build-extension.mjs` 仅支持本项目使用的命名导入、函数及变量导出；按依赖顺序将每个模块置于独立函数作用域中，输出普通脚本。缺失导出、循环依赖、越界导入或不支持的模块语法会使构建失败。没有新增扩展权限，也没有加入运行期动态求值。

端口和 token 的唯一人工配置位置是 `relay/config.json`。构建时将其写入后台入口，并同步生成本机 `host_permissions`；修改这两项后需要重新构建、重启 worker、在 Chrome 中重新加载扩展。页面选择器仍随任务下发，修改选择器只需重启 worker。

此次拆分保留截图算法、超时、页面选择器兜底、弹窗选择、图片过滤、导航续跑和轮询行为。离线测试使用模拟 DOM、CDP 和 Canvas，覆盖隐藏副本、裁切、不能滚动时防止重复截图、异常清理及任务导航；不代表已通过真实 ChatGPT 页面长回答的端到端验证。

后续截图优化已调整拼接算法、留白和临时遮罩，详见 [截图优化说明](../docs/CAPTURE-IMPROVEMENTS.md)。上文保留原算法的说明指首轮结构重构。

当前截图主实现：src/background/native-capture.mjs；src/background/capture.mjs 仅保留兼容入口。定位由 src/content/answer-target.mjs 和节点唯一标记完成。截图不再滚动拼接。详见 [单次截图说明](../docs/CAPTURE-NATIVE.md)。真实 Chrome 测试默认使用系统 Chrome，可通过 RELAY_TEST_CHROME 指定测试浏览器路径。
