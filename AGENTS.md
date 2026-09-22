# MC UI Studio 开发约定

- 阅读 `docs/architecture.md` 和 `docs/implementation-plan.md` 后修改功能。
- Domain/Application 禁止引用 Blockbench、Three.js、Electron、Vue 和 DOM；新增宿主能力先定义纯数据端口。
- 所有 Blockbench 接入只放在 `src/adapters/blockbench`，不要通过覆盖宿主原型或修改上游源码快速解决问题。
- 显示结果必须由标准 Cube/Group/Texture 表达；图片和九宫格生成结果必须持久化。
- 原生编辑与插件参数更新必须在同一 Undo 中，外部修改不能被自动覆盖。
- 新功能或修改后运行 `npm run check`；宿主接入、保存、绘画和交互变更还要运行 `npm run test:host`。
- 真实宿主测试使用独立缓存副本和浏览器上下文。不要安装到用户正在使用的 Blockbench 配置目录。
- 自动化事件测试不等同于真实 Mac 触摸板手感验证；在验证记录中区分两者。
