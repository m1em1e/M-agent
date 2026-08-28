<div align="center">

# 🎹 M Agent

![Version](https://img.shields.io/badge/version-0.6.0-2b8a3e)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4a9eda)

![Electron](https://img.shields.io/badge/Electron-43-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)

![License](https://img.shields.io/badge/License-MIT-blue)

**[中文](README.md) · [English](README.en.md)**

</div>

> 面向独立游戏开发者的桌面 MIDI 创作 Agent。把多轨钢琴卷帘、非破坏式 MIDI 编辑和三种受权限约束的 Agent 工作模式放进同一个工程。

## 📸 界面预览

<div align="center">
  <img src="doc/screenshots/main.png" alt="M Agent 界面预览" width="820" />
</div>

## ✨ 特性亮点

- **🎼 多轨 MIDI 编辑**
  - 多轨 MIDI 工程与 `.magent` 工程文件
  - Standard MIDI File 导入、导出
  - 钢琴卷帘基础编辑、播放、循环、撤销与重做
- **🤖 Agent 工作模式**
  - 调研、计划、目标三种模式，候选差异预览，用户确认后才应用
  - 随安装包内置 Pi Agent Core 底层内核，不要求另装全局 `pi`
  - 无在线认证时使用 Pi faux Provider 提供离线演示
- **🎛 供应商管理**
  - 启动环境诊断，以及订阅档案形式的供应商管理：可从 Pi / CC Switch 导入、新建或从预设添加
  - 支持 OpenAI Completions / Responses、Anthropic Messages、Google Generative AI 四种 API 类型
- **⚙️ 设置中心**
  - 通用、供应商、用量、音源、插件五个板块
  - 可折叠主题列表（默认、Nord、Tokyo Night、Warn Paper、High Contrast）及深色、浅色、跟随主题模式
- **🎚 音源系统**
  - 轻量试听：可导入 SoundFont（.sf2/.sf3）并分配音色到轨道，支持轨道音量
  - SFZ 仅登记，VST3 未接入（见 [IMPLEMENTED.md](doc/IMPLEMENTED.md)）
- **🛡 安全**
  - 主进程统一 Shell 配置，支持 Bash、Windows PowerShell 和 PowerShell 7 的浏览、检测与启动告警

## 🚀 快速开始

```powershell
npm install
npm run dev
```

测试和构建：

```powershell
npm test
npm run build
npm run test:electron
```

`test:electron` 会启动已构建的桌面应用，通过真实 preload/IPC 链路运行一次环境诊断和 Pi 离线调研，然后自动关闭。

## 📦 平台打包

```powershell
npm run package:win
npm run package:mac
npm run package:linux
```

平台图标来自 `build/icon.ico`、`build/icon.icns` 和 `build/icons/`。macOS 安装包应在 macOS 构建，Linux 安装包建议在 Linux 或对应 CI 环境构建。

正式安装后的应用不依赖本机 `npm` 或全局 `pi` CLI；二者只在源码开发或外部 Pi 工作流中使用。安装版不会执行 PATH 中的 `pi` 命令。启动时会检查 Electron 内置 Node、内置 Pi SDK、开发环境 npm、安全存储及供应商认证；没有在线认证时会显示顶部红色配置提示，但离线演示仍可使用。

应用不会把 API Key 或 OAuth Token 写入工程文件或 Renderer 存储。供应商以“订阅档案”管理：档案元数据保存在本机，API Key 使用 Electron 系统加密能力保存；可从标准 Pi 登录文件或本机 CC Switch 数据库导入订阅（只读，不改写外部文件），并可读取 `OPENAI_API_KEY`。没有在线认证时自动使用离线演示生成器。

## 🔐 安全模型

| 模式 | 权限 | 说明 |
| --- | --- | --- |
| `research` | 只读 | 仅允许分析，写操作会在权限层被拒绝 |
| `plan` | 预览 | 可以形成结构化修改和差异预览，但不能应用 |
| `goal` | 候选 | 可在有限预算内生成候选，仍需用户确认后才写入当前工程 |

M Agent 不让模型直接改写 MIDI 二进制。所有模型调用都由 Electron 主进程中的 Pi Agent Core 执行；Pi 只能调用按模式授权的读取、分析和候选提交工具。所有变更都必须转成受 Schema 校验的领域操作，再由用户确认后作为单个可撤销事务应用。

## 📚 文档

环境检测、认证来源、优先级和当前限制见 [项目介绍](doc/OVERVIEW.md)、[已实现功能](doc/IMPLEMENTED.md) 与 [尚未完成](doc/INCOMPLETE.md)。
