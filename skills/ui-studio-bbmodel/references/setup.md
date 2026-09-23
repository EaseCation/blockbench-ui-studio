# 脚本环境

此技能随 UI Studio 仓库维护，脚本从当前位置向上三层找到仓库。它不是可单独复制到任意位置就工作的通用包：需要仓库 src、package.json 和安装好的依赖。

## 基本要求

- Node.js 22+；在仓库根目录执行 `npm ci` 安装锁定依赖。
- 系统 Google Chrome。其它 Chromium 可通过 `MCUI_CHROME_PATH` 指定可执行文件。
- 已构建的 Blockbench 5.2.1 Web 宿主。默认使用仓库 `.cache/blockbench`，至少包含 `index.html`、`dist/bundle.js` 及其静态资源。也可设置 `MCUI_HOST_DIR=/absolute/path/to/built-blockbench`。

仓库通常已有测试缓存；先检查，不必重新构建。若缺少，请依仓库 `docs/testing.md` 和所用 Blockbench 版本的官方构建说明准备宿主。不要仅把未构建的源码目录当作 Web 宿主，不要修改用户正在使用的配置目录。

```sh
node skills/ui-studio-bbmodel/scripts/ui-file.mjs --help
MCUI_HOST_DIR=/path/to/built-blockbench node skills/ui-studio-bbmodel/scripts/ui-file.mjs validate file.bbmodel
```

脚本启动一个随机端口的 loopback 静态服务、独立的无头 Chrome 临时上下文；阻断宿主向外网加载资源，退出时关闭浏览器和服务。不会加载桌面用户配置，不要求安装插件到用户的 Blockbench，也不会调用外部 MCP。

PNG 文件相对 `design.json` 所在目录解析；输出路径相对当前工作目录解析。不接受远程素材 URL；先在用户授权范围内准备本地素材。支持标准 PNG，输入源图每张最多 1600 万像素，全部源和全部渲染贴图各最多约 3200 万像素；预览画布最多 1600 万像素。大项目可分成多个画板文件，而不是关闭限制后强行生成。

## 命令职责

- `inspect`：只读 JSON 结构摘要，不启动宿主；它不是有效性证明。
- `extract`：先检查原生映射与差异保护，再导出可编辑设计描述；素材默认内嵌以方便移动文件。
- `build`：创建或按 `--base` 更新完整模型；先在新页面重新打开成品验证，最后原子写入文件。
- `convert`：显式转换普通原生平面 UI，输出设计描述、模型和报告；见 legacy-conversion.md。
- `validate`：只读验证原生/逻辑一致性，可额外输出 PNG 预览。

输出报错时退出码非零，不应把异常堆栈当作成功。默认不覆盖已有文件；`--force` 会在同目录创建 `.bak-时间戳` 备份。脚本不会执行设计描述中的代码。

文字创建/编辑需显式传入本地 `--text-plugin`。字体文件相对设计或转换选项 JSON 解析并内嵌；脚本不联网寻找字体。
