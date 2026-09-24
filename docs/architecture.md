# v0.7 架构与 Blockbench 适配

## 依赖边界

Domain/Application 保持不依赖 Blockbench、Three.js、Electron、Vue 或 DOM。业务层提供 Image／Frame 文档、布局计算、像素生成、命中策略和编辑事务；所有宿主对象访问集中在 Blockbench 适配器。

文档保持 schemaVersion 1，但严格接受当前结构，不提供旧数据迁移。文件载体仍为 Generic Model `.bbmodel` 的 `unhandled_root_fields.mcui_studio`，标准几何和内嵌贴图负责无插件显示。

## Image／Frame 与角色绑定

Image 与 Frame 都有稳定逻辑 ID、children 和 LayoutSpec。Image 有内容与外观，可包含 Image／Frame；Frame 仅负责布局，FrameSpec.engineType 明确为 panel 或 stack_panel，且必须与 direction 相符。Image 的 Hug 取自身素材尺寸；Frame 的 Hug 计算真实流式子项。

NativeBinding 保存 containerId、可选 surfaceId、textureId 和指纹。每个 Image 对应一个原生 Group＋内容 Cube，Frame 对应一个原生 Group。逻辑 ID 不要求等于任何原生 UUID；内容 Cube 不进入逻辑 children 或布局计算。

原生场景读取折叠受管理的内容 Cube，返回业务树快照。原生新增 Cube 在完成原生编辑前包装为 Image，新增 Group 成为 Frame。原生复制通过临时来源／角色标记识别对应内容载体，重绑 UUID 并生成独立成品贴图；标记不作为保存权威数据，编译时剥离。

内容载体缺失、移出，或 UV／贴图／显示状态被独立修改时暂停相关规则，保留现场；显式重新生成可修复载体。非 UI 平面的 X/Z 旋转以及内容 Cube 独立旋转继续使用差异保护。未安装插件期间的修改不被自动烘焙覆盖。

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

仅根级Frame生成名称标签与标签命中区域；嵌套Frame保留边框/控制点及独立放入提示。Frame 名称使用稳定 DOM 节点与固定屏幕字号，屏幕坐标量化到 0.01px 避免相机浮点抖动引发持续重建。原生网格隐藏通过独立 UiGrid 适配器处理，所有状态可在卸载时恢复。

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

## CI 静态发布

GitHub Actions在PR和main验证格式、业务边界、类型、单元测试及构建。prepare-pages脚本校验插件注册ID，生成含稳定JS、下载别名、source map、MIT许可和版本/提交/SHA-256信息的静态站点。仅main的通过构建可部署GitHub Pages；部署权限限定在deploy job，PR不获取发布权限。运行时和模型结构不变。

## 统一性能边界（0.8.3）

BindingIndex按bindings对象引用统一反查逻辑ID，用于属性、内容API、视口和选区。NativeHost在活动项目使用宿主OutlinerNode.uuids注册表，后台项目保留项目内查找。ProjectPort.selection只解析真实选区及原生祖先关系；场景快照继续独立负责完整几何与像素差异检查。

布局计算的flow列表与Fill分配按父级/轴在单次求解内共享，跨次布局重新计算，保留循环检测和共享边界量化。视口一次投影遍历只读一次canvas/node边界；命中几何缓存按文档/scene引用、相机矩阵、边界、选区、悬停及放入标签状态失效，归属于预览对象的WeakMap。

NativeHost的像素哈希以实际PNG输入为依据，每个Texture只保留最近一次结果；不改变指纹算法或绕过外部绘画检测。原生完整Undo继续保留，未引入对宿主原型或纹理解析规则的覆盖。实验脚本与当前测量见performance-round2.md。

## 编组与解除（0.8.4）

纯数据grouping模块处理逻辑Image/Frame，选区按原树顺序包装到公共祖先下的自由Frame；解组Frame提升子项，解组Image只释放逻辑子项，保留自身内容。递归解组保留全部Image、世界边界及有效显示/锁定状态。自动布局内允许连续流式子项编组；需要改变非连续流或向Stack直接提升子项时，明确要求先关闭父级自动布局。

Grouping适配器通过原生Action的use事件路由add_group/group_elements/resolve_group，不覆盖宿主原型。原生框选继续绘制和命中，mouseup捕获阶段补充完整包围的Frame，并在宿主记录selection_post前把逻辑Image映射回其Group。真正的载体独立编辑仍走差异保护。

NativeHost.apply先安置存活节点，再递归删除旧容器，避免Frame删除误删要提升的子组。Scene回读对失去容器但仍存活的已知内容Cube保留逻辑ID及素材绑定，普通操作中重建容器；冷加载仍保留原生差异保护。编组后的选区在同一编辑事务内提交；历史恢复重新读取原生选区，避免已恢复的Frame处于逻辑未选中状态。

## 层级框选（0.8.5）

application/marquee只接收文档、投影矩形及修饰状态。起手所在容器提供初始作用域，普通框选越出边界后向外扩大范围，将命中子项提升为作用域直属分支；深选去除命中集合的祖先，结果不同时包含父子。Shift沿用相同归并策略，隐藏/锁定/暂停沿祖先链过滤。

Viewport使用宿主startSelRect/moveSelRect/stopSelRect和原生选择历史。因Command/Ctrl加pointerdown会抑制兼容MouseEvent，手势开始后解除宿主本次注册的鼠标监听，由隔离的PointerEvent监听驱动现有辅助方法，不修改宿主原型。每次移动或修饰键变化同步最终逻辑选区及原生Group；松手只提交一条选择历史（若用户开启选择撤销）。

临时状态保存原项目、Undo对象、初始选区和pointer ID；Escape/失焦/模式/工具/弹窗/pointercancel清理监听并恢复选区；项目已切走时用原项目whenNextOpen延迟恢复，避免操作新项目的Undo。节点、贴图和布局数据不因框选改变。

## 层级选择与选区呈现（0.8.7）

application/selection-navigation 按逻辑树及解析后的可见性/锁定状态计算直接子级或父级；稳定顺序、去重和祖先消除保持在纯数据层。shortcuts 注册原生可重绑定 Action，沿用已有输入/模式/手势隔离与选择历史。

SelectionView 将递归原生选区与用户看到的显式选区分离：监听 Cube preview controller 的 update_selection 和 get_outliner_node_classes 注册事件，隐藏受管理载体的原生轮廓及继承选中行；SVG 显示显式选区矩形。切换模式/项目或卸载按宿主当前状态恢复，不改变用户选区、模型可见性、宿主原型或全局偏好。绑定缓存变化时才遍历载体，不在每帧重读像素。

Frame 名称呈现只应用 movePreview 的屏幕投影差值，保留命中/放入候选缓存的原始几何，避免移动中的载体影响目标检测；临时数据不进入模型或 Undo。

## 二维变换（0.9.0）

UiNode.rotation 为可选局部角度，省略即 0，schemaVersion 仍为 1。正数逆时针，对应原生 Group.rotation.y。layout 继续求解父级未旋转坐标系中的尺寸、百分比与 Stack 占位；transform 模块再累计各节点绕中心的旋转/平移，产生四边形和外接边界。旋转链保留浮点坐标以避免换父级时逐次像素漂移，宽高仍按像素量化。

NativeHost 把 Group.origin 与内容 Cube.origin 自动放在布局矩形中心，内容 Cube 保持零旋转。父子 Group 负责几何变换，Y 深度顺序、UV、纹理分辨率和文字像素不因旋转改变。原生 Group 的 Y 旋转可回读；内容 Cube 独立旋转、X/Z 倾斜和外部差异继续受到保护。

pickNode/marquee 使用凸四边形命中，Stack 插入区域转到父容器的投影坐标系。移动与缩放先反解父级/元素局部旋转；换父级、编组和解组保留视觉中心与世界角度。多选自由元素围绕共同中心旋转；多个 Stack 流式子项不提供绕共同中心的拖转，以免改变其布局约束，仍可在角度字段批量设置各自旋转。

InteractionMachine 管理连续角度累计、Shift 15°吸附与预览边界；现有预览事务只在尺寸/内容实际改变时生成贴图，角度变化沿用原像素。Overlay 的四角外侧命中区、旋转光标、选中框与读数属于编辑辅助。Escape、失焦、pointercancel、模式/项目切换恢复初始事务。

wheelZoom 使用 `exp(-0.12 * tanh(pixelDelta / 60))`：小增量近似线性，单事件倍率最多约 ±12%，正反输入互逆；倍率范围仍为 0.02..1000。视口以指针处世界坐标补偿相机，手势进行中不接管滚轮缩放。Figma 官方没有公开数值曲线，此处为鼠标滚轮调校的实现。Mac 捏合单独使用原有 `exp(-pixelDelta * 0.01)`，倍率边界相同。适配层在输入/面板守卫前追踪真实 Control 按键并在失焦时清除；Mac 像素单位 Ctrl-wheel 且没有物理 Control 按下时视为 Chromium 合成捏合，不按增量大小猜测设备。WheelEvent 没有标准设备类型，按住 Control 捏合或窗口未收到按键事件时无法完美区分。

## 智能吸附（0.10.0）

application/snapping 接收纯文档/场景及矩形，构造共同父级和同级参照；潜在放入目标可替代当前作用域。SnapSession 只保存手势内的轴向匹配，捕获半径为 6 CSS px，释放半径为 9 CSS px；距离经适配层投影比例换算到世界坐标。等距离优先父级/同类中心，锁定对象可作参照，选区及后代、隐藏和暂停分支排除。

Viewport 按文档引用/作用域/选区缓存参照，通过交互端口修正移动量，不在应用层访问 DOM。普通移动仍先按 UI 像素步进，居中修正允许半像素；layout 保留显式非整数偏移，并用可选 layout.subpixel 记录精确定位，避免居中锚点抵消偏移后被再次取整；精度向后代传递。Stack 流式子项沿父级的小数原点量化共享边界，保持 Fill 接缝一致，纹理宽高不改变。预览不写文档，提交/取消沿用现有事务。

A/R 默认绘制吸附活动边，仅接受可保持正整数尺寸的候选；Shift/Alt/Space 修饰绘制及 Stack 布局由原有几何约束控制。旋转对象按可见外接矩形中心/边缘对齐，未引入斜向约束或等间距分布。

紫色辅助线仅为 SVG 编辑层，固定 1 CSS px，不参与命中、文件或原生截图。磁铁开关复用原生 Toggle，smartSnap 合并写入本机偏好；拖动开始后按住 Ctrl 临时绕过，保留原有 Ctrl 深层框选起手。取消、释放、离开视口、模式/项目切换和卸载清理手势状态。

## 基岩静态尺寸（0.11.0）

SizeRule 保留 fixed / expression / fill / hug，增加 default 和 sum；expression.unit 缺省为父级 %，支持 %c/%cm/%sm/%x/%y，sum 保存多个参照及一个像素项。解析、格式化、步进及组合共用 domain/expression，没有 eval 或宿主依赖。

layout 按节点/轴记忆化求值，检测父子、自身和同级循环；requested 记录约束前的尺寸，仅存在派生场景。换父级的新参照根据完整目标树重新求值，以约束前结果修正像素项，避免 max 截断造成错误补偿；移动整个选区仍为一次事务。

SizeEditor 是独立适配层组件，接入原生 Panel/FormElement 的既有容器。表达式与组合控件调用相同数据事务；按公式结构更新控件，数值变化保留稳定输入和草稿。字段级混合值独立读取，比例变化不覆盖每个元素自己的像素项。移除旧策略下拉及其每次刷新进行的多次布局预检。

新节点默认最小尺寸 0；零尺寸仅隐藏 Image 内容 Cube，保留 Group 与子元素的可见性及源/成品贴图，首次空内容使用 1×1 占位纹理。尺寸恢复后继续渲染；零几何不进入画布命中或缩放控制点。原生快照、差异保护和文件工具接受该结构。

标准依据、确定性边界、扩展语法及两种界面见 bedrock-sizing.md；schemaVersion 仍为 1。

## 旋转光标（0.11.2）

Presentation 使用本地嵌入的 Penpot MPL-2.0 SVG，原始路径不修改，24px 画布围绕 16px 图形留足任意角度的边距，热点固定在中心 (12,12)。四角偏转叠加选区的屏幕角度，更新已有命中区域的 cursor；按整数角度缓存且最多 360 项，避免每帧反复编码。光标不请求远端资源，不改变旋转手势、命中范围或模型数据。源文件和第三方许可随静态发布与交付包分发。

## 普通建模与跨插件 Undo 边界

没有 UI Studio 文档元数据的项目仍由 Blockbench 管理普通 Cube/Group/Mesh；UI Studio 不为这些项目创建 Studio，也不回读/重建其历史结构。文字插件可独立运行，通过 Content API 1 的 active/owner 判断是否将受管理 UI 内容交给 UI Studio。普通文字的原生快照范围由文字插件的 native-edits 协调层成对补充，只包括原始宿主范围与文字参与者；禁止只扩充 AFTER 或替换宿主持续追加的 aspects 数组。详细复现、来源判断和测试覆盖见 native-modeling-regression.md。

## 已选容器的拖动命中（0.11.3）

统一 pickNode 接收可选显式选区：名称标签优先，然后判断各已选节点的实际投影四边形，再走原有 Frame 边框和 Image 层级规则。已选 Frame 内部（含子元素及空白）因此承接当前选区的移动，不在 pointerdown 重选子元素；多选间隙和旋转外接框的空角不会被当成拖动面。

适配层的悬停、按下与 canvasClick 使用同一选区规则；Shift 增减选、Cmd/Ctrl 深选、双击进入内容及 Option 测距的悬停仍使用普通命中。未选 Frame 内部保留框选，控制点、绘制、透视、原生工具和绘画仍沿各自上下文路由。移动继续使用原 InteractionMachine 临时预览和单次 Undo，没有新增模型状态或原生对象拦截。

## 多选属性契约（0.12.0）

application/inspector.inspectProperty 统一计算 available/editable、混合值和逐轴共同值。property-fields 的字段声明、fieldState 和 writeField 管理适用范围与全选区写入，复合字段使用同一注册表；展示层不能筛出部分节点后提交。

原生 PairDraft 和 Scalar FormElement 从逻辑显式选区读取，忽略宿主默认的首项填充。Scalar 复用组合面板的数字草稿、步进、拖动和生命周期控制。节点代理仍保存各自实际值；空白/混合标记仅留在表单中。W/H 规则以格式化表达式比较、颜色以等价 RGBA 比较，不改模型原始数据。

可用性随整个选区类型、内容类型及父级布局上下文计算：Frame/Image 混选隐藏专属板块；流式位置、不可共同解释的定位角色、无效图片模式和未启用样式参数由同一契约阻止写入。取消、选区/项目切换及原子批量校验沿既有事务处理。官方对照、具体规则与明确保留的基岩语义见 multi-selection.md。

## 剪贴板与逻辑层级命令（0.13.0）

StudioClipboard 是原生粘贴事件、系统读写、内部图层缓存、属性缓存与文件导入的唯一适配入口。以请求序号、文档引用、项目及显式选区校验异步结果；粘贴事件数据优先，后到的事件令旧读取失效，不使用固定毫秒防抖。解码完成并确认上下文有效后，调用 Studio 的同步原子图片/样式提交。浏览器图片层提供 blobPixels，避免先编码再解码；保留 blobImage 供既有接口使用。

application/clipboard 定义纯数据的样式协议和复制范围，只接收内嵌 PNG、有限数值及支持的配方。名称、布局和层级不进入样式协议。Studio.pasteImages/pasteProperties 使用标准事务、独立源/纹理及既有生成内容持久化；文字目标保留生成配方，仅应用外观。图片填充换源时冻结素材 Hug 轴以保持显示边界。

domain/layer-order 对每个父级的兄弟列表稳定排序；应用层先以轻量树副本预检，边界不建 Undo，然后在一次 execute 内提交。标准 Y 深度跟随已有 layout/apply，不重烘焙未变像素。排序、属性复制粘贴的 Action、Keybind、sub-keybind 和菜单由 shortcuts 适配器集中注册与清理；不修改宿主原型方法。

## v0.14 Frame 自动边界

SizeRule 新增 Frame 专用 `auto`，schemaVersion 仍为 1。低层 createNode 继续尊重传入矩形并使用 fixed；普通新增、原生收编和编组路径显式设置 auto，项目初始画板和拖绘路径继续 fixed。Hug 不改变语义。

`domain/auto-frame.ts` 通过缓存测量计算自由容器的可见直接子项旋转边界、原点移动和中心补偿，Stack Auto 复用流式测量。布局不改变输入文档，ResolvedScene.offsets 表达需要持久化的像素偏移；`applyResolvedLayout` 与 rect 一起由 Studio.calculate / 文件作者脚本在现有事务内应用。比例坐标保留系数、重算像素项，不以迭代试探求解父子百分比尺寸循环。

Auto 的参照矩形是已保存的 rect，尺寸改变时维持原有子项世界位置，重新基于最终矩形归一化偏移。自由容器旋转时同时补偿枢轴变化；位于 Stack 流中的容器以槽位为准。小数 Frame 几何可原样固定，不重采样 Image 纹理。测量不依赖原生宿主，不扫描纹理，不为移动重烘焙；派生更新与结构编辑共享 Undo。包含 suspended 后代时冻结自动边界，保留原生差异。

换父级的尺寸重定位统一由 retainWorldRect 处理：Auto 保留；新 Auto 父轴的百分比/Fill/default 依赖冻结为当前尺寸，避免引入循环。显式手动尺寸输入/控制点缩放固定所改轴，移动不改变 Auto。
