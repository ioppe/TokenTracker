# Fork 自动同步与 nightly DMG

`.github/workflows/upstream-sync-nightly-dmg.yml` 用于维护本地定制 fork，并发布一个滚动的 GitHub nightly 预发布版本。

## 工作方式

- 每天 03:15 UTC 从 `xiufengsun/TokenTracker:main` 拉取更新。
- 将上游更新合并到 `custom-collectors`。
- 合并无冲突时，自动推送分支并在 `macos-26` Runner 上构建通用架构 DMG。
- DMG 同时作为 Actions Artifact 保存 14 天，并覆盖同一个 `nightly` 预发布版本，避免 Release 和备份文件无限增长。
- 安装包可从 [Nightly DMG Release](https://github.com/ioppe/TokenTracker/releases/tag/nightly) 下载，也可以从对应的 Actions 运行记录下载 Artifact。
- 如果发生冲突，工作流失败并列出冲突文件，不会推送半成品，也不会打包。
- 正式版本仍使用 `release (macOS + Windows + Linux)`，手动输入版本号后发布；nightly 预发布版本不替代正式版本。

## 首次启用

工作流的定时触发来自 fork 的默认 `main` 分支，因此需要把工作流文件提交到远程 `main`。同时，`custom-collectors` 必须已经提交并推送到远程；GitHub Actions 无法看到本地未提交的改动。

如果分支名或上游仓库发生变化，可以在 Actions 手动运行时修改 `target_branch` 和 `upstream_ref` 输入。

## 产物与签名

nightly DMG 使用现有的 ad-hoc 签名流程，适合测试和个人使用。要让公开分发时不出现“无法验证开发者”提示，还需要配置 Apple Developer ID 签名与 notarization secrets；这不影响当前自动构建机制。
