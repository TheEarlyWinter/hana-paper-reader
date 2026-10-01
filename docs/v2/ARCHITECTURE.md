# Hana Paper Reader v2 架构

v2 App 位于 apps/hana-paper-reader，与根目录的旧插件入口分开。App 使用单次 sdk.routes.register 注册自己的相对 API，前端通过 hana.api 请求，不接受旧 pluginSurfaceSession 作为身份。

工作区业务数据只写 App 自有 sdk.dataDir。研究记录、论文快照和译文使用 revision/generation 及条目版本条件；冲突返回明确错误，不把失败当空库或保存成功。

模型和 Agent 由宿主目录提供；正文及证据来自已提交工作区，译文、未匹配线索与原文分开。跨会话分享是额外授权功能，不读用户 agents 文件或自动向真实其他对话发送消息。

MinerU 经受控网络适配器调用，Token 由用户在工作台手工设置。Windows 下设置使用当前用户 DPAPI，公开状态只说明是否配置，不回显凭据。

PDF 预览是独立只读卡和可选 Previewer。文件选择由宿主授予资源，再用 hana.document 绑定和读取；普通 reader 卡不能自行假定有文档权限。随包保留 PDF.js 的匹配版本字体、CMap 和许可。

导出写 dataDir/exports，回执对应捕获的来源版本。备份/恢复及离线迁移工具不自动读取真实旧数据；已有目标需要明确保留/合并策略。真实迁移先停写、授权源读取、创建不可变快照与独立备份，再核对源/目标计数和 SHA256。

宿主原生 detach/dock/pin 属于宿主生命周期。App 包不分发本机 renderer 补丁，也不把可见窗口数量当内部 card registry 证据。

代码实现范围、实机证据和发布条件分开记录，见 TEST_STATUS_1.0.34.md。
