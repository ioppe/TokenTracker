# Fork 自动同步与 nightly DMG

`.github/workflows/upstream-sync-nightly-dmg.yml` 用于维护本地定制 fork，不会创建正式 GitHub Release。

## 工作方式

- 每天 03:15 UTC 从 `xiufengsun/TokenTracker:main` 拉取更新。
- 将上游更新合并到 `custom-collectors`。
- 合并无冲突时，自动推送分支并在 `macos-26` Runner 上构建通用架构 DMG。
- DMG 作为 Actions Artifact 保存 14 天，避免每天创建 Release 或长期累积构建文件。
- 如果发生冲突，工作流失败并列出冲突文件，不会推送半成品，也不会打包。
- 正式版本仍使用 `release (macOS + Windows + Linux)`，手动输入版本号后发布。

## 首次启用

工作流的定时触发来自 fork 的默认 `main` 分支，因此需要把工作流文件提交到远程 `main`。同时，`custom-collectors` 必须已经提交并推送到远程；GitHub Actions 无法看到本地未提交的改动。

如果分支名或上游仓库发生变化，可以在 Actions 手动运行时修改 `target_branch` 和 `upstream_ref` 输入。

## 产物与签名

nightly DMG 使用现有的 ad-hoc 签名流程，适合测试和个人使用。要让公开分发时不出现“无法验证开发者”提示，还需要配置 Apple Developer ID 签名与 notarization secrets；这不影响当前自动构建机制。
