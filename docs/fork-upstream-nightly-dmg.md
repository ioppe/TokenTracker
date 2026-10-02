# Fork 自动同步与 custom-collectors DMG

`.github/workflows/upstream-sync-nightly-dmg.yml` 用于维护本地定制 fork，并发布带有 `custom-collectors` 后缀的 GitHub 预发布版本。

## 工作方式

- 每天 03:15 UTC 从 `xiufengsun/TokenTracker:main` 拉取更新。
- 将上游更新合并到 `custom-collectors`。
- 读取上游 `main/package.json` 的稳定 release 版本，并同步根 `package.json`、根锁文件及所有平台版本文件。
- 合并无冲突时，自动推送分支并在 `macos-26` Runner 上构建通用架构 DMG。
- DMG 同时作为 Actions Artifact 保存 14 天，并发布为 `vX.Y.Z-custom-collectors` 预发布版本；同一上游版本重复构建时会覆盖同一个渠道 Release 的 DMG。
- 安装包可从对应的 `custom-collectors` 预发布版本下载，也可以从对应的 Actions 运行记录下载 Artifact。
- 如果发生冲突，工作流失败并列出冲突文件，不会推送半成品，也不会打包。
- 各平台实际打包元数据保持上游的稳定 `X.Y.Z`；`-custom-collectors` 只用于 Artifact 名称、Release 标签和标题，避免破坏 Cargo、PKGBUILD、Xcode 及正式发布版本校验。
- 正式版本仍使用 `release (macOS + Windows + Linux)`，手动输入版本号后发布；custom-collectors 预发布版本不替代正式版本。

## 首次启用

工作流的定时触发来自 fork 的默认 `main` 分支，因此需要把工作流文件提交到远程 `main`。同时，`custom-collectors` 必须已经提交并推送到远程；GitHub Actions 无法看到本地未提交的改动。

如果分支名或上游仓库发生变化，可以在 Actions 手动运行时修改 `target_branch` 和 `upstream_ref` 输入。

## 仅构建当前分支

手动运行时启用 `build_only`，工作流会跳过上游拉取、合并和渠道 Release 发布，只验证并打包 `target_branch` 当前提交。DMG 仍作为 Actions Artifact 保存 14 天，适合测试尚未发布的采集器修改。

向 `custom-collectors` 推送采集器、Dashboard、macOS、测试、依赖或此工作流的修改，也会自动触发仅构建模式，不需要额外的 Actions API 凭据。

通过 CLI 调用时指定工作流所在分支，确保使用支持该选项的版本：

```bash
gh workflow run upstream-sync-nightly-dmg.yml --ref main \
  -f target_branch=custom-collectors -F build_only=true
```

未启用该选项的手动运行和定时运行会同步上游、对齐版本并发布 `vX.Y.Z-custom-collectors`。构建同时验证桌面配额采集、Dashboard 展示以及原生配额保留和重置通知隔离。

## 产物与签名

custom-collectors DMG 使用现有的 ad-hoc 签名流程，适合测试和个人使用。要让公开分发时不出现“无法验证开发者”提示，还需要配置 Apple Developer ID 签名与 notarization secrets；这不影响当前自动构建机制。
