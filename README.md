<div align="center">

<img src="assets/logo.svg" alt="Mendeleev Logo" width="80" />

# Mendeleev · 门捷列夫

**元素周期表第 101 号元素 `Md (Mendelevium)`** —— 像化学家一样，让 Antigravity 每次模型调用的上下文构成、缓存效率、生成速度与配额消耗都清晰透明。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20%2F%200%20python-10b981)](#)

</div>

---

## 为什么做这个插件？

Antigravity 生态中已经有非常优秀的上下文与用量监控插件：
- **[antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context)** 拥有极其克制、耐看的原生侧边栏 UX 和 100 颗圆点阵上下文可视化；
- **[antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)** 拥有非常全面的遥测能力（缓存命中率、请求级 TPS、原生 TTFT、费用估算、模型配额池等）。

**Mendeleev** 从零使用纯 Node.js（零 Python、零外部 npm 依赖）重写，旨在将「极简耐看的侧边栏体验」与「核心遥测指标」自然融合在一起，并补齐中英双语切换与长列表折叠体验。

## 核心功能

- **上下文圆点阵与分类明细**：直接通过 Antigravity Language Server (`GetCascadeTrajectory` & `GetAvailableModels`) 读取精确的 `tokenBreakdown`，100 颗圆点按比例呈现系统提示、用户消息、Agent 回复、工具调用与定制扩展占用。
- **2×2 核心遥测微卡片**：
  - **缓存命中率**：统计缓存读取占比（`cacheRead / (input + cacheRead)`）与新输入 Token
  - **生成速度 (TPS)**：基于请求真实端到端耗时计算会话平均 TPS 与最新一步 TPS
  - **首字延迟 (TTFT)**：读取原生 `timeToFirstToken` 指标（最新 & 均值）
  - **估算费用 (USD)**：结合本地单价表估算会话参考费用及缓存命中省下的金额
- **模型配额池 (`GetUserStatus`)**：以紧凑进度条展示当前活跃模型池及主要模型系列的剩余配额与重置倒计时。
- **全模块可折叠 + 状态持久化**：支持折叠 `Token 占用明细`、`模型配额池`、`检查点 (Checkpoints)`、`知识库 / 产物 / Skill / 系统目录`（Checkpoints 与 Skill 文件默认折叠，标题栏带数量与摘要）。
- **中 / 英文实时切换**：右上角一键切换 `中 / EN`，状态持久化至 `localStorage`。
- **零依赖纯 Node.js**：不依赖本地 Python 版本，无需 `npm install`。

## 安装

将仓库克隆到 Antigravity 插件目录：

```bash
# macOS / Linux
git clone https://github.com/Xav1erSue/antigravity-mendeleev.git ~/.gemini/config/plugins/mendeleev
```

```powershell
# Windows (PowerShell)
git clone https://github.com/Xav1erSue/antigravity-mendeleev.git "$env:USERPROFILE\.gemini\config\plugins\mendeleev"
```

然后在 Antigravity Desktop 的 **Customizations → Installed** 中启用 **Mendeleev · 门捷列夫**，在右侧辅助面板打开 **Mendeleev** 即可。

## 开发与测试

```bash
node --test tests/test_analyzer.mjs
```

## 参考与致谢 (Acknowledgements)

本项目站在前人的肩膀上完成，特此向以下开源项目（均基于 MIT 协议）致敬与感谢：

- **[dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context)** (MIT License)
  - 借鉴了其极具美感的极简侧边栏视觉设计、100 颗圆点阵布局以及上下文分类呈现逻辑。
- **[yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)** (MIT License)
  - 借鉴了其通过 Language Server RPC 获取原生 `timeToFirstToken`、`modelUsage`、配额池 (`GetUserStatus`) 的思路，请求级 TPS 的计算口径（避免 `streamingDuration` 在工具调用缓冲时失真），以及 `pricing-catalog.json` 中的模型单价与占位符映射表。

## License

[MIT](LICENSE) © 2026 [Xav1erSue](https://github.com/Xav1erSue)
