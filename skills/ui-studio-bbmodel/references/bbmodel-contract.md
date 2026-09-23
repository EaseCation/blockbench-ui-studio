# 保存契约与排错

对应 UI Studio 0.8.1 的 schemaVersion 1、Blockbench 5.2.1。版本号相同不意味着任意历史开发结构都兼容；按当前 Image/Frame 结构校验，不做旧字段迁移。

## 两层数据都要一致

- 原生部分：Generic Model（meta.model_format=free），groups、elements、outliner、textures。
- 逻辑部分：`unhandled_root_fields.mcui_studio = {schemaVersion:1, document, nativeSources}`。
- document 包含 id、roots、nodes、assets、bindings。
- bindings[id] 按角色指向 containerId（Group）、surfaceId（Image 内容 Cube）、textureId。逻辑 id 与原生 UUID 无需相同。
- assets 是源图和 revision；Texture 是已烘焙成品；nativeSources 保存原生绘画层备份。

每个 Image 固定对应 Group＋一个内容 Cube＋成品 Texture；Frame 只有 Group。内容 Cube 是原生子项，不在逻辑 children 中。不能把 Frame 背景直接画在 Group 上。

## 几何、UV 与顺序

UI X 映射世界 X，UI Y 映射世界 Z。Cube.from.y 与 to.y 相等，为 0 厚度；Y 数值是树遍历得到的绘制深度。父 Image 先于后代，同级后面的元素显示在上面。Frame 在遍历中也占位置，因此不能只按 Cube 序号自行赋层级。

内容 Cube 只有 up 面引用成品贴图，其它面 texture=null；非 Box UV，autouv=0，旋转为零。up.uv 是 `[0,0,texture.uv_width,texture.uv_height]`。高清素材的纹理尺寸与几何 W/H 可以不同。

原生 groups 与 outliner 的序列化随 Blockbench 版本变化；face.texture 在保存文件中不一定直接写 Texture UUID，原生 codec 会处理索引。配套脚本让当前宿主负责这些细节，不要求 AI 手动拼写。

## 指纹不是装饰字段

绑定中的 fingerprint 来自实际原生几何、名称、可见性、锁定、层级、贴图与 UV。源资产 revision 与 PNG 内容也必须匹配。脚本先在隔离宿主检查基文件，写回后再通过另一个干净页面重开验证。

若校验发现暂停规则或差异保护，常见原因包括：仅改 metadata；移动了内容 Cube；改变了 Y 厚度/旋转/UV；删除了 Texture；把纹理改为未内嵌外部文件；修改了源图而未生成成品。

不要删除 fingerprint 或 suspended 来压下报错。build/validate 不自动采用差异现场；应先在插件中决定采用当前结果或按规则重建。未使用 UI Studio 的平面 UI 可显式使用 convert，见 legacy-conversion.md；这不是旧版 UI schema 的迁移路径。

## 原生绘画层与第三方内容

未替换来源时保留 nativeSources；替换某个源 PNG 时仅删除该源的旧层备份，避免旧图层把新素材覆盖回去。原生绘画层的合成由 NativeHost.prepareSources/applyPaintLayers 完成，不从 JSON 猜测合成公式。

generated 文字参数的权威副本位于内容 Cube 的 provider 属性及 `unhandled_root_fields[provider].entries[surfaceId]`；UI document 中的 data 是运行时草稿，不是保存权威。没有字体资源和 provider.measure/render/seal 的离线脚本不应伪造这套元数据。未加载 provider 时脚本只保留未受影响的 generated 节点。通过 --text-plugin 加载实际文字插件后支持可编辑文字，见 text-content.md。

脚本不建立游戏 JSON、运行时绑定、裁切、Grid 或多用户协作能力。PNG 预览是二维成品合成，用于视觉检查；它不是透视视口截图。
