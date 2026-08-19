# 第三方软件与模型

`Xiaoe-tech transcription` 自身使用 MIT License。首次运行时，应用会按
[`assets/dependencies.json`](assets/dependencies.json) 中固定的版本和 SHA-256，从各项目的官方发布地址下载下列独立组件。它们不包含在本仓库源码中，也不打包进应用安装程序。

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org/) / [BtbN Windows build](https://github.com/BtbN/FFmpeg-Builds) | 音频提取 | 所选构建启用了 GPLv3 组件，按 GPLv3 分发 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 本地语音识别 | MIT |
| [Whisper Small model](https://huggingface.co/ggerganov/whisper.cpp) | 多语言语音识别权重 | MIT |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | 本地总结推理 | MIT |
| [Qwen2.5-1.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) | 中文总结模型 | Apache-2.0 |
| [Electron](https://www.electronjs.org/) | Windows 桌面运行时 | MIT |

Microsoft Visual C++ 2015–2022 Redistributable 和 NVIDIA 驱动由用户单独安装，并遵循各自的许可条款。

第三方组件的版权归各自权利人所有。若上游许可证或下载地址发生变化，请在升级
`assets/dependencies.json` 前重新核对许可证、固定版本和校验值。
