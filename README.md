# dsh-vision

<p align="center">
  <img alt="npm version" src="https://img.shields.io/npm/v/dsh-vision">
  <img alt="license" src="https://img.shields.io/npm/l/dsh-vision">
  <img alt="node" src="https://img.shields.io/node/v/dsh-vision">
  <img alt="dsh plugin" src="https://img.shields.io/badge/deepseek%20harness-plugin-4D6BFE">
</p>

**dsh-vision** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的视觉辅助插件：接入任意 OpenAI 兼容的多模态模型（如 Qwen-VL、GLM-4V），为无图像理解能力的主模型（如 DeepSeek）提供视觉能力。

核心机制是**视觉工作记忆（Visual Working Memory）**：图片先被视觉模型转换为编号元素清单并缓存，主模型以编号引用元素、按需定向放大检查，全程不接触坐标细节。用户上传图片或提供文件路径，插件负责将图像转换为主模型可推理的结构化信息。

## 特性

- **编号元素标注** —— 将图片转换为编号元素清单（ID、标签、逐字文字、置信度、像素坐标），基于 Set-of-Mark 范式；主模型以 `element 7` 精确引用，替代模糊描述
- **视觉工作记忆** —— 编号清单按文件身份缓存（文件变更即失效），`vision_zoom ref "7"` 直接解析坐标，无需重复标注
- **由粗到细的区域检查** —— 区域裁剪后单独上传，小字号文本与图标在原始分辨率下识别；支持 2-8 倍最近邻放大
- **长图自动分片转写** —— 超长页面按固定高度重叠切片、逐条转写、精确行合并，解决整图压缩导致的文本丢失
- **声明验证** —— `vision_check` 将自然语言断言与图像证据逐条比对（supported / contradicted / unverifiable），主模型在断言视觉事实前可先取证
- **像素级对比** —— `vision_diff` 本地确定性对比两张图（零 API 成本），输出差异百分比与最差区域框，支撑"改一版 → 测差异 → 收敛到 0%"的迭代闭环
- **按任务路由模型** —— `map`/`read`/`zoom`/`check` 任务可分别指定模型（如转写使用免费模型，标注使用高性能模型）；支持回退端点链，主端点失败自动降级
- **统一坐标体系** —— 内部采用 0-1000 归一化坐标（OS-Atlas 约定），模型差异在适配层消化，预留多模型适配器接口
- **零运行时依赖** —— 纯 TypeScript 实现（内置 PNG / JPEG / GIF / BMP 编解码器），无需 Python 环境或外部检测模型
- **格式看字节，不看扩展名** —— 魔数嗅探判定格式：`~/.dsh/attachments` 里没有扩展名的缓存对象、扩展名写错的图片都能直接用；JPEG（基线 + 渐进式 + EXIF 方向）与 GIF/BMP 均可本地裁剪、放大、降采样、像素对比

## 支持的图片格式

| 格式 | 标注 / 阅读 / 验证 | 裁剪 / 放大 / 对比 | 说明 |
|---|---|---|---|
| PNG | ✅ | ✅ | 无需重绘时按原字节上传 |
| JPEG | ✅ | ✅ | 基线 + 渐进式、灰度、任意采样因子、EXIF 方向；色度上采样用 libjpeg 三角滤波；无需重绘时按原字节上传 |
| GIF | ✅ | ✅ | 取首帧；透明区按背景色合成后上传 |
| BMP | ✅ | ✅ | 未压缩 8/24/32 位（Windows 截图常见） |
| WebP | ✅ | ❌ | 无本地解码器：按原字节上传，裁剪时提示转 PNG/JPEG |

超过 `maxEdge` 的图片会被均值池降采样（长边缩到上限以内），保证上传的像素尺寸与工具上报的坐标一致。

## 快速开始

### 1. 安装

```sh
dsh plugin --profile <profile> add dsh-vision
# 或本地目录（开发）
dsh plugin --profile <profile> add link:/path/to/dsh-vision
```

### 2. 配置视觉模型

准备一个 OpenAI 兼容的多模态端点（DeepSeek 官方 API 不支持图像输入，需独立视觉模型）：

```powershell
$env:VISION_API_KEY  = "sk-..."
$env:VISION_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"  # 阿里云百炼
$env:VISION_MODEL    = "qwen-vl-max-latest"
```

### 3. 使用

重启 `dsh`（`dsh web` 或 `dsh --profile cc-tui`），在对话中上传图片或提供文件路径，自然提问即可：

```text
看看这张图里有什么                  [附件: 报错截图.png]
登录按钮是可用还是置灰的？          [附件: 同一张截图]
把这张长截图里的聊天记录逐字提取出来
这两张设计稿有什么区别              [附件 x2]
```

标注、定位、放大检查等中间步骤由插件工具自动完成，无需显式指令。

## 工作原理

```text
  用户提供的图片
        │
        ▼
┌────────────────┐    ┌───────────────────────────────────────────┐
│ 元素标注        │    │              视觉工作记忆                  │
│ vision_map     │───►│  "7 号元素" = [x1:812, y1:341, x2:902, …] │
└────────────────┘    └──────────────┬────────────────────────────┘
                                     │ 按 ID 解析
                                     ▼
                          ┌────────────────────┐
                          │ 区域检查            │
                          │ vision_zoom        │
                          └────────────────────┘
                          裁剪区域单独上传，读取小字与状态

┌────────────────┐
│ 图像阅读        │   整图问答 / 逐字转写（长图自动分片合并）
│ vision_read    │
└────────────────┘
```

1. **标注**（`vision_map`）：视觉模型识别图像中的可交互与信息性元素，插件按阅读顺序分配连续 ID，存入视觉工作记忆
2. **引用**：主模型以编号引用元素，工具将编号解析为像素坐标
3. **放大**（`vision_zoom`）：目标区域本地裁剪（可选放大）后单独上传，在小区域内达到原始分辨率识别效果
4. **阅读**（`vision_read`）：整图问答与逐字文字提取；超长图片自动分片，逐条转写后按精确行匹配合并
5. **验证**（`vision_check` / `vision_diff`）：断言与图像证据逐条比对；改动前后像素级对比，量化迭代进度

## 工具参考

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `vision_map` | `image`\*, `focus`, `region`, `maxItems`, `annotate` | 生成编号元素清单（ID + 标签 + 逐字文字 + 置信度 + 像素框）并写入视觉工作记忆；`focus` 按种类过滤，`region` 限定标注范围；`annotate` 输出带框标注的证明图（`<stem>.annotated.png`） |
| `vision_read` | `images`\*, `mode`\* (`ask`/`transcribe`), `question` | `ask` 模式回答针对性问题（多图单次调用对比）；`transcribe` 模式逐字提取全部可见文本，长图自动分片合并 |
| `vision_zoom` | `image`\*, `question`\*, `ref`/`region`（二选一）, `scale` | 定向检查单个元素；`ref` 引用标注结果（如 `"7"` 或 `"7@imageId"`），`region` 指定原始像素盒；`scale` 2-8 倍最近邻放大 |
| `vision_check` | `image`\*, `claims`\* | 声明验证：将自然语言断言与图像证据比对，逐条返回 supported / contradicted / unverifiable + 理由 |
| `vision_diff` | `a`\*, `b`\*, `tolerance` | 像素级对比两张图（本地确定性，零 API 成本，PNG/JPEG/GIF/BMP 任意组合）：差异百分比 + 最差区域框，支持迭代裁决（"6.04% → 0%"） |

`*` 为必填参数。

随包注册的 `visual-memory` 技能提供工作流指导：标注优先、按编号引用、充分性规则（信息不足时要求定向检查而非推测）、断言前验证、改动用 diff 量化、禁止编造视觉细节。

## 配置参考

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `VISION_API_KEY` | ✅ | 视觉模型 API Key |
| `VISION_BASE_URL` | ✅ | OpenAI 兼容端点（百炼、智谱、SiliconFlow、OpenRouter 等） |
| `VISION_MODEL` | ✅ | 主视觉模型 |
| `VISION_MODEL_MAP` | | `vision_map` 任务专用模型（空则使用主模型） |
| `VISION_MODEL_READ` | | `vision_read` 任务专用模型 |
| `VISION_MODEL_ZOOM` | | `vision_zoom` 任务专用模型 |
| `VISION_MODEL_CHECK` | | `vision_check` 任务专用模型 |
| `VISION_FALLBACKS` | | 回退端点链（JSON 数组，如 `[{"baseURL":"https://open.bigmodel.cn/api/paas/v4","apiKey":"...","model":"glm-4v-flash"}]`）——主端点失败后依次降级，可把免费端点排后面省成本 |
| `VISION_LANG` | | 视觉输出语言：`zh` / `en`（默认 `zh`） |

### profile 配置（优先级高于环境变量）

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: dsh-vision
  config:
    apiKey: 'sk-...'
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    model: 'qwen-vl-max-latest'
    lang: zh
    timeoutMs: 180000   # 单次请求超时
    maxEdge: 2048       # 上传长边像素上限，超出自动均值池降采样
```

修改后重启生效。配置缺失时工具返回明确错误提示，不会静默失败。

## 隐私说明（数据传哪了）

本插件不截屏、不扫描、不自动上传任何东西：

- **只发送你显式提供的图片**——聊天附件或你给出的文件路径
- **只发往你配置的端点**——`VISION_BASE_URL`（及回退链里的端点），不经过任何第三方中转
- **零本地缓存外泄**——视觉工作记忆是进程内缓存，重启即清空；标注证明图（`<stem>.annotated.png`）写在你图片所在的同一目录，由你处置
- **完全本地化可选**——把 `VISION_BASE_URL` 指向本机 OpenAI 兼容服务（Ollama / LM Studio + Qwen-VL 等），图片不离开这台机器

确定性工具（`vision_diff`、裁剪、放大、分片）在本地完成，不产生任何网络请求。

## 设计决策

- **模型不得推测**：提示词要求视觉模型在细节不可读时声明需要放大的区域（`INSPECT` 提示），而非给出未经证实的答案；技能同时约束主模型不得引用未经工具确认的视觉细节
- **编号由插件分配**：视觉模型仅返回元素与边界框，编号由插件按阅读顺序分配，保证 ID 连续、稳定、可引用
- **坐标归一化**：内部统一 0-1000 归一化坐标与视图变换，预处理（降采样、区域裁剪、分片）对模型与主模型双方透明
- **结构化输出约束**：JSON 输出不设置 `max_tokens`（避免截断），grounding 与转写任务使用 temperature 0，响应做宽容解析（围栏代码、键别名、正则回退）与后处理（边界裁剪、IoU 去重、阅读顺序排序）
- **确定性操作优先**：区域裁剪等像素操作在本地完成，不产生 API 成本
- **格式无关的解码层**：PNG/JPEG/GIF/BMP 统一解成 RGBA（JPEG 支持基线 + 渐进式 + EXIF 方向，色度上采样用 libjpeg 三角滤波），裁剪、放大、降采样、分片、像素对比对所有格式行为一致
- **不重绘就不重编码**：PNG/JPEG 在无需缩放与旋转时按原始字节上传，避免二次压缩损失质量、也避免上传体积膨胀（只有需要搬动像素时才转 PNG）

## 设计参考

设计决策基于已发表研究：编号标注（Set-of-Mark）、由粗到细检索（V\*/SEAL）、声明验证（Woodpecker）、长图分片（Monkey / LLaVA-UHD）、归一化坐标（OS-Atlas）。论文列表与工程实践来源见 [REFERENCES.md](REFERENCES.md)。本插件为独立的 TypeScript 实现，未复用任何现有项目的代码或提示词。（非佬，拿ai做的玩具，凑个热闹（一开始准备装agent-vision-toolkit的，但是我看好多人说有bug，后面就想着基于这个改成dsh插件，再后面一想，都准备做了，就让ai调研一下做了个玩具，也算是个人第一个项目了😭））。

## License

[MIT](LICENSE)
