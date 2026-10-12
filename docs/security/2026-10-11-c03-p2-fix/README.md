# C03 审查项 R1 / P2 修复与验证

日期：2026-10-11。状态：代码修复完成，相关回归验证通过。

已修复跨站 iframe 加载后，主页面正常导航被误判为 `browser_guard_lost` 的问题。变更位于 `src/utils/browserNetworkPolicy.ts`；同步更新网络策略单测、真实浏览器集成测试和受控浏览器 mock，未修改其他生产源码。

原逻辑只要在子 CDP session 脱离后仍能查询到 target，就关闭整个任务。但正常主导航中，旧 target 可能暂时存活，不能据此判断它仍属于当前文档。

修复为每个子守卫记录附着时的父文档 `loaderId`，并通过 Page 事件记录 iframe 真正移除。session 脱离后保留子记录直至核验完成，使晚于 detach 到达的 remove 事件仍然有效；查询父文档当前标识，以识别正常文档切换。`swap` 事件不等于移除，不作为忽略守卫丢失的依据。

父文档未切换、iframe 未移除且 target 仍存活时，继续终止整个任务。文档信息查询失败、身份信息缺失或根 frame 不匹配，也终止任务。初始化中发生的 detach 由同一生命周期核验流程处理，避免正常导航产生重复的初始化失败判定。

验证环境为 Node.js v22.23.3、Playwright 1.62.1、Chromium 154.0.8037.98。构建、7 个相关测试程序、原审查复现程序全部通过，没有 SKIP；`git diff --check` 通过。原复现程序的 12 个场景全部通过，包含各重复 3 次的主动主导航、脚本主导航和生产 HTML 抓取入口。

新增验证覆盖：

- 晚到的 frame remove 事件、父文档切换、iframe 改为同站或 about:blank、iframe 删除均允许任务继续使用。
- 活动子 target 意外脱离、仅发生 swap、生命周期查询失败或身份信息缺失均使任务失败，关闭 context 并拒绝后续 HTTP 放行。
- 在真实浏览器中主动解除活动 iframe 的实际 CDP 守卫连接，确认任务返回 `browser_guard_lost`、页面关闭、后续导航失败。
- 生产 HTML 抓取入口访问含跨站 iframe 的自动跳转页面，成功返回最终页面。
- 原有私网跳转、弹窗、WebSocket、worker、独立 context、MCP/HTTP daemon、取消和恶意求值超时用例继续通过。真实浏览器安全测试的私网 canary TCP 连接、HTTP 请求和 WebSocket 上游握手均为零。

证据：[验证汇总](./verification.json)、[真实浏览器测试](./test-browser-redirect-safety.log)、[原复现程序复测](./probe-frame-lifecycle.log)、[网络策略测试](./test-browser-network-policy.log)。原审查失败记录保留在 `docs/security/2026-10-11-c03-review`，未覆盖。

重跑方式（使用符合项目要求的 Node.js 版本）：

```sh
node docs/security/2026-10-11-c03-p2-fix/run-verification.mjs
```

本次关闭的是 R1/P2 代码审查项。C03 综合验收所需的目标容器网络隔离、远程浏览器实际出口及真实 Bing 兼容性证据仍按原部署文档跟踪，本次没有执行这些部署验收。
