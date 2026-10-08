# Repository Visual Explainer

一个用于理解代码仓库的 Codex skill：生成有源码证据的多视图关系图，在浏览器中选中节点或连线，向 AI 提问，或让 AI 更新图和说明。

开发与发布仓库：[Hash012/repo-visual-explainer](https://github.com/Hash012/repo-visual-explainer)。Skill 入口是 [SKILL.md](SKILL.md)。

## 界面预览

以下是实际浏览器界面的截图。图谱、问答和修改内容均来自独立虚构的任务工作流，使用预设演示回答；不包含任何实际项目源码、架构资料或私有数据，也不代表真实模型输出。

### 仅问答

左侧切换视图，中间选择节点或连线，右侧查看职责、源码引用和对话。问答模式解释所选部分，保持图数据不变。

![仅问答模式：选择检查节点，右侧显示说明、来源和演示回答](docs/images/ui-qa.png)

### 修改可视化

针对同一个问题补充异常分支、拆解步骤或增加解释视图；图与文字同步更新。金色虚线标记本次变化，可撤销修改。

![修改可视化模式：新增空任务异常分支，并同步更新图与演示回答](docs/images/ui-edit.png)

## 功能

| 能力 | 行为 |
| --- | --- |
| 多视图关系图 | 从端到端总览展开调用、数据、状态、生命周期与失败路径，按仓库实际复杂度选取视图 |
| 源码证据 | 节点和重要关系引用仓库相对路径与行段，区分已核对、推断、规划和阻塞 |
| 元素选择 | 节点与连线可点击、键盘选择和多选；跨视图链接定位具体元素 |
| 仅问答 | 浏览器显示 AI 回答，服务拒绝问答响应中的图修改 |
| 修改可视化 | 更新当前视图或增加解释视图；校验通过后应用，保留其他视图并支持撤销 |
| 导航与导出 | 平移、缩放、适配画布、深链接、刷新恢复，导出当前 SVG 与图谱 JSON |

质量标准见 [references/quality.md](references/quality.md)。图的事实与可读性仍需按源码和实际界面复核；结构校验不替代事实验证。

## 安装与使用

运行环境：Linux/macOS 等 POSIX 系统、Python 3.10+、浏览器，以及已安装并登录的 Codex CLI。页面服务使用 Python 标准库，无需 npm、pip 或 CDN。当前桥接依赖 CLI 的 `--ignore-user-config` 等参数，兼容要求见 [运行说明](references/runtime.md)。

把仓库克隆到个人 skills 目录；已有同名目录时先确认其用途，不要覆盖自己的改动：

```bash
skill_root="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$skill_root"
git clone https://github.com/Hash012/repo-visual-explainer.git "$skill_root/repo-visual-explainer"
```

重新打开 Codex 会话，在需要理解的目标仓库中请求：

```text
使用 $repo-visual-explainer 为当前仓库生成可交互关系图。
重点说明入口、数据流、状态变化和失败路径，并打开浏览器。
```

Skill 会调查代码、制作 `atlas.json`、核对来源并启动本地服务。进入页面后选择元素，切换「问答」或「修改图谱」，输入问题并发送。Ctrl / ⌘ / Shift 点击可多选。

浏览器通过独立 Codex CLI 任务获得回答，不自动连接到发起 skill 的原始聊天线程。修改模式更新可视化与说明，不编辑目标仓库源码。

已有图谱时也可手动启动；请替换下面三个绝对路径，图谱输出目录放在目标仓库外：

```bash
python3 /path/to/repo-visual-explainer/scripts/validate_atlas.py \
  /path/to/output/atlas.json --repo /path/to/target-repo
python3 /path/to/repo-visual-explainer/scripts/serve.py \
  --repo /path/to/target-repo --atlas /path/to/output/atlas.json --open
```

使用服务打印的 `http://127.0.0.1:<port>/` 地址；直接打开 HTML 文件无法聊天。无桌面或远程环境中按 [运行说明](references/runtime.md) 转发同一端口。终端 Ctrl+C 停止服务。

## 数据与维护边界

本仓库维护通用 skill、浏览器资源、运行脚本与文档。目标仓库的源码、实例图谱、聊天记录和历史版本不应提交到这里。README 截图只展示合成示例。

服务仅监听本机回环地址，源码查看接口限制为图谱已有引用的文件行段。AI 任务使用 Codex 的 read-only 写入隔离；只读目标仓库的范围是任务指令，并非操作系统级读取封锁。实例上下文会交给所用模型处理，具体边界见 [运行说明](references/runtime.md)。

`atlas.json` 是初始图谱；运行后相邻的 `atlas.json.bridge-state.json` 保存当前图、最近对话及撤销历史。导出按钮获得当前图谱，不应把初始文件误认为更新后的版本。

## 开发与验证

| 目录或文件 | 职责 |
| --- | --- |
| [SKILL.md](SKILL.md)、[agents/openai.yaml](agents/openai.yaml) | Skill 工作流与发现信息 |
| [assets/](assets/) | 浏览器界面与图谱/响应 schema |
| [scripts/](scripts/) | 本地服务、图谱校验与回归测试 |
| [references/](references/) | 质量标准、数据契约和运行约束 |
| [docs/images/](docs/images/) | 公开说明用的合成示例 UI 截图 |

在独立开发检出中运行：

```bash
python3 scripts/test_bridge.py
node --check assets/app.js
```

Node 仅用于开发时的 JavaScript 语法检查，不是运行服务的依赖。当前回归覆盖问答不改图、可见修改、来源与布局校验、版本冲突、持久化、撤销、实例互斥及失败恢复；测试使用临时合成仓库，不替代真实模型和浏览器验证。
