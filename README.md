# dsh-jev-prune

**Jev-judged context compaction for DeepSeek Harness.**
用 [TypeSafe Jev](https://typesafe.ai) 的结构化判断驱动 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的两层上下文压缩。压缩算法不改动，判断后端可插拔（Jev / 规则 / 自托管模型）。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node%20%3E%3D22.19-339933) ![dsh](https://img.shields.io/badge/DSH-0.1.x--rc-orange) [![CI](https://github.com/yangyu666/dsh-jev-prune/actions/workflows/ci.yml/badge.svg)](https://github.com/yangyu666/dsh-jev-prune/actions/workflows/ci.yml)

## 它解决什么问题

DSH 自带的上下文回收是**纯体积**的：工具结果超过阈值就掐中间留头尾；区域压缩则让模型**写一段摘要**顶替旧历史。前者不认识"这条很大但后面还要用"，后者会引入摘要幻觉。

本插件把这两处的判断都换成 Jev 的结构化输出（noul / choice，返回校准概率），并定了一条设计底线：

> **不该由模型生成的内容，就不让模型生成。** 裁剪只做留/删判断，原文逐字保留；区域压缩注入由代码生成的**确定性回执**，不含任何模型推断。

## 两层机制

| 层 | 接管点 | DSH 默认行为 | 本插件 |
|---|---|---|---|
| **1 · 结果裁剪** | `ctx.toolResultPruner.pruneSession` | 超过 `thresholdChars` 掐中间 | Jev 判定每个工具结果「接下来还要不要」，要的**再大也不裁**，过期的**再小也裁**；无判定时退回 DSH 原生行为 |
| **2 · 回执压缩** | `ctx.compaction.summarize` + `compactRegion` | 模型读原历史、写摘要 | 把已花掉的只读探查（整对 `tool-call` + `tool/result`）移出 surface，注入**确定性回执**：工具名、命令、路径、字符数、seq 全由代码算出 |

第二层的回执长这样：

```
[已压缩 · 确定性回执] 原历史 s25–s27 是 1 次工具调用（共约 16489 字符输出），
为释放上下文已移出。以下为事实清单（代码生成，无模型推断）：
· s27 read：C:\Users\you\project\src\state.js → 16489 字符输出
原始事件仍完整保存在会话日志中（seqs 25–27）。需要内容时重跑相同命令/读取相同文件即可。
```

## 门控（第二层）

整对移出是破坏性动作，默认非常保守，需同时满足：

- **两轴判定取交集**：`result`（内容是否还需要）与 `effect`（调用是否改变了会话外状态）各自落在本次会话的尾部 `compactQuantile` 分位内
- 工具不在 `neverCompactTools`（改写类调用按硬规则永不移出）
- **证据守卫**：结果命中 `error` / `assert` / `fail` / `todo` 等词不移出（仍可被第一层截断）
- assistant 消息文本（含 `reasoning`）超过 `maxStepTextChars` 的步骤不移出——那一步在推理
- 落在最近 `preserveRecent` 个节点内不移出
- 区间两端满足 DSH 的工具配对平衡；整段至少能省 `compactMinChars` 字符；回执 token 低于原内容的 `receiptMaxRatio`

概率的使用方式是**相对分位**而不是固定阈值：判断型小模型的输出分布很窄，只有同一会话内的相对排序携带稳定信息。

## 环境要求

- Node `^22.19.0 || >=24.0.0`
- `dsh`（`@deepseek-ai/dsh`），profile 中已加载 base bundle（`tool-result-pruner` 与 `compaction-basic` 默认包含）
- TypeSafe API key（`TYPESAFE_API_KEY` 环境变量）
- 运行时 peer 依赖：`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`（随宿主提供；npm 7+ 安装本包时会自动带上）

**兼容性**：针对 `@deepseek-ai/dsh@0.1.5-rc.2` 测试。DSH 0.1.x 为预发布版本，事件形状与服务名在小版本间可能变动；升级 DSH 后请重跑 `npm run check` 与冒烟测试，并在真实会话里调用一次 `jev_probe_shapes` 校对字段。

## 安装

```bash
# 从本地目录安装（仓库目录名与包名一致：dsh-jev-prune）
dsh plugin --profile web add link:/绝对路径/dsh-jev-prune

# 确认已进入配置树
dsh --profile web --dump-config | grep jev-prune
```

机器上没有 pnpm 时，可用等价的手工接线（幂等）：

```bash
node wire_profile.mjs <DSH_HOME> <profile名>
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `model` | `jev-latest` | 判断模型 |
| `keepThreshold` | `0.5` | 第一层：`P(保留)` ≥ 该值不裁 |
| `preserveRecent` | `4` | 最近 N 个 surface 节点两层都不碰 |
| `headChars` / `tailChars` | `600` / `200` | 第一层裁剪保留的头/尾字符数 |
| `minCharsToPrune` | `400` | 第一层：短于该长度不裁 |
| `judgeOn` / `softLimit` | `pressure` / `55%` | 第一层判定时机与压力线 |
| `compactReceipts` / `compactOn` | `true` / `pressure` | 第二层开关与压力线（`compactSoftLimit` 默认 70%） |
| `compactMode` | `relative` | `relative`（推荐）或 `absolute`（配 `compactThreshold`） |
| `compactQuantile` | `0.34` | 两轴各取尾部的比例，取交集 |
| `neverCompactTools` | 改写类工具 | 永不移出；比较时归一化（`Edit` 与 `edit` 等价） |
| `compactTools` | 只读工具集 | 白名单，**默认非空**（`DSH_READONLY_TOOLS`：`read`/`glob`/`grep`/`list`/`fetch`…，含 PowerShell 的 `getchilditem`/`selectstring` 等只读命令）；配成 `[]` 会放宽为只受黑名单约束——shell 调用也会被整对移出，属显式 opt-in 的不安全模式 |
| `evidenceGuard` / `evidencePatterns` | `true` / 内置词表 | 证据守卫 |
| `compactMinChars` / `receiptMaxRatio` | `2000` / `0.5` | 第二层经济性下限 |
| `dryRun` | `false` | 两层都只判定记账、不动手 |
| `heartbeatFile` | `''` | 状态落盘路径（宿主会吞掉插件日志，落盘是唯一的外部观测通道） |

## 会话内使用

| 入口 | 用途 |
|---|---|
| `/jev` 命令、`jev_prune_status` 工具 | 两层账本：判定缓存、累计节省、接管状态、工具名索引 |
| `jev_prune_now` | 手动触发一次第一层裁剪 |
| `jev_compact_now`（支持 `dryRun`） | 手动触发一次第二层回执压缩，逐条列出每个门控的排除计数与回执全文 |
| `jev_restore` | 安全阀：取回某个 checkpoint 移出 surface 的原始文本（只读） |
| `jev_probe_shapes` | 打印真实事件形状与工具名解析结果，用于适配不同 DSH 版本 |

正常情况下两层都由上下文压力自动驱动，无需手动介入。

## 设计说明

- **只读概率，不读生成文本**：判断一律取结构化响应里的 `answers[id].noul`
- **state 带任务目标**：判断"还有用吗"本质是"相对于目标还有用吗"，state 头部显式携带最近的用户指令
- **结构判断交代码，语义判断交模型**：改写类调用必留、最近区必留由硬规则保证，不交给概率
- **shadow-price 协议逐字对齐** DSH 的 `compaction/prune` + `surfaceOp: replace`，纯消费者的 token 账本可直接复用
- **按 Unicode 码点切片**，不劈代理对；token 估算用逐词校正算法（中英文混合可用）

## 测试

```bash
npm install   # 拉取 peer 依赖
npm run check # 纯函数自检：token 估算 / state 组装 / 候选筛选 / 两层裁决 / 打包完整性
```

冒烟测试（不依赖完整 DSH 依赖树，4 秒跑完）：

```bash
cp {index,jev,state,prune,receipt}.js package.json <某目录>/node_modules/dsh-jev-prune/
cp smoke_apply.mjs <某目录>/ && cd <某目录> && node smoke_apply.mjs
```

测试脚本与辅助工具（`check.js` / `smoke_apply.mjs` / `inspect_session.mjs` / `verify_real_shapes.mjs` / `wire_profile.mjs`）都随 npm 包发布，装好的包内可直接 `npm run check`。CI（`.github/workflows/ci.yml`）跑两组作业：仅 peer 依赖的快速冒烟 + 完整 DSH 依赖树的集成验证。

覆盖：两个接入点的接管、两层完整裁决路径、append 协议、回执注入、门控分支（含反事实对照）、**shell 类工具默认排除**（`pwsh Remove-Item` 回归用例）。

## 目录结构

```
├── index.js            # 插件入口：配置、两个接入点的接管、pre-step 编排、命令与工具
├── prune.js            # 第一层：按码点切片、逐节点裁决、shadow-price 协议
├── receipt.js          # 第二层：工具配对平衡、范围选择、证据守卫、回执渲染
├── state.js            # DSH 事件 → 判断 state：目标提取、两轴提问、事件形状探针
├── jev.js              # Jev 客户端（结构化 noul 批量接口）+ token 估算
├── check.js            # 纯函数自检
├── smoke_apply.mjs     # 冒烟测试（假 ctx 跑真实 apply）
├── wire_profile.mjs    # 无 pnpm 时的手工安装路径
├── inspect_session.mjs # 会话日志离线检查器（zstd 多帧 JSONL）
├── verify_real_shapes.mjs # 用真实会话日志离线回归工具名解析
└── cordis.patch.yml    # 安装契约
```

## 隐私

插件会把会话历史文本（含文件路径、代码片段、命令输出）发送到 TypeSafe API 用于判断。处理敏感代码时请自行评估；如需数据不出机，可将判断后端替换为自托管模型（判断与压缩机制已解耦，替换点在 `jev.js` 与 `state.js`）。

## License

[MIT](LICENSE)
