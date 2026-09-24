# 可编辑设计描述 v1

顶层：`{ "version": 1, "name": "项目名称", "assets": {}, "nodes": [] }`。`nodes` 是根节点数组，子项用 `children` 嵌套。未知字段报错，避免 AI 写错属性却静默忽略。

## 节点

| 字段                  | 内容与默认值                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| id                    | 必需，文件内唯一的稳定逻辑字符串 ID；不要在小改动时重新命名                                   |
| kind                  | 必需，`frame` 或 `image`                                                                      |
| name                  | 显示名称，默认 id                                                                             |
| x/y                   | 数字或像素/百分比表达式，默认 0；是相对父锚点的偏移，不是世界坐标                             |
| width/height          | 数字、px/百分比参照加减公式、`fill`、`default`、`hug`、`auto`；Image 默认 32，Frame 默认 auto |
| positioning           | `flow`（默认）或 `absolute`；绝对子项不参与 Stack 和 Frame Hug                                |
| anchorFrom / anchorTo | 父锚点/自身锚点，两个 0..1 数，默认 `[0,0]`；居中用两者都 `[0.5,0.5]`                         |
| minWidth/minHeight    | 默认 0，UI px                                                                                 |
| maxWidth/maxHeight    | 可省略，UI px                                                                                 |
| visible / locked      | 默认 true / false                                                                             |
| opacity               | 默认 1，范围 0..1                                                                             |
| rotation              | 默认 0；角度，正数逆时针、负数顺时针，相对父级，自动归一到 -180..180                          |
| children              | 逻辑子节点数组，不包含 Image 内部内容 Cube                                                    |

`x="50% - 8px"` 与中心父锚点不是同一件事：锚点和百分比偏移会相加。需要中心定位时通常把两个锚点设为中心、x/y 为 0。根节点不能依赖父级百分比或 Fill。

Image 的 Hug 使用自己的源素材尺寸，不使用子元素边界；默认透明源只有 1×1，不能指望空 Image Hug 自动得到期望画板大小。Frame 的 Hug 使用可见流式子项。尺寸解析完成后按共享边界取整。

## Frame 专用布局

- `direction`：`free` 默认，或 `row`、`column`。
- `gap`：非负整数，默认 8。
- `padding`：`[上,右,下,左]` 四个非负整数，默认全 0。
- `justify`：`start` / `center` / `end` / `space-between`。
- `align`：`start` / `center` / `end`。

Auto 两端分布使用 gap 作为下限。主轴 Hug 使用这个下限计算；零/一个子项不分配额外间距。Frame 自身没有 content/appearance/rasterSize。Image 不接收上述 Frame 参数。

## Image 来源

省略 content 时使用透明绘画源，可直接设置 appearance 制作面板、线条或按钮。Image 可同时保留填充、描边和源图。

```json
{ "kind": "paint", "source": "asset-id", "mode": "extend", "origin": { "x": 0, "y": 0 } }
```

paint 的 mode 为 extend（保持像素、裁切或扩展）或 scale（从源图重采样）。source 可省略，自动生成透明源；image/nine-slice 必须提供 source；text 由文字 provider 生成来源。

```json
{
  "kind": "image",
  "source": "icon",
  "mode": "fit",
  "anchor": [0.5, 0.5],
  "scale": 1,
  "offset": { "x": 0, "y": 0 },
  "onlyDownscale": false
}
```

图片 mode：fit 完整显示，fill 等比铺满，stretch 拉伸，crop 倍率/偏移裁切，original 原始像素。offset 是贴图画布像素；非 crop 时忽略 offset/scale。不要把 image.mode=fill 与 layout.width=fill 混淆。

```json
{ "kind": "nine-slice", "source": "panel", "insets": [3, 3, 3, 3], "mode": "tile" }
```

九宫格 insets 的单位是源图像素，顺序上右下左。mode 为 stretch 或 tile。四角保持，源中心至少 1px，目标宽高也必须容纳相对两侧与至少 1px 中心。不能与 rasterSize 同用。

## 外观与分辨率

```json
{
  "appearance": {
    "fill": "linear",
    "color": "#24577fff",
    "endColor": "#142536ff",
    "angle": 90,
    "strokeColor": "#75b8daff",
    "strokeWidth": 1
  },
  "rasterSize": { "width": 128, "height": 128 }
}
```

fill 为 none/solid/linear；颜色只接受 `#RRGGBB` 或 `#RRGGBBAA`。填充位于源图下方，描边向内、位于内容上方。strokeWidth 是贴图像素、非负整数。0° 左到右，90° 上到下。

省略 rasterSize 时最终贴图按解析后的显示尺寸生成；填写时保持该纹理分辨率，显示大小由几何决定。显示宽高比与 rasterSize 比例不同时会拉伸最终内容。图片 Fit 是相对于纹理画布，不能抵消几何比例变化。

## 源素材 assets

可使用三种形式；不混用同一条记录的类型：

```json
{
  "assets": {
    "icon": { "file": "images/icon.png" },
    "embedded": { "png": "data:image/png;base64,..." },
    "solid": { "width": 8, "height": 8, "color": "#00000000" },
    "pixels": {
      "width": 3,
      "height": 3,
      "palette": { ".": "#00000000", "x": "#ffffffff" },
      "rows": [".x.", "xxx", ".x."]
    }
  }
}
```

PNG 文件相对设计描述路径解析。像素 rows 的行数与字符数必须匹配 height/width，所有字符必须在 palette 中定义。透明必须使用真实 alpha。复杂插画、字体或大图不要用几千行手工像素描述；使用用户素材或合适的图像制作工具生成本地 PNG。

同一源素材可供多个节点共享；每个 Image 的成品纹理独立。编辑已有文件时，只改素材内容而保留 asset-id 表示显式替换该源；其原生绘画层备份会失效。未改动的 PNG 与原生绘画层继续保留。

## 编辑边界

`extract` 输出完整描述，含源素材、全部节点和当前参数。`build --base` 使用旧文件的逻辑 ID 匹配绑定；移出/插入层级会重新计算世界位置与 Y 顺序，x/y 仍按新父级解释。若要保留换父级前的世界位置，应先按新父边界重算偏移。

未加载文字 provider 时，generated 内容提取为 `{ "kind": "generated", "preserve": true }`，仅支持原文件中对应节点。不可通过这份描述新建或重排文字版式；会改变 generated 尺寸、布局参数、外观、来源、父级或深度的更新被拒绝。若任务需要这些变化，先在对应文字插件中完成并保存，再提取。

## 可编辑文字

顶层可增加 `fonts` 数组，Image 的 `content.kind="text"`。加载 `--text-plugin` 后 extract 输出完整文字参数，build 通过实际 provider 更新。字号倍率、字体文件与换行规则见 [text-content.md](text-content.md)。不要将字体字号直接填入 `font_size`，也不要把已有的文字权威参数写到 UI document.content.data 后直接保存。

## 二维旋转

`rotation` 同时适用于 Image 和 Frame，绕自身 W/H 矩形的中心旋转，子项继承父级旋转。坐标、百分比、Stack 占位与宽高始终使用旋转前的父级局部布局；旋转只改变显示几何，不将外接矩形当作新的贴图尺寸，也不重采样贴图。原生 Group.rotation.y 保存角度，Group 与内容 Cube 的 origin 由工具居中生成，内容 Cube 自身的 rotation 仍为零。不要手工改 Cube.rotation 来表达 UI 旋转。

例如 `{ "id":"badge", "kind":"image", "x":20, "y":10, "width":32, "height":16, "rotation":-15 }` 表示相对父级顺时针转 15°。PNG 预览已应用完整父子旋转。仍不支持 UI 平面之外的 X/Z 倾斜。

精确定位的提取结果可能包含 `subpixel: true`，用于保留吸附得到的半像素位置（包括与居中锚点、百分比结合的情形）。编辑已有设计时保留此字段；它不提高贴图分辨率，也不改变 Stack 的共享边界分配。

## 尺寸参照与组合

W/H 支持 `px`、父级同轴 `%`、直接子项合计 `%c`、最大可见直接子项 `%cm`、最大其他同级 `%sm`、自身宽 `%x`、自身高 `%y`，以及 `default`（父级 100%）、`fill`。保留 `hug` 插件扩展。示例：`100%cm + 8px`，W=`200%y` 配合 H=40。多个参照可相加，例如 `50% + 25%y - 8px`，这属于插件扩展公式，不保证原游戏解析器跨版本支持。

`%c/%cm` 不包含插件 gap/padding 或子项位置偏移；Image 内部原生内容 Cube 不参与统计。`%c/%sm` 保留隐藏项尺寸，`%cm` 排除隐藏子项。不能构成自身/父子/同级尺寸循环。`$变量`、Molang、括号和乘除不是此静态表达式格式。坐标 x/y 仍只接受父级百分比＋像素。

允许逻辑尺寸 0，内容 Cube 不显示，源图仍保留。旧文件 minWidth/minHeight=1 是已有约束，若需要折叠到 0 应明确设置对应最小值为 0。正尺寸恢复后继续渲染，绝不生成 0×N 的非法 PNG。

## Frame 自动边界

Frame 的 `width` / `height` 可以逐轴设为 `auto`，自由布局时跟随可见直接子项的完整边界（包括绝对子项、负坐标和旋转），Stack 时按流式排列内容、gap、padding 计算。空 Frame 保留其已解析尺寸。`hug` 的固定起点内容测量仍独立保留；Image 不支持 `auto`。

画板作为百分比参照时显式填写固定 W/H。Auto 轴不能与子项父级百分比尺寸、default 或 fill 构成循环；需要百分比宽度时将对应父轴固定。百分比坐标仍可使用，布局会保留百分比分量、重算像素偏移与中心，使其它子项不跳位。编辑器编组/换父级时会把依赖新 Auto 父级的子项尺寸固定为当前像素值。

不要只写入解析后的 rect：必须同时应用 `applyResolvedLayout` 返回的原点重定位结果。配套 build 脚本已处理此步骤；base 更新使用原文档 rect 作为自动尺寸的历史参照。已有固定尺寸不会被读取过程改为自动。
