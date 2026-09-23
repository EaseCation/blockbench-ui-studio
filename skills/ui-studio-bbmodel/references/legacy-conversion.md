# 将普通 Blockbench 平面 UI 转为 UI Studio

使用 `convert`，不直接补写 mcui_studio metadata。这是明确的视觉格式转换，不是旧版 UI Studio schema 迁移。输入必须是 Generic Model，包含 Cube/Group 或文字插件可读取的 legacy bb_text。原文件保留，输出到新路径。

```sh
node skills/ui-studio-bbmodel/scripts/ui-file.mjs convert original.bbmodel \
  --options conversion.json --text-plugin ../blockbench-bbmodel-text/dist/bbmodel-text-component.js \
  --out converted.bbmodel --design-out converted.design.json --report conversion.report.json \
  --preview overview.png --preview-scale 2
```

转换选项示例（未知字段报错）：

```json
{
  "view": "top-reversed",
  "offset": [192, 108],
  "name": "UI 设计",
  "flattenGroups": ["明确要烘焙的三维部件Group-UUID"],
  "imageDensity": 1,
  "spriteDensity": 4,
  "fonts": [
    {
      "id": "fusion_12",
      "name": "Fusion Pixel 12px",
      "file": "fonts/fusion-pixel-12px-proportional-zh_hans.otf"
    }
  ],
  "fontMap": { "缺失的原字体ID": "fusion_12" }
}
```

## 转换前的判断

1. 统计原生 Cube、文字、Group、贴图与三维部件。检查全模型，不能只保留主画板而丢掉外围按钮状态/素材样例。
2. 明确视向。`top`：UI x=世界 X+offset.x，y=世界 Z+offset.y；`top-reversed`：两个轴均取负。屏幕截图里看起来正确的顶视图未必与 UI Studio 同向；检查纹理中的字、箭头和不对称图案。
3. 列出文字字体 ID。缺失字体不能依靠浏览器回退；先找到原字体或按用户选择替换。使用 fonts＋fontMap，报告替换。文字 API 的字号是倍率，见 text-content.md。
4. 非平面 Cube 默认拒绝转换。对明确可压平的装饰/纸娃娃，在 flattenGroups 中指定 Group；保存成透明 PNG Image，并记录原 Group 与 Cube 数。这会失去该部件的 3D 编辑能力，原文件仍是来源。不把需要继续三维编辑的对象悄悄压平。

## 顺序、UV 与几何

- 每个普通平面通过真实宿主材质与世界变换从指定顶视方向烘焙，保留原来反向/裁切/旋转 UV 的显示结果。不能把纹理 PNG 直接当作完整正向贴图复制。
- Image 的原生几何为零 Y 厚度，Y 由 UI 树顺序重新生成，不沿用旧世界 Y 数值。
- 原始不同 Group 的 Y 层级可能交错。**不能按 Group 的最小/最大 Y 简单排序**，否则书本背景可能覆盖整个页面。脚本对叶子全局按深度排序，再将连续的原 Group 路径重建为 Frame。被穿插的文件夹拆成“图层段 N”，report 列出对应关系。这种转换保留视觉遮挡，层级不是原文件夹的一对一复刻。
- 3D 烘焙 Image 的深度取部件最高 Y；若该部件本身与其它 UI 几何相互穿插，一个平面不能完全表达，应人工拆分或调整。
- UI 位置与尺寸量化为整数；文字自然宽高向上取整，防止末尾字符换行裁切。可能出现约一像素对齐变化，需要检查预览。
- imageDensity 默认 1、spriteDensity 默认 2，可取 1/2/4；这是烘焙分辨率倍率。低于原材质所需密度会损失细节，高清源按需提高。输出 Image 保留独立 rasterSize。
- 空原生 Group 不产生可见内容，不转换，report 列出；隐藏/锁定保留到重建节点。

## 文字转换与限制

旧 bb_text 先调用文字插件的 convertLegacy 成为标准 Cube，再将配方交给 UI 内容 provider。输出70处文字就应有70个可编辑配方，不能用一张截图伪装成转换成功。

文字只有在所选视向下正向、轴对齐时才能作为可编辑 UI 文字转换；倾斜/镜像/侧面文字会拒绝，避免悄悄改成正向。确实只需视觉结果时，可以显式烘焙其父 Group，但其中的文字也会失去编辑能力。转换不会凭视觉猜测九宫格、百分比、自动布局或控件状态关联；这些需后续在 design.json 中明确设计。

## 验收

生成完整预览，再用 `validate --preview main.png --preview-scale 3 --preview-region '-4,-48,424,286'` 看局部。区域值使用独立参数，不写 `--preview-region=...`。

核对方向、左右页面/背景遮挡、末尾字符、字体替代效果、周边样例和透明边缘。替代字体的字宽可能让保持中心位置的标题向两侧扩展并压住图标；在 design.json 中微调位置，再用 build --base 生成最终版，把这些调整记入报告。验证双插件、单插件与无插件打开；无插件保存后双插件重开恢复文字，改字重新烘焙及一次 Undo。不把 PNG 合成预览当作原生 3D 截图。交付 bbmodel、设计描述、报告、预览、字体许可和实际变更说明；不要承诺像素级完全一致。
