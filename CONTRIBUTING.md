# 参与贡献

感谢你改进 Xiaoe-tech transcription。提交改动前，请确保它仍然遵守“只处理当前账号合法有权回放的内容，不绕过 DRM 或加密”的边界。

## 开发流程

1. Fork 仓库并从 `main` 创建分支。
2. 运行 `npm install`。
3. 修改代码并补充相应测试。
4. 运行 `npm run check`、`npm test` 和 `npm audit --audit-level=high`。
5. 提交 Pull Request，说明用户影响、验证方法和平台兼容性。

不要在提交、日志、测试或 Issue 中包含真实 Cookie、临时 HLS 签名、课程内容或个人信息。媒体协议测试应使用人工构造的最小清单。

若升级 `assets/dependencies.json`：

- 只使用上游官方发布地址；
- 固定不可变版本，避免 `latest`；
- 更新文件大小和 SHA-256；
- 核对第三方许可证；
- 在 Windows 10/11 + NVIDIA GPU 上执行真实启动自检。
