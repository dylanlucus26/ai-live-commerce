# AI Live Commerce 二阶段：MiMo TTS + 语音讲品

本仓库 Fork 自 [oba-live-tool](https://github.com/qiutongxue/oba-live-tool)，保留 MIT LICENSE。

## 已实现

- Windows 系统语音、MiMo V2.5 云端音色二选一，不要求独立 GPU。
- MiMo API Key 仅在 Electron 主进程使用，借助 Windows/Electron safeStorage 加密保存，不会写入 GitHub 或浏览器 localStorage。
- MiMo 接口为固定的 \`https://api.xiaomimimo.com/v1/chat/completions\`，按官方协议用 assistant 文本 + audio/voice 合成 WAV。结果有 24 条内存 LRU 缓存。
- 新增音色、发声风格、播放设备选择（仅 MiMo 模式支持 setSinkId；以 Windows 实机为准）。
- **手动启动**商品自动讲解，可停止。实时新 AI 回复打断商品播报，处理完后继续讲品。
- 语音队列有最大长度、错误停播、账号切换停播、紧急停止。价格/库存/产品功效仅使用人工确认的知识库。
- 公司 MP3/WAV 录音与 MP4 视频可本地预览，但**不自动替代真人开播**。
- 文字发送继续使用原项目原有开关，默认不主动启用。浏览器自动化不是平台授权保证。

## 使用步骤

1. 在 Windows 下载 Actions 成功构建后的安装包，点击「AI 语音带货」。
2. 点击「新增商品」，填写名称、**真实**价格、库存说明和已核实卖点。
3. 进入原「自动回复」设置已有 DeepSeek 等 LLM 的 API Key；在本页输入模拟弹幕验证文字生成。
4. 在「云端 TTS 与自动讲品」选择「小米 MiMo V2.5 TTS」，填入从官方申请的 API Key 后保存。不要把 Key 发到聊天或上传到 GitHub。
5. 选预置中文音色（冰糖/茉莉/苏打/白桦），先点「播报这条回复」检查声音。
6. 点击「开始自动讲解当前商品」，有已获权限的中控台 AI 回复事件时可选择打开「自动播报新产生的 AI 回复」，验证“讲品→插播→恢复”。必须留人在场，随时可点紧急停止。
7. MiMo 音频支持使用 Chromium 的输出设备选择，如果设备不可见或播放失败，恢复「默认设备」，在 Windows 声音设置/直播伴侣里做路由。
8. 真正读取/发送直播弹幕、OBS 画面以及任何预录内容直播都需要分别核实平台许可。**CI 成功不等于抖音实机验收完成**。

## 自动化验证

GitHub Actions 的 \`Voice commerce verification\` 工作流在 Windows 上运行 TypeScript、Node 单元测试、Electron 打包，并上传 EXE 到 Artifacts（保留 7 天）。

## 目前未实现

- 公司主播声音克隆 / MiMo VoiceClone 参考音频。
- 实时同步抖店商品库存、Excel 导入、长期音视频素材库。
- OBS WebSocket 场景控制和一键直播（需符合平台直播要求）。
- 真正的抖音账号全自动文字发送授权、实际设备端到端验证。
- 在 Windows 电脑上安装软件后测试具体设备/声卡、声音延迟和长时间稳定性。
