# v0.7 架构与 Blockbench 适配

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

## v0.6 拖拽绘制

应用层 DrawingMachine 只保存起点、目标容器和整数矩形草稿，处理反向拖拽、Shift／Alt 和 Space。previewDrawing 用浅复制的逻辑树计算最终布局，不生成纹理；Studio.createDrawn 在唯一事务内创建节点、透明绘画源、标准宿主对象和选择。

Frame/Image 注册为原生 Tool 并加入 tools 工具栏。快捷键通过原生 press_key 的 capture 接口在 MC UI 二维设计上下文优先分发，沿用当前 Keybind 配置。modes 使用空列表配合显式条件，阻止原生未命中快捷键的工具回退路径擅自切换到编辑模式；不改原版旋转键绑定或宿主原型。

ViewportController 统一取消移动与绘制草稿、释放指针捕获。绘制父级在 pointerdown 确定，提交时再次验证；目标失效只显示错误并放弃创建。弹窗、输入、模式和项目边界独立处理。卸载或项目切换时仅恢复仍注册且可用的工具，防止选择已注销的工具实例。

## v0.6.1 零厚度内容平面

内容 Cube 的 from.y 与 to.y 均为解析后的 depth，Y 尺寸为 0，层级由不同的 Y 高度表达；只有 up 面绑定贴图。原生异常检测接受零厚度并保护独立增加的厚度，几何校验结果不能因像素／布局指纹未变化而跳过。

Blockbench 5.2.1 的 Cube 预览控制器会给零尺寸轴内部增加 0.001，以便生成渲染几何。该行为不修改 Cube 数据或保存内容；插件不覆盖宿主几何生成。

## v0.7 原生属性面板组合

PropertyBridge 只负责原生 Property 代理、选择映射、元素页双轴输入与保存剥离。property-fields 保存共享的字段读写规则；InspectorPanels 将它们组合成原生 Panel/InputForm 中注册的全宽 FormElement，InspectorControls 管理草稿输入、九点控件与原生 ColorPicker 生命周期。没有移动宿主其它表单的 DOM、修改宿主原型或引入独立工作台。

application/inspector 提供不依赖 DOM 的混合值、摘要、适用上下文与复合属性修改。水平/垂直内边距和锚点预设明确控制修改范围；普通字段仍调用原有写入规则与 Studio.validateChange/execute。无效规则不会先写入模型。

界面状态（偏好的原生标签、展开的分组）合并保存到本机 mcui_preferences.inspector，不进入文档、schema 或 Undo。输入记录项目及选区 key，切换后废弃旧草稿。取消颜色编辑与卸载清理选择器；Spectrum 的输入过程只更新本地颜色，最终关闭后核对原值及选区再一次提交。样式、九宫格与贴图分辨率继续写标准纹理。

已有内容预览对话框新增源图切线，对比生成结果；Crop 参数按模式显示。确认前参数只存在对话框，确认时校验项目、目标快照，再执行一次事务；卸载清理打开的对话框。

## 2D 大纲工具栏

OutlinerToolbar 仅在 MC UI 的顶视正交编辑态，通过工具栏局部 CSS 排序和隐藏按钮，并为 outliner 实例设置原生 Menu。Toolbar.children、Action.condition、保存的工具栏排列与宿主原型均不改动。模式／项目切换和卸载移除局部样式、恢复原菜单；原生新增子菜单过滤本插件已提供的操作，避免 Action.menu_node 在同一菜单树重复出现。

## 文字内容扩展（Content API 1）

`Blockbench.mcuiStudio.contents` 是外部插件的版本化接入面，提供 register、inspect、owner、create、update、begin/preview/finish、rasterize、regenerate。外部插件不调用 Studio/NativeHost 内部诊断接口。内容提供者准备字体后同步提供 measure/render，seal/fallback 在宿主适配器隔离原生指纹与剪贴板成品获取。

GeneratedRecipe 保存 provider、成品 source、logicalSize 和 renderedKey。data 只存在运行时草稿，文件中从当前或归档内容 Cube 的 Property 及项目恢复副本恢复；UI 文档不重复保存可编辑文字参数。原生对象发布、贴图、恢复副本与字体资源共用一次 Undo；没有提供者时保留已生成像素。图层复制后重新渲染使用新源，不覆盖共享原图。

布局引擎通过纯数据 ContentMeasure 在 Hug 高度计算中解析实际宽度，沿用循环检测。图片/九宫格/绘画的原有策略不变。新版素材摘要区识别文字并提供编辑入口，图片裁切与九宫格按钮对文字隐藏；文字插件自己的原生标签承载字体和排版属性。

## Figma 工作区停靠

WorkspaceLayout 独立封装原生 Panel 的停靠与折叠。仅在 MC UI + Figma + edit 状态转换时应用：大纲移到左栏首位、属性宿主移到右栏、UV/纹理宿主折叠。使用 moveTo/customizePosition/fold/updateInterfacePanels，不改宿主原型、不手动搬运未知面板 DOM。

进入前保存原生 edit 模式的面板位置对象，记录本轮实际改变的字段；退出时只恢复这些字段，保留其它面板与标签状态。原生 moveTo 可能改变原侧栏可伸缩面板的 fixed_height，因此一并追踪其变化。选区变化不重新应用布局，手动展开 UV 后继续选择不会再次折叠。绘画／项目切换在 unselect 事件中先恢复 edit 布局，避免把 edit 状态写进 paint 模式。

PropertyBridge 在属性标签集合变化后补齐 updateInterfacePanels，令原生侧栏顺序与配置同步，而非只更新单个属性宿主。此行为也覆盖原生交互样式。

## 上下文快捷键

shortcuts 适配器注册原生 Action/Keybind，读取用户当前键位并在允许的二维编辑上下文通过 press_key.capture 阻止宿主重复执行；卸载清理原生命令和菜单。layout-commands 为纯应用逻辑，Frame 原地启用、普通选区包裹、移除时保留边界均走现有单次事务。视图聚焦不写文档。

## 数值输入交互

stepExpression 纯数据转换保留百分比，input-step 与 input-scrub 适配器统一键盘步进和指针状态；后者处理局部预览、速度档位、捕获、取消及生命周期。InspectorPanels 的写入在拖拽期间转到 Studio.previewGesture；元素页 PairDraft 使用同一应用事务提交，避免原生中间值回读将百分比还原为固定值。显式原生 Property 接口仍保留。

预览对话框复用相同输入手势但只改本地 form，确认才写文档。宿主项目离开事件发生时全局 Project 可能已清空；NativeHost.cancel 使用原项目 Undo，并在非活动状态通过原生 whenNextOpen 回调恢复，避免向下一项目回放撤销。

## 文件创作技能

`skills/ui-studio-bbmodel` 提供 AI 说明、设计描述、CLI 和独立宿主桥。CLI 只负责本地路径、PNG、临时 loopback 服务、无头 Chrome 和原子输出；host-bridge 复用纯布局/像素内核及 NativeHost，输出由 Blockbench codec 序列化。编译后再在全新页面重开检查 fingerprint/暂停规则，避免只更新逻辑或只更新原生数据。

--base 以逻辑 ID 保留绑定及原生绘画层；显式替换某个源图才使该源的绘画层备份失效。输入不是部分补丁，而是完整目标树。未加载 provider 时，第三方 generated 内容仅在几何/规则/层级深度未受影响时保留。显式加载本地文字插件后，桥通过 Content API 1 注册实际 provider，复用其字体准备、测量、烘焙及 seal；文字参数仍以 Cube 与恢复副本为权威。桥接代码由 tsconfig.authoring.json 参与类型检查，不被打包进运行时插件。

## 原生 UI 文件显式转换

文件工具新增 convert-source 宿主桥，先通过原生 codec 与文字插件 convertLegacy 读取，再按选定顶视方向烘焙纹理。叶子以真实世界 Y 排序，通过连续原 Group 路径重建 Frame，避免文件夹深度交错导致背景遮挡。三维 Group 只在 flattenGroups 显式列出时压平；非正向文字拒绝隐式旋转。转换只是文件创作工具，不修改运行时插件或放宽 schemaVersion 1 校验。

CLI 提供字体文件内嵌、fontMap、转换报告、局部预览和预览倍率；build/extract 的 text 描述由 provider 处理。每次生成仍经干净宿主重开验证，输出不覆盖原文件，私有转换素材不进入仓库。

## 复杂项目属性查询（0.8.2）

原生Property.condition也会在Group撤销副本的构造/reset/copy阶段执行；副本有UUID，但起初没有插件角色标记。PropertyBridge按当前文档bindings对象建立UUID反查索引，同步支持真实对象、撤销副本和选择解析；文档替换时重建，避免每个字段重新扫描全部绑定。hydrate每次只计算一次选区摘要和原生对象表。

撤销仍保留完整原生事务，未改变差异保护、几何/纹理/字体保存契约。文字插件的临时传输资源另外采用宿主instance Property与不可变共享快照，减少复制开销，不依赖改写宿主原型。
