# v0.2.2 UI 与 Electron 启动问题修复验收

## 为什么 0.2.1 会报错
electron/main/ipc/media.ts 与 electron/main/ipc/inventory.ts 中的处理器已经实现，但 electron/main/ipc/index.ts 未调用 setupMediaIpcHandlers() 和 setupInventoryIpcHandlers()。因此真实安装版运行时请求 voiceCommerce:media:list 返回 No handler registered。普通 Chromium 的 mock IPC 页面测试无法检测此类错误。

## 本轮交付
1. 在 Electron 主进程注册全部素材库与库存 IPC 处理器，加入静态回归测试和真实 IPC 执行验证。
2. 默认首页使用深色高对比账号组件：账号选择、增加与重命名可以直接看清，不再调用旧白色 Select。
3. 开始按钮改为“开始直播”，但 UI 明确说明：此按钮启动 AI 直播助手、评论监听与语音播报；真正的平台开播/推流必须提前在抖音或直播伴侣完成。软件不假装支持未授权的推流。
4. 高级设置不再把完整老式白底页面嵌套进抽屉，而是独立、同风格的深色设置中心。分类包括商品与讲品、AI 互动、主播声音、画面与 OBS、库存同步、运营数据、更多工具。
5. 保留旧页面与数据，打开高级设置无需离开直播主页面。停止/紧急静音与设置保存分开控制。
6. 构建版本 v0.2.2，保证版本升级不清空账号、商品及声音素材。

## 强制验收
- pnpm test：必须通过 IPC 注册与 UI 契约测试。
- pnpm build：Windows / macOS arm64/x64 必须生成安装产物，macOS 进行 .app 与 DMG 内 ad-hoc 签名完整性校验。
- pnpm run test:smoke：Chromium 真实渲染新增账号、商品、主控台、高级设置全部七个分类页，不能出现 React #185。
- pnpm run test:electron：**真正启动打包后的 Electron**，验证 invoke('voiceCommerce:media:list','default') 返回数组而非 No handler registered，读取库存状态、主播声音引用、TTS 密钥状态，并点击设置中心不同页及新增商品。
- GitHub Actions 保留 macOS/Windows 截图用于检查交互布局。云端真实应用测试通过后仍需在公司的 Mac/Windows 设备及抖音账号实机复核。

## 仍未实现/未验证
- 直接在抖音官方平台创建直播/推流：此工具不具备平台开播权限。
- 未验证真实抖音直播评论与文字发送许可，以及商家的库存官方 API 授权。
- 本地机器的实际字体渲染、音频设备和 MiMo 付费接口仍需要授权数据的联调。
- macOS ad-hoc 签名不是 Apple Developer ID 正式证书和公证，首次运行可能仍提示安全确认。
