# AI 直播带货业务集成测试（v0.2.5 / test/business-end-to-end）

## 为什么需要这一组测试

旧 CI 主要验证 React 页面/安装包可运行和部分 IPC 读取，没有执行「真实评论事件→回复→语音」业务闭环，也没通过主进程验证 OBS、ERP 适配及 MiMo 音频请求。

## 测试内容与执行

### A. 测试生产 React 业务链路：pnpm run test:business

在生产 Vite 预览中运行真实 React hooks、Zustand 状态、直播助播调度，只有平台 IPC、LLM 响应和语音设备是可控模拟。
验证：连接和开始监听→商品循环讲解→关键词匹配但自动文字关闭时绝不发送→回复优先插播→恢复讲品→同 ID 弹幕防重→真实 AI 弹幕请求携带商品售价/库存/FAQ→停播后晚到 AI 不再回复→人工勾选许可打开文字发送后发一次并记录。

### B. 测试打包后的 Electron 业务接口：pnpm run test:business:native

在 Windows 和 macOS CI 启动真正的 Electron app，启动只监听 127.0.0.1 的假 OBS WebSocket v5 与假 ERP 库存 HTTP 服务，实际经 Electron IPC 验证：
- ERP 返回 SKU、价格、库存，防止请求未经允许的外网地址。
- OBS v5 握手、读取两个场景、列出媒体源、切换指定场景、暂停指定媒体，检查请求类型，不触发开播。
- 如果 CI 系统安全存储可用，保存临时测试 MiMo Key，将主进程网络 fetch 替换为本地假响应，实际验证官方端点、模型、音色、请求体和返回音频；结束后删除模拟密钥。

### C. 原有测试继续运行

Node 单元测试（CSV/库存 SKU/语音队列）、Playwright 主界面/设置布局、真实 Electron 基础 IPC、macOS DMG 签名检查。

## 结果边界

这些验证是**真实业务模块通过模拟外部服务完成的集成测试**，不是已获得抖音/巨量百应登录许可或实际发送权限。真实直播评论、付费 DeepSeek/MiMo 账户、虚拟声卡路由、OBS 桌面程序、视频源和长期直播稳定性仍须用户设备端到端验收。

如果任何测试失败，不要将此分支合并到 main。每次修复都记录具体失败步骤和验证结果。
