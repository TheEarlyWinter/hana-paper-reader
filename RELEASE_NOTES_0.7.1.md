# Hana Paper Reader 0.7.1

0.7.1 是 0.7.0 的补丁版本，修复已删除 Agent 仍出现在 Paper Reader 选择器中的问题，并让主分支推送能够进入自动 QA 构建流程。

## 修复已删除 Agent 出现在选择器

- `agent:list` 返回的 Agent 会排除带有 `.deleted-agent.json` tombstone 的历史目录。
- 本机 `~/.hanako/agents` 目录扫描同样排除已删除 Agent，避免宿主列表缺失时重新补入历史条目。
- 通过旧 Agent ID 直接调用时，后端也会拒绝已删除 Agent，避免绕过选择器过滤。
- 新增回归夹具，覆盖宿主列表、本地配置目录和删除 tombstone 同时存在的场景。

## CI 构建触发

- 推送到 `main` 会自动运行语法检查、测试、净目录打包、反向解包复测、敏感信息扫描和 SHA-256 QA。
- 推送 `v0.7.1` 标签会在同一套 QA 通过后自动创建 GitHub Release。
- 普通 `main` 推送只上传 Actions Artifact，不会意外创建 Release。

## 兼容性

- 保持 Hana 最低版本 `0.686.15` 不变。
- 保留 0.7.0 的动态 Agent / 聊天模型选择、显式会话路由和模型绑定会话隔离能力。
