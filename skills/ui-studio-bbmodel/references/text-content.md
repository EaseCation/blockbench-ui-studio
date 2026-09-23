# BBModel Text Component 接入

支持实际验证过的文字插件 v0.2.0（原生 Cube 载体 / Content API 1）。`--text-plugin` 是可信本地 JS 文件，命令会在隔离宿主执行它，不安装到用户 Blockbench。没有加载该插件时，脚本不会伪造文字参数或字体渲染结果。

```sh
node skills/ui-studio-bbmodel/scripts/ui-file.mjs build design.json --text-plugin ../blockbench-bbmodel-text/dist/bbmodel-text-component.js --out text.bbmodel --preview text.png
node skills/ui-studio-bbmodel/scripts/ui-file.mjs extract text.bbmodel --text-plugin ../blockbench-bbmodel-text/dist/bbmodel-text-component.js --out edit.json
node skills/ui-studio-bbmodel/scripts/ui-file.mjs build edit.json --base text.bbmodel --text-plugin ../blockbench-bbmodel-text/dist/bbmodel-text-component.js --out edited.bbmodel
```

## 设计描述

```json
{
  "version": 1,
  "fonts": [
    {
      "id": "fusion_12",
      "name": "Fusion Pixel 12px",
      "file": "fonts/fusion-pixel-12px-proportional-zh_hans.otf"
    }
  ],
  "nodes": [
    {
      "id": "title",
      "kind": "image",
      "name": "标题",
      "x": 16,
      "y": 12,
      "width": "hug",
      "height": "hug",
      "content": {
        "kind": "text",
        "text": "怪物状态",
        "font_id": "fusion_12",
        "font_size": 1,
        "color": "#ffffff",
        "density": 4
      }
    }
  ]
}
```

`fonts[].file` 相对设计 JSON（转换时相对 options JSON），接受 OTF/TTF/WOFF/WOFF2，脚本内嵌 data URL 与 SHA-256。提取结果已包含内嵌字体，可独立再生成。不把个人电脑字体路径或浏览器自动回退字体当作可移植资源；替换缺失字体须明确选定，并在交付记录字体来源及许可。`font_default_minecraft` 是插件自带字体，不适合作为缺失中文字体的替代。

`font_size` 是 **8px 基准的倍率**，1 表示 8px，2 表示 16px；不是 CSS pt/px 字号。`density` 取 1/2/4，控制成品贴图的采样密度，不改变逻辑尺寸。Fusion Pixel 有 8/10/12px 字形版本，优先按用户需求选择，不能因为渲染器以 8px 为基准就默认使用最粗糙的 8px 字形。12px 字体在 font_size=1.5 时对应原生 12px 大小；转换已有设计时可保留 0.7/1.1 等倍率维持排版，但会有非整数采样。提高 density 只提高采样精度，不能补出低分辨率字体没有的笔画。

其它参数：`line_height` 默认 1.2、`letter_spacing` 默认 0、`align` left/center/right、`opacity` 0..1、`color` 十六进制。UI 文字 `plane` 只能为 up。

布局宽高决定排版：双轴 Hug 为自动宽高；固定宽＋高度 Hug 自动换行；双轴固定可能裁切超出内容。`sizing` 会根据最终布局同步为 auto/height/fixed，不应与布局分开维护。自然宽度必须向上取整，向下取整可能将最后一个字符推到下一行并被固定高度裁掉。视觉验收要核对末尾字符与多行高度，尤其 LV.7 这类非整数测量宽度。

默认 `resize="reflow"`，修改宽度触发重新排版。`resize="scale"` 搭配 `reference:{width,height}` 固定原排版尺寸，几何变化只缩放显示；省略 reference 时取 box_width/box_height（默认 32/16）。需要指定原排版尺寸时显式填写，别误把当前目标尺寸当成 reference。文字分辨率由 density/reference 管理，不使用图片的 rasterSize 控制它。

## 文件与插件兼容

- 每处文字仍是 UI Image 的 Group＋标准 Cube＋嵌入 PNG。内容 Cube 的 `bb_text` 保存权威文字配方。
- `unhandled_root_fields.bb_text = {version:1, fonts, entries}` 保存字体与按内容 Cube UUID 索引的恢复副本。UI `content` 保存 generated/provider/source/logicalSize/renderedKey；`data` 只在运行时存在。
- 无插件打开显示已烘焙 PNG；无插件保存后 Cube 自定义属性可能被剥离，恢复副本让插件重新加载时找回文字。不能只保留 Cube.bb_text 而遗漏项目恢复副本/字体。
- 只有文字插件时可编辑原生文字；同时加载 UI Studio 时走统一内容 API、布局与 Undo。编辑后应验证成品像素变化、一次 Undo、重开不暂停。
- 不写临时 `bb_text_transfer`，不手工计算 fingerprint。遇到原生差异由保护机制处理。

公开 API 为 `Blockbench.mcuiStudio.contents`，文字插件通过 register 提供 prepare/measure/render/key/seal。文件桥复用该接口与仓库当前内核；实际验证还需加载完整 UI 插件，以覆盖初始化与插件协同，不能把桥的验证当成全部宿主交互验收。
