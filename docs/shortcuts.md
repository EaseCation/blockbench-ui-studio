# UI Studio 快捷键调研与落地

调研日期：2026-09-23。本轮优先缩短「创建 → 排列 → 定位查看 → 继续编辑」路径。

## 已核实的 Figma 规则

- [添加／移除自动布局](https://help.figma.com/hc/en-us/articles/5731482952599-Toggle-on-auto-layout-in-designs)：Shift+A；Mac Option+Shift+A / Windows Alt+Shift+A 移除。已选 Frame 原地启用，普通选区外包 Frame。Suggest auto layout 是另一个自动推断多层结构的功能，不等同于普通 Shift+A。
- [视图缩放](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)：Shift+1 查看全部，Shift+2 聚焦选区；Shift 加号／减号调整缩放。只改变当前视图，不改变图层尺寸。
- [横向／纵向自动布局](https://help.figma.com/hc/en-us/articles/31289464393751-Use-the-horizontal-and-vertical-flows-in-auto-layout)：Command/Ctrl+D 复制；方向键可调整 Stack 子项顺序；九点对齐区域内可用方向键调整对齐。不同焦点下，同一组方向键承担不同任务。

## 当前可用

| 快捷键                   | UI Studio 行为                                              | 来源／说明                                     |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------- |
| Shift+A                  | Frame 原地启用；单个 Image 或多个同级对象外包自动布局 Frame | 本轮新增，采用 Figma 语义                      |
| Option/Alt+Shift+A       | 移除选中 Frame 的自动布局，保留 Frame 和当前边界            | 本轮新增，不递归清除后代布局                   |
| Shift+1                  | 查看全部可见 UI 元素                                        | 本轮新增，仅相机变化                           |
| Shift+2                  | 聚焦可见选区                                                | 本轮新增，空选区不操作                         |
| Command/Ctrl+D           | 复制逻辑节点，成品贴图独立                                  | 复用原生命令；本轮补齐 UI 布局／内容面板作用域 |
| Command/Ctrl+C、V        | 内部节点复制粘贴／图片粘贴                                  | 已有；本轮补齐上述属性面板作用域               |
| Delete／Backspace        | 删除逻辑选区                                                | 已有；属性面板输入时仍编辑文字                 |
| A、R、V                  | 绘制 Frame、绘制 Image、返回 UI 选择                        | 保留项目既有键位，A 不是 Figma 工具的完全复刻  |
| Space＋拖动／中键        | 平移视图                                                    | 已有                                           |
| Shift／Option 拖拽控制点 | 等比／中心对称尺寸调整                                      | 已有                                           |
| Option 悬停／Option 拖动 | 测距／复制拖动                                              | 已有，依具体手势决定                           |
| Escape                   | 取消当前草稿／拖动                                          | 已有                                           |

Shift+A 选中已是 Stack 的单个 Frame 时打开布局属性，不产生新 Frame 或空 Undo。自由 Frame 启用时按可见流式子项位置推断横纵方向、平均间距，固定子项现有宽高；空 Frame 默认为横向、8px 间距。绝对定位子项保留。混合父级、锁定或暂停的选区不会被强制转换。

所有新快捷键在 MC UI 元数据项目的 Figma 交互、二维顶视正交、编辑模式生效。元数据标识是技术兼容字段，不限制 UI 的游戏用途。输入框、重命名、菜单、颜色选择器、对话框、中文输入组合、绘画、透视和正在执行的指针手势不接管。长按不会反复创建。空选区命中快捷键时不回落触发同键原生操作。

入口：工具菜单中 UI：添加自动布局／移除自动布局／查看全部／聚焦选区；布局操作也在图层右键菜单。设置 → 快捷键可搜索以上命令，原生菜单显示当前实际键位，重绑定后分发使用新的 Keybind。

## 层级选择（0.8.7）

2026-09-24 阅读 Figma 官方 [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)：Enter 选择向内一级，Shift+Enter 选择父级；Tab / Shift+Tab 切换下一／上一同级。官方也区分了“父节点作为选区”和“移动父节点时所有子项跟随”。

本轮实现 Enter / Shift+Enter 两个可重绑定的原生命令，支持视口、大纲与 UI 属性面板后的逻辑选择；不实现 Tab，保留表单焦点导航。不会进入 Image 的原生内容 Cube。

- Enter：将每个选中容器替换为其可选的直接子项，不一次深入所有后代。
- Shift+Enter：将选区替换为直接父级；去重并消除父子混选，按文档顺序输出。
- 批量边界策略（本插件明确约定，官方文档未逐项描述）：已到叶子／根级的分支保留；子项全部不可选时保留容器。跨父级批量上升可收敛到共同外层。
- 隐藏、锁定、暂停编辑节点及受其影响的后代不可进入；空选区不操作。
- 不修改文档、贴图或编辑 Undo；选择继续使用宿主选区历史。长按不连续穿透多级。
- 输入、重命名、IME、弹窗、菜单、指针手势、绘画、原生交互与透视视图保留宿主行为。叶子 Enter 不自动进入文字编辑或绘画，沿用原有编辑入口。

Frame 名称点击只显示外层逻辑选区；多个显式选区分别绘制轮廓。宿主递归选择仍为原生复制、删除、变换服务，由专门的呈现适配器过滤其后代高亮，不修改宿主原型。拖动标签使用临时移动量，文档与命中候选保持原位置直到提交；取消时立即归位。

## 下一批建议，尚未实现

1. **方向键微调与 Shift 大步移动**：自由节点应按 UI X/Y 移动并保留百分比；Stack 子项应沿主轴排序。需要统一长按单次 Undo、多选、边界与焦点语义，不能直接沿用原版世界 XYZ 移动。
2. **同级键盘导航**：父子级已支持 Enter / Shift+Enter；Tab 同级切换需与表单焦点导航协调，大纲中的方向键仍交给原生树。
3. **对齐快捷键**：层级排序已于 0.13.0 实现；同级/父级的边缘、居中分布快捷操作待单独设计。
4. **快速聚焦属性输入、命令检索**：优先复用原生命令搜索与输入焦点机制，避免新增一套命令面板。
5. **缩放与网格切换**：Figma 的缩放键可复用，但 100% 必须先定义 UI 像素／CSS 像素／设备像素关系；K 在当前插件已经表示贴图策略，不应静默改成 Figma 的缩放工具。

不默认覆盖 T：文字组件插件负责文字编辑入口。不直接照搬 Figma 的组件、变体、原型和矢量路径快捷键，因为当前没有对应业务能力。

## 架构与验证

application/layout-commands 处理 Frame 原地启用和移除，沿用布局内核、错误回滚和单事务；普通选区复用已有 wrapAutoLayout。adapters/blockbench/shortcuts 只负责原生 Action/Keybind 注册、作用域与 press_key.capture，避免一次按键同时落入宿主工具。视图命令复用 ViewportController.fit，并允许限定选区。

验证实际 Shift/Alt 按键、重复触发、单次 Undo、边界保留、空 Frame、锁定、重绑定、缩放不写文档、输入/弹窗/原生/透视隔离、属性面板后的复制，以及原有绘制键的回归。

## 数值字段与 Scrubbing

已阅读 Figma 官方 [Adjust alignment, rotation, position, and dimensions](https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions) 的 Scrub fields：拖字段标签，或 Option/Alt 拖字段本身；左右调整，上下改变 2×/1×/½×/¼× 档位。

现已接入上述起手和速度档位，覆盖本插件各数值输入与图片/九宫格预览。↑/↓ 每次调整 1，表达式只修改像素偏移。拖动实时预览、松手一次提交、Escape/失焦/切项目取消。当前为屏幕内指针捕获，未复刻 Figma 的跨屏边缘无限拖动。数字输入的普通选择与 IME 修饰键保持原有行为。

## 样式与层级（0.13.0）

Cmd+Option+C/V（Windows Ctrl+Alt+C/V）复制/粘贴样式属性，保留目标几何和结构。`[` / `]` 后移/前移一层，Shift+`[` / `]` 置底/置顶；也支持 Figma 的 Cmd/Ctrl+方括号，Mac Cmd+Option+方括号或 Windows Ctrl+Shift+方括号直达首尾。新增命令均可通过右键和工具菜单使用，并支持原生重绑定。规则和来源见 [剪贴板与排序](clipboard-and-order.md)。
