# Hana Paper Reader v2 App — 1.0.36 试用候选

面向 HanaAgent 的论文阅读与研究工作台，使用 App v2 SDK、App 自有路由和数据目录。
最低宿主版本为 0.1050.9。当前是有局部实机验证的试用候选，完整发布验收仍待完成。

## 功能

- 独立论文导航、原文/双语/译文/对照阅读、搜索与大纲。
- 笔记、书签、术语、阅读进度与翻译缓存；带版本条件的保存和冲突提示。
- 动态模型/Agent 目录、单段/批量翻译、证据问答和划选问助手。
- MinerU 解析适配、Markdown 导出、备份/恢复和离线迁移预检。
- 对照阅读模式内置 PDF 预览（带匹配版本的 CMap 与标准字体资源）。

以上为代码实现范围，实际验证覆盖见 [测试状态](../../docs/v2/TEST_STATUS_1.0.34.md)。

## 安装

已构建的 1.0.36 试用包可从 [V2 发布页](https://github.com/TheEarlyWinter/hana-paper-reader/releases/tag/v1.0.36)下载（`app-hana-paper-reader-1.0.36-candidate.zip`）。在 Hana 扩展管理中通过“本地安装”直接选择 App ZIP，无需解压；GitHub 自动提供的 Source code 压缩包不用于安装。

需要自行打包时，按以下步骤准备候选目录。

在项目根目录使用 Node.js 26 或更新版本准备候选目录：

~~~sh
node tools/stage-release.mjs --out ./dist/v2-staging
~~~

该命令创建一个带 manifest.json 的独立目录。将目录内容压缩为 ZIP，manifest.json 应在 ZIP 根目录，然后在 Hana 的扩展管理中通过本地安装审查导入。

Windows 也可直接生成候选 ZIP：

~~~powershell
./tools/package-candidate.ps1 -OutputDirectory ./dist/v2-packages -StagingDirectory ./dist/v2-staging
~~~

打包只准备候选，不自动验证、安装或迁移数据。同名输出存在时拒绝覆盖。
公开源码的说明及许可证文件已整理；从源码重打的 ZIP 不应冒称与先前实机安装包逐字节相同。

## 开始使用

1. 从论文精读入口打开示例或导入少量论文副本。
2. 在工作台选择已配置的模型；MinerU 未配置时需要用户在 App 内手工设置，不能读取旧版 Token。
3. 保存研究记录后关闭并重开核对，导出文件保存在 App 自有数据目录的 exports 中。

随包提供 PDF.js 5.6.205 匹配的 CMap 和标准字体，支持工作台内中文 PDF 原页与局部图表渲染。

## 开发检查

~~~sh
npm --prefix apps/hana-paper-reader test
~~~

此命令运行完整后台检查，并非原生窗口或生产服务验收。需要 Node.js 26+；开发用 package.json 不参加 App 安装目录的准备。
公开源码保留已有检查代码；GitHub 候选包流程只打包并检查结构，不自动执行完整后台测试或原生验收。

## 试用边界

- 基础阅读、保存重开、单段真实翻译与内置 PDF 预览已有明确版本的实机记录。
- 真实 MinerU、完整翻译/问答、原生保存失败及多窗口冲突仍需实际验证。
- 宿主菜单拆出/放回完成 20 轮的是 1.0.32；原拖出路径及内部单实例观测未完成。
- 真实旧版数据迁移没有执行；必须另外落实停写、源授权、不可变快照、备份和目标数据策略。

宿主重复卡片的本机修复独立于本 App 包，不能将上传 App 源码解释为向其他电脑分发宿主补丁或证明厂商已修复。菜单入口的可用性需按目标宿主重新核对。

## 许可证

项目自有代码沿用仓库 MIT 许可证。OpenHanako SDK、PDF.js 及其他随包组件分别保留其许可证和声明。
参见 sdk/LICENSE、sdk/NOTICE、sdk/THIRD_PARTY_NOTICES.txt、ui/assets/THIRD_PARTY_NOTICES.txt、
assets/licenses/PDFJS-APACHE-2.0.txt，以及 CMap/standard_fonts 下各自的许可文件。
