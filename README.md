# Hana Paper Reader 0.4.2

Hana 插件 ID：`hana-paper-reader`

Hana Paper Reader 是一个面向学术 PDF 的双语精读工作台。PDF 统一通过 MinerU 精准解析 API 获取正文结构、图片、图表、表格和公式，再以连续单栏阅读流同时呈现在英文原文侧与中文翻译侧。

> **0.4.0 是破坏性升级，0.4.1 修复二进制传输，0.4.2 修复升级兼容并加入 OCR 自动回退。** 0.4.0 已删除后端本地 PDF 结构解析器；0.4.1 把新 WebView 的 PDF 传输从 Base64 JSON 改为原始 `application/pdf` 二进制，消除了超长 Base64 正则的栈溢出。0.4.2 为安装升级时仍在运行的 0.4.0 卡片提供有界 Base64 兼容接收、强制刷新前端资源版本，并参考 PaperQuay 的单篇流程，在普通 MinerU 解析失败或返回空结构后自动以 OCR 模式重试。浏览器侧 PDF.js 仍只负责显示本地原页和定位裁剪，不参与结构解析。

## 核心能力

- 支持选择或拖拽导入 PDF、TXT、Markdown；插件侧 PDF 上限为 50 MB。
- PDF 只使用 MinerU 精准解析，不再提供本地解析分支。
- TXT / Markdown 仍在阅读器本地读取，不发送到 MinerU。
- 无论源 PDF 是单栏还是多栏，阅读正文始终重排为连续单栏。
- 图片、图表、表格和公式在原文侧与译文侧共用同一视觉资源：
  - 优先展示 MinerU 结果 ZIP 中被结构块引用的图片；
  - 没有独立资源但有坐标时，可从当前本地 PDF 原页生成视觉裁剪；
  - 表格 HTML 经标签、属性、节点数量和体积限制后再渲染，并支持横向滚动；
  - 公式保留 LaTeX / 公式文本以及可用的原页视觉定位。
- 支持逐段翻译与全文批量翻译；纯图片、空视觉块及没有说明文字的公式不会被送入翻译模型，图注、表题和公式说明仍可翻译。
- 点击段落的 `译` / `重新翻译` 会将另一侧对齐到同一结构块；顶部 `⌖ 对齐` 可按当前活动面板手动对齐。
- 两个阅读面板独立滚动，不进行持续镜像滚动。
- 助手名称、头像、模型和描述从当前 Hana 安装读取，不内置供应商目录、API Key 或机器相关模型配置。
- `思考` 支持 `无 / 低 / 中 / 高 / 最高`；`最高` 使用 Hana 可移植值 `max`。
- 支持划词后调用当前 Hana 助手进行概念解释、公式拆解、复制或发送到助手会话。
- 顶部工具栏会随窗口宽度自动换行；窄窗口下双侧阅读区改为上下分屏，避免控件和正文被挤压。

## MinerU 导入流程

1. 新 WebView 将用户选择的 `File` 以原始 `application/pdf` 二进制请求体发送给插件路由；不生成 Base64，不嵌入 JSON。
2. 插件后端流式读取请求并执行 50 MB 硬上限；升级时尚未关闭的 0.4.0 卡片仍可通过有界、逐字符校验的兼容层提交旧 Base64 JSON，但关闭并重新打开后会自动回到二进制协议。
3. 后端向 `POST /api/v4/file-urls/batch` 申请签名上传地址，再把 PDF `Buffer` 直接 `PUT` 到签名地址；按 MinerU 要求不额外设置 `Content-Type`。
4. 后端轮询 `/api/v4/extract-results/batch/{batch_id}`。
5. MinerU 任务明确进入 `failed`，或结果结构缺失、无法解析、没有可用结构块时，自动以 `is_ocr=true` 重新提交一次；Token、401/403、申请地址、上传、轮询网络、下载、ZIP 安全校验和超时错误不重试，用户已开启强制 OCR 时也不重复提交。
6. 任务完成后下载结果 ZIP。
7. 从 `content_list_v2.json`、`content_list.json` 或 `middle.json` 归一化结构块。
8. 只把正文实际引用的受支持图片写入插件私有缓存，并通过私有资源路由提供给 WebView。

批量申请请求遵循 MinerU 官方字段位置：

- 根层：`model_version`、`enable_formula`、`enable_table`、`language`；
- `files[0]`：`name`、`data_id`、`is_ocr`。

MinerU 官方 API 文档：<https://mineru.net/apiManage/docs>

## MinerU 设置

### 阅读器内设置

点击顶部的 `MinerU 未配置` / `MinerU · VLM` 按钮即可设置：

- API Token；
- 解析模型：`vlm` 或 `pipeline`；
- 文档语言：`ch`、`en`、`japan` 或 `latin`；
- 公式识别；
- 表格识别；
- 强制 OCR。

首次导入 PDF 且尚未配置 Token 时，阅读器会先打开设置窗口；保存成功后自动继续刚才的 PDF 导入。

### Token 安全边界

- Token 通过插件后端写入 Hana 的 `sensitive` 全局插件配置。
- 页面只会获得“已配置 / 未配置”状态，读取接口永远不返回 Token。
- 已保存 Token 不会预填或回显；输入框留空表示保留原值。
- 发布 ZIP、README、测试夹具和日志中不包含真实 Token。
- 可以在页内设置中清除 Token。

### Hana 高级设置

以下参数仍可在 **Hana 设置 → 插件 → Hana Paper Reader** 中调整：

- MinerU API 地址：默认 `https://mineru.net/api/v4`，代码只接受 `mineru.net` 官方 HTTPS 域名；
- 解析超时：默认 900 秒，范围 60–3600 秒；
- 轮询间隔：默认 5 秒，范围 2–30 秒。

## 使用方法

1. 手动安装并启用插件。
2. 打开 **Hana Paper Reader** 页面卡片。
3. 点击顶部 MinerU 设置，填写 Token 并保存。
4. 拖入或选择 PDF；等待上传、轮询和结构化解析完成。
5. 阅读连续单栏正文；需要核对版面时展开每页上方的本地原页参考。
6. 点击单段 `译`，或使用顶部 `⚡ 翻译全文`。
7. 两侧位置不一致时，在作为基准的一侧滚动或点击，再用 `⌖ 对齐`。
8. 划选文字后，可让当前 Hana 助手解释、拆解公式、复制或发送到助手会话。

点击 `↻ MinerU 重解析` 会重新上传当前 PDF 并创建新的 MinerU 解析任务。

## 隐私与数据边界

1. **PDF 会上传到 MinerU。** 选择或拖入 PDF、点击重解析，都会把 PDF 发送到用户配置的 MinerU 官方 API。插件不再提供离线 PDF 结构解析。
2. **TXT / Markdown 不上传到 MinerU。** 这两种文本文件由页面本地读取。
3. **Token 只在服务端使用。** WebView 不会读取到明文 Token。
4. **翻译和助手问答使用当前 Hana 配置。** 被翻译的文本或被提问的选中文字会交给用户当前选择的 Hana 模型 / 供应商；是否远程处理取决于用户自己的 Hana 配置。
5. **原页参考使用当前本地 `File`。** 浏览器侧 PDF.js 从本次文件选择得到的字节渲染原页，不访问第三方 PDF URL。
6. **MinerU 结果图片存入插件私有缓存。** 最多保留 8 份缓存、合计约 1 GiB，并按新旧自动淘汰；单个结果 ZIP、条目和总解压体积均有限制。
7. **视觉块双侧复用。** 翻译只改变说明文本，不重新上传或重新生成图片。

在使用前，请同时遵守 MinerU 的服务条款、隐私政策、额度限制和文档处理要求。

## 安全限制

- 插件接收的 PDF 最大 50 MB；前端先检查 `File.size`，后端再按二进制流累计字节数执行不可绕过的硬上限。MinerU 官方服务当前另有不超过 200 MB、200 页等限制，以其最新文档为准。
- MinerU 结果 ZIP 最大 250 MB；单条目最大 120 MB；实际总解压体积最大 500 MB；最多 10,000 个条目。
- 单份结构化 JSON 最大 64 MB；最多归一化 20,000 个结构块；单个表格 HTML 最大 1,000,000 字符。
- ZIP 路径必须是相对安全路径；绝对路径、盘符路径、`.` / `..` 路径会被拒绝或忽略。
- 缓存资源只允许 PNG、JPEG、WebP、GIF 和 BMP，并通过 cache ID 与规范化相对路径读取。
- 单个翻译块后端上限为 12,000 字符；全文翻译按小批次执行。
- 原始 PDF 页面只是视觉参考，不是第二套正文，也不会恢复为 CSS 多栏排版。

## 安装

本插件无构建步骤，是 direct-template Hana WebView 插件。

### 手动安装 ZIP

在 Hana 插件设置中选择手动安装 ZIP。发布 ZIP 根目录直接包含：

- `manifest.json`
- `index.js`
- `README.md`
- `THIRD_PARTY_NOTICES.md`
- `assets/`
- `lib/`
- `licenses/`
- `routes/`
- `tests/`

无需安装 Python、npm 依赖或浏览器扩展。

### 源目录

也可以把整个 `hana-paper-reader` 目录交给 Hana 的手动安装入口。插件声明 `full-access`，因为它提供 route-backed WebView，并使用 Hana 的 Session、Agent、Model、敏感配置和受控网络能力。

## 开发检查

从插件目录执行：

```powershell
node --check assets/panel.js
node --check routes/api.js
node --check routes/ui.js
node --check lib/mineru.js
node --check index.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
node tests/mineru-protocol.test.mjs
node tests/static-regression.test.mjs
```

`assets/pdfjs.mjs` 是浏览器原页参考渲染器，不是后端 PDF 解析器。运行时不依赖外部 CDN。

## 第三方软件与开源说明

- 随包的 `assets/pdfjs.mjs` 来自 **Mozilla PDF.js 5.6.205**，依据 **Apache License 2.0** 分发。完整许可证见 `licenses/PDFJS-APACHE-2.0.txt`，归属说明见 `THIRD_PARTY_NOTICES.md`。
- 当前 Hana Paper Reader 实现未复制 PaperQuay 源码。若未来直接引入 PaperQuay（`AGPL-3.0-only`）代码，必须保留其版权与许可证信息，并履行 AGPL 对应源代码等义务；“个人使用”或“非商业使用”不会自动免除许可证义务。
- Hana Paper Reader 本身依据 MIT License 发布，完整文本见项目根目录 `LICENSE`。PDF.js 的 Apache-2.0 许可仅适用于该第三方组件，不替代项目自身许可证。

## v0.4.2 设计约束

- PDF 解析只有 MinerU 一条路线。
- 新 WebView 与插件后端之间只走原始二进制请求体；Base64 JSON 仅限升级后仍存活的 0.4.0 卡片过渡兼容，不是新流程。
- 普通模式只在 MinerU 任务级失败或结构结果不可用时自动 OCR 重试一次；鉴权、申请地址、上传、轮询网络、下载、ZIP 安全校验和超时错误不得盲目重试。
- UI 与 API 通过 `0.4.2` 版本握手，静态资源 URL 带版本参数，解析失败时在状态栏持久显示具体原因。
- 正文始终为连续单栏；源版面只用于结构顺序和视觉定位。
- 原页预览只作本地视觉参考。
- 图片、图表、表格和公式在两侧都必须可见。
- Token 留在服务端敏感配置，页面只见状态。
- 不捆绑真实凭据、供应商目录或机器专有模型配置。
