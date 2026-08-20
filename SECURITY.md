# 安全政策

## 支持范围

当前只对最新 GitHub Release 提供安全修复。项目仍处于第一版阶段，不承诺旧版本兼容。

## 报告安全问题

请不要公开提交包含 Cookie、HLS 签名地址、课程链接、个人信息或可利用细节的 Issue。优先使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能。

报告中请包含：

- 受影响版本和 Windows 版本
- 可复现步骤
- 预期行为与实际行为
- 已脱敏的日志或截图
- 你认为可能受影响的数据范围

## 设计边界

- 本工具不会绕过付费权限、DRM 或加密 HLS。
- 登录状态由 Chromium 保存，不由应用导出或上传。
- 媒体签名地址不得写入日志、Issue 或测试夹具。
- 所有首次下载的二进制和模型必须使用清单中的固定 SHA-256 校验；唯一例外是 VC++ 运行库，从微软官方 `https://aka.ms/vs/17/release/vc_redist.x64.exe` 实时下载，依赖微软签名而非固定校验值。
- 渲染进程保持 `nodeIntegration: false` 和 `contextIsolation: true`。

若发现上述边界被破坏，请按安全漏洞处理。
