# AI Live Commerce 0.2.1 修复说明：macOS 启动 / React #185

## 已核实的根因

- 0.2.0 的首页 src/pages/LiveWorkbench/index.tsx 使用不稳定的 Zustand selector: useCommerceMetrics(s => s.accounts[accountId] ?? [])。账号没有统计数据时会在渲染中生成新数组，可能造成 React #185。
- 0.2.0 的 macOS GitHub Actions 构建日志明确显示 skipped macOS application code signing: cannot find valid Developer ID Application identity。DMG 文件生成成功不能证明应用能正常启动。

## 0.2.1 修复及验证

1. 首页订阅稳定的 accounts 对象，无统计记录时使用模块级常量 EMPTY_METRICS。
2. macOS 测试安装包明确使用 ad-hoc 签名（electron-builder v26 在 afterPack 生命周期使用系统 codesign，对完整 .app 执行 --deep --force --sign -），增加必要的 JIT 和 library validation 权限。
3. CI 在 macOS runner 上用 codesign --verify --deep --strict 核对 x64 与 arm64 应用，以及挂载后的 DMG 中的应用。出现签名不一致即构建失败。
4. CI 使用真实 Chromium 渲染编译后的首页，自动模拟 Electron IPC，覆盖首次启动、无统计账号、添加商品、打开高级设置抽屉，捕获浏览器运行时错误。
5. 新增单元测试防止重新引入不稳定的 Zustand selector，版本号提升至 0.2.1，保持用户原有配置。

## 发布限制

本版本不是 Apple Developer ID 正式签名或公证版。Ad-hoc 签名可用于开发与本地测试，但 Gatekeeper 仍可能提示或阻止下载的应用。企业正式分发需要证书和 Apple notarization，不能靠禁用系统安全功能代替。

## 本地回归

- 退出旧版，下载对应架构的 0.2.1 DMG（Apple Silicon 选 arm64）。
- 完全替换应用程序目录中的 AI Live Commerce.app，避免点到旧包。首次打开如遇 macOS 安全提醒，可参考系统设置→隐私与安全中的官方允许打开流程。
- 看到深色双栏主控台而非 React Router 白屏；新增商品、填写讲品文案、打开高级设置并切换不同分类。
- Chromium 自动化、签名完整性检查均无法完全替代最终 Mac 实机验收。

本文依据用户提供的启动错误摘录与 GitHub 构建日志；用户 Mac 的完整诊断 TXT 没有附在本次对话中，其他日志尚未核对。
