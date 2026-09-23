# UI Studio for Blockbench

面向二维界面与像素美术的开源 Blockbench 插件。复用原生绘画、大纲和纹理工具，提供 Figma 风格的编辑交互、嵌套图层、自动布局和九宫格，适合游戏 UI 与通用像素界面设计。

设计保存为标准 `.bbmodel`：图层由原生 Group、零厚度 Cube 和内嵌贴图组成，**未安装插件也能查看最后保存的设计**。重新计算布局、九宫格和文字需要相应插件。

## 主要能力

- **Image / Frame**：Image 可绘制并包含子元素；Frame 负责自由布局或横向、纵向自动布局，支持间距、内边距和对齐。
- **布局表达式**：位置与尺寸支持百分比＋像素偏移，例如 `100% - 16px`，以及 Fill、Hug 和锚点。
- **像素与素材**：原生绘画、图片适配、九宫格烘焙、纯色/渐变填充、描边，以及独立于显示尺寸的贴图分辨率。
- **编辑交互**：拖绘 Frame / Image（A / R）、八点缩放、框选、测距、拖入容器、自动布局快捷键（Shift+A）和原生撤销。
- **可编辑文字**：配合 [BBModel Text Component](https://github.com/EaseCation/blockbench-bbmodel-text)，支持嵌入字体、文字排版和重新烘焙；成品仍是标准 Cube 与 PNG。
- **AI 文件创作**：内置 Skill 和脚本，可直接生成、编辑、转换及校验 `.bbmodel`，并输出预览图。

当前侧重静态 UI 创作，暂不提供游戏运行时导出、Grid、裁切或多人实时协作。完整操作说明见 [使用指南](docs/user-guide.md)。

## 从稳定 URL 安装

在 Blockbench 的插件管理器中选择“从 URL 加载插件”，粘贴：

```text
https://easecation.github.io/blockbench-ui-studio/mcui_studio.js
```

[下载页面](https://easecation.github.io/blockbench-ui-studio/)也提供 `latest.js` 下载别名和[版本信息](https://easecation.github.io/blockbench-ui-studio/version.json)。安装时推荐使用上方保留插件 ID 的文件名。

每次推送到 `main`，GitHub Actions 会执行格式检查、类型检查、单元测试和构建，通过后自动更新稳定地址；PR 只验证并上传构建产物，不发布。也可手动运行 CI 工作流。CDN 更新可能有短暂延迟。

## 构建与加载

需要 **Node.js 22+**；插件当前验证基线为 **Blockbench 5.2.1**，支持桌面版和 Web 版。

```sh
git clone https://github.com/EaseCation/blockbench-ui-studio.git
cd blockbench-ui-studio
npm ci
npm run build
```

输出文件为 `dist/mcui_studio.js`。在 Blockbench 的插件管理器中选择“从文件加载插件”，加载该文件，然后从开始页的 **新建 → UI 设计** 创建项目，也可以使用 **工具 → 新建 UI 项目**。

普通插件构建不需要 Blockbench 源码。开发时运行 `npm run dev` 监听变化，完成构建后在 Blockbench 中重新加载插件。`dist/` 不纳入本仓库版本管理。

## 检查与测试

```sh
npm run check         # 依赖边界、类型、单元测试与构建
npm run format:check  # 格式检查
npm run test:host     # 独立 Blockbench Web 宿主集成测试
```

宿主测试额外需要系统 Google Chrome 和已构建的 Blockbench Web 测试副本；准备步骤见 [测试宿主](docs/testing.md)。测试使用独立浏览器上下文，不接入用户正在编辑的桌面项目。

## AI Skill

入口为 [`skills/ui-studio-bbmodel/SKILL.md`](skills/ui-studio-bbmodel/SKILL.md)。它与仓库实现一起维护，依赖本仓库的 `src/`、Node.js 依赖和测试宿主，不能只复制技能目录后独立运行。

```text
skills/ui-studio-bbmodel/
├── SKILL.md                   # AI 工作流程与编辑边界
├── agents/openai.yaml         # 技能发现与提示配置
├── references/                # 设计格式、环境、保存契约、文字与转换说明
├── assets/example.design.json # 可生成的设计示例
└── scripts/
    ├── ui-file.mjs            # build / inspect / extract / validate / convert
    ├── host-bridge.ts         # 复用布局、渲染与原生保存实现
    └── convert-source.ts      # 原生平面 UI 的显式转换
```

准备好[脚本环境](skills/ui-studio-bbmodel/references/setup.md)后，可在仓库根目录运行：

```sh
npm run ui:file -- build skills/ui-studio-bbmodel/assets/example.design.json --out work/example.bbmodel --preview work/example.png
npm run ui:file -- inspect work/example.bbmodel
npm run ui:file -- extract work/example.bbmodel --out work/edit.design.json
# 修改完整的 edit.design.json，再按原逻辑 ID 更新已有设计：
npm run ui:file -- build work/edit.design.json --base work/example.bbmodel --out work/edited.bbmodel
npm run ui:file -- validate work/edited.bbmodel
```

脚本在隔离宿主中生成原生载体，重新打开校验后才写出模型。设计描述是**完整目标树而非局部补丁**；编辑时保留未修改节点的 ID。可编辑文字需通过 `--text-plugin /path/to/bbmodel-text-component.js` 加载实际文字插件，并提供所需字体。

- [设计描述格式](skills/ui-studio-bbmodel/references/design-format.md)
- [文字与字体](skills/ui-studio-bbmodel/references/text-content.md)
- [普通 Blockbench UI 转换](skills/ui-studio-bbmodel/references/legacy-conversion.md)
- [保存契约与差异保护](skills/ui-studio-bbmodel/references/bbmodel-contract.md)

## 代码结构

`src/domain` 处理文档、布局和像素；`src/application` 处理命令与事务；`src/adapters/blockbench` 封装宿主对象、交互和面板。业务内核不依赖 Blockbench、Three.js 或 DOM，便于在宿主升级时集中适配。详见 [架构说明](docs/architecture.md)。

## License

[MIT](LICENSE)。Blockbench 和可选文字插件为独立项目，分别遵循各自许可证。
