# Figma框选调研与实现（0.8.5）

## 官方依据

2026-09-23在线读取Figma官方[Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)。相关章节为Select nested layers、Deep select、Selection marquee。

- 普通点击嵌套对象优先父对象："we'll select the parent by default"。
- 拖拽框选内部层需按修饰键："To select nested layers, hold down the modifier key and drag the marquee across the objects"；Mac为Command，Windows为Ctrl。
- 顶层Frame选区保持顶层："If you select a top-level frame, only other top-level layers will be selected"。
- 选父级会同时作用于后代；官方同时指出可以只选内部对象而不选父对象。

官方文章没有逐项定义拖拽起点、所有嵌套边界、部分相交和Image套Image的计算算法。本轮结合上述行为和用户“尽可能归并共同外层、Command强制内部”的要求，制定以下插件规则；不是对Figma未公开算法的逐像素复刻。

## 插件规则

1. 普通空白起手找到包含起点的最深可编辑容器作为初始范围；拖拽框越出该容器时范围向外扩展。命中的Image向上归并为该范围的直属分支，因此部分框住内层元素也可选择外层Frame。画布起手选择根级，不混入其它画板的内部项。
2. Command/Ctrl直接选择框中的Image；若祖先和后代都命中，保留后代。空Frame完全被包围时可选。Image自身有绘画内容：只框到自身而没命中后代时，仍可选Image。
3. Image按矩形相交命中，透明像素仍可选；Frame自身按完整矩形包围命中，其内部Image还可触发普通模式的父级归并。隐藏、锁定、暂停对象及受影响后代排除。
4. Shift追加原选区；普通模式按共同外层归并，深层模式去除与命中子项冲突的旧祖先。结果始终没有父子重复选择。
5. 鼠标拖动和修饰键变化时实时同步，不等松手才提升。深选也能从有内容的Image上起手；单次Command点击保留直接选择内部对象能力。

## 宿主适配

保留原生框选框、激活阈值和选择历史。Mac Command或Windows Ctrl可能与宿主导航/浏览器兼容鼠标事件冲突，因此本轮由PointerEvent驱动宿主现有框选辅助方法，不覆盖原型或注册第二套Undo。

一次手势固定原项目和Undo，取消时清理所有临时监听/捕获并恢复原选区。项目切换时使用原项目whenNextOpen恢复。模式/工具/失焦/pointercancel/Escape/弹窗覆盖取消边界；滚轮不会在框选中改变相机。框选不写逻辑文档、几何或像素。

## 验证

纯数据用例覆盖普通外层提升、内部起手、跨画板、Image套Image、空Frame、Shift合并及隐藏/锁定/暂停。

真实浏览器鼠标/键盘用例覆盖正反向框选、实时选区、Command中途切换、从填充Image起手、选择Undo/Redo、相机和文档保持、六类取消及弹窗。Windows Ctrl路径在模拟Windows UA下派发PointerEvent；这验证修饰键接入，但不宣称在真实Windows设备上完成了鼠标手感验收。Mac测试同样不替代用户触控板手感。

原有框选后编组/解除/拖动/保存重开测试继续验证。原生交互、透视及绘画保留宿主行为；本轮不改变双击进入绘画/文字编辑的已有语义。使用方式见[使用指南](user-guide.md)。

最终验证：类型、依赖边界、构建、格式及84项单元测试通过；UI Studio完整宿主116项、文字插件联动宿主22项通过。
