# Hana Paper Reader V2

面向 HanaAgent 的论文精读与研究工作台，基于 App v2 SDK、独立路由和 App 自有数据目录。

- 当前版本：**1.0.36 试用候选**
- 最低 Hana 版本：**0.1050.9**
- App ID：hana-paper-reader；manifestVersion：2
- 自有代码许可证：MIT；随包组件分别保留许可证

[使用与开发说明](apps/hana-paper-reader/README.md) · [实机测试覆盖](docs/v2/TEST_STATUS_1.0.34.md) · [架构](docs/v2/ARCHITECTURE.md)

## 主要功能

- 原文、双语、译文、对照阅读，全文搜索与大纲。
- 笔记、书签、术语、进度和翻译缓存；保存冲突给出明确反馈。
- 宿主模型与 Agent 目录、翻译和证据问答。
- MinerU 解析适配、Markdown 导出、备份/恢复和离线迁移准备。
- 对照阅读模式内置 PDF 预览（带匹配版本的 CMap 与标准字体资源，支持中文 PDF 渲染）。

以上是实现范围，具体通过记录与待验收项见测试覆盖文档。当前版本适合少量论文副本试用，完整宿主与真实服务验收仍待完成。

## 安装

应用源码在 apps/hana-paper-reader。安装用 ZIP 必须由候选打包流程生成，使 manifest.json 在压缩包根目录；GitHub 的源码压缩包不是 App 安装包。

**直接下载 V2 1.0.36 试用版：**

1. 下载[候选安装包](https://github.com/TheEarlyWinter/hana-paper-reader/releases/download/v1.0.36/app-hana-paper-reader-1.0.36-candidate.zip)。
2. 在 Hana 的扩展管理中选择“本地安装”，直接选择下载的 App ZIP，不需要解压。
3. [V2 发布页](https://github.com/TheEarlyWinter/hana-paper-reader/releases/tag/v1.0.36)提供安装包、校验和、构建报告和试用说明；页面中的 Source code 是源码压缩包，不用于 App 安装。

V2 发布页当前标记为 Pre-release。构建来源及校验和固定在该版本，后续 main 的开发产物仍可从 Actions 中的 **V2 Candidate Packages** 获取；下载 artifact 时，需要先解压外层文件，才能得到里面的 App ZIP。

这个流程只生成候选与 SHA256，不自动执行本机安装、真实迁移或正式发布验收。

**本地生成候选包（Node.js 26+、PowerShell 7）：**

~~~powershell
./tools/package-candidate.ps1 -OutputDirectory ./dist/v2-packages -StagingDirectory ./dist/v2-staging
./tools/verify-candidate-packages.ps1 -OutputDirectory ./dist/v2-packages
~~~

也可用跨平台的 node tools/stage-release.mjs --out ./dist/v2-staging 准备候选目录，再将该目录内容压缩为 ZIP。

## 使用与验证

从论文精读入口打开示例或导入论文副本，选择宿主已配置模型，在工作台保存研究记录。
MinerU Token 需要用户手工配置；不自动读取旧凭据。

已有实机记录涵盖基本阅读与保存重开、单段真实翻译和内置 PDF 预览。整篇翻译/问答、多窗口冲突与真实 MinerU 仍需持续验证；真实旧数据迁移另有准入条件。

开发检查命令：

~~~sh
npm --prefix apps/hana-paper-reader test
~~~

候选包 workflow 的绿色状态只表示打包与结构检查成功，不表示原生窗口、生产服务或完整应用检查全部通过。

## 仓库结构

| 路径 | 内容 |
|---|---|
| apps/hana-paper-reader | V2 App、资源与已有检查代码 |
| tools | 候选打包、结构核对、离线迁移准备 |
| docs/v2 | 架构与分版本验收记录 |

main 当前维护 V2；旧版代码可从 Git 历史找回。
