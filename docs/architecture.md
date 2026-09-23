# v0.5 架构与 Blockbench 适配

## 依赖边界

Domain/Application 保持不依赖 Blockbench、Three.js、Electron、Vue 或 DOM。业务层提供 Image／Frame 文档、布局计算、像素生成、命中策略和编辑事务；所有宿主对象访问集中在 Blockbench 适配器。

文档保持 schemaVersion 1，但严格接受当前结构，不提供旧数据迁移。文件载体仍为 Generic Model `.bbmodel` 的 `unhandled_root_fields.mcui_studio`，标准几何和内嵌贴图负责无插件显示。

## Image／Frame 与角色绑定

Image 与 Frame 都有稳定逻辑 ID、children 和 LayoutSpec。Image 有内容与外观，可包含 Image／Frame；Frame 仅负责布局，FrameSpec.engineType 明确为 panel 或 stack_panel，且必须与 direction 相符。Image 的 Hug 取自身素材尺寸；Frame 的 Hug 计算真实流式子项。

NativeBinding 保存 containerId、可选 surfaceId、textureId 和指纹。每个 Image 对应一个原生 Group＋内容 Cube，Frame 对应一个原生 Group。逻辑 ID 不要求等于任何原生 UUID；内容 Cube 不进入逻辑 children 或布局计算。

原生场景读取折叠受管理的内容 Cube，返回业务树快照。原生新增 Cube 在完成原生编辑前包装为 Image，新增 Group 成为 Frame。原生复制通过临时来源／角色标记识别对应内容载体，重绑 UUID 并生成独立成品贴图；标记不作为保存权威数据，编译时剥离。

内容载体缺失、移出，或 UV／贴图／显示状态被独立修改时暂停相关规则，保留现场；显式重新生成可修复载体。三维旋转继续使用差异保护。未安装插件期间的修改不被自动烘焙覆盖。

## 宿主接触面

- NativeHost：原生对象生成、快照、纹理与绘画会话、历史和临时网格位移。
- OutlinerView：注册 node_display_rules，隐藏内容载体，设置受管理 Group 实例图标；退出、切换项目及卸载恢复原始属性。没有替换 Vue 树或覆盖宿主原型。
- PropertyBridge／注册 FormElement：沿用原生元素、布局和内容标签。Image 与 Frame 的属性代理均注册在 Group 上，内容 Cube 只保留临时角色标记。
- ViewportController：屏幕／世界坐标转换、Frame 名称测量、指针事件、相机和 SVG 辅助。
- 应用层 targets：纯数据的点击与放入候选判断，分别处理名称／边框／图像命中、层级优先级、Stack 插入位置及排除选区后代。
- tree-editing：纯数据改父级和世界矩形保留，重算百分比对应的像素分量。

大纲本身、拖拽、菜单、框选与宿主显示能力继续复用原生机制。SceneSnapshot 的 selection 将原生 Group 递归选中的内容合并成显式逻辑选区。绘画时仅选择 Image 自己的内容 Cube，退出绘画恢复容器选区。

## 事务与预览

应用命令拥有独立 Undo；原生属性、大纲及原生新增操作在既有 Undo 内协调，禁止嵌套事务。Undo 初始快照必须在开始时包含 selection，结束阶段不能临时追加过期选区快照。

移动手势开始时仅保留逻辑文档快照，通过 ScenePort.previewMove 改变 Three 场景的临时显示位置。不写文档、不重烘焙，也不创建 Undo 编辑。放入目标基于原始逻辑场景，排除选区及后代，避免移动载体遮挡检测。

松手时恢复临时显示，再以单次事务提交移动／排序／换父级及派生布局。无合法目标保留父级；失败或取消恢复开始状态。缩放继续使用已有受控编辑事务。临时状态和偏好不写入模型。

自动放入默认开启，使用合并写入的本机偏好。关闭仅禁止视口换父级；Stack 内排序及大纲拖入仍可用。普通项目、绘画和透视模式保留宿主行为。

## 像素与视图辅助

图片适配、九宫格、渐变和描边继续生成标准纹理；rasterSize 将贴图分辨率与几何尺寸解耦。自定义 SVG 只绘制像素网格、选中框、悬停轮廓、名称、测距和插入提示，不进入模型或原生截图。

Frame 名称使用稳定 DOM 节点与固定屏幕字号，屏幕坐标量化到 0.01px 避免相机浮点抖动引发持续重建。原生网格隐藏通过独立 UiGrid 适配器处理，所有状态可在卸载时恢复。

## 宿主基线与验证

Blockbench 5.2.1 / e2ede0809ee6bc91f374ac7e00d34cffbdf86a14。升级时先在隔离缓存宿主验证角色绑定、原生编辑历史、大纲过滤、绘画、选择和指针取消，再替换适配器中的具体接口。
