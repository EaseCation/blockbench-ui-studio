# 架构与 Blockbench 升级适配

## 依赖方向

```text
Plugin Entry ──> Blockbench Adapter ──> Application ──> Domain
                       │                    ↑
                       ├─> Presentation ────┘
                       └─> Browser Platform（图片编解码）
```

业务代码不得引用 Cube、Texture、Project、Undo、THREE、Vue 或 DOM。Domain 计算布局和像素；Application 管理事务、编辑意图和宿主变更协调。Presentation 使用自带 Preact，通过 Studio 命令操作数据。

Blockbench 接触面限定为：

| 文件             | 上游接触点                                                          |
| ---------------- | ------------------------------------------------------------------- |
| `runtime.ts`     | 宿主门面、能力探测和资源释放                                        |
| `native-host.ts` | Cube／Group／Texture、原生存储与 Undo、源图绘画                     |
| `viewport.ts`    | 原生 Preview、相机、视口 DOM、Tool 与事件捕获                       |
| `install.ts`     | 注册创建入口（ModelLoader）／命令／面板／生命周期、剪贴板动作和装配 |

宿主对象只能存在于上述适配器中。`HostPort` 等自有接口只接受纯数据和 ID。官方类型包携带 Electron、Vue 等额外依赖且发布版本落后于目标源码，因此本工程采用局部宿主门面，不把官方全局声明或宿主运行库引入业务编译环境；真实宿主契约测试补充动态接口验证。

## 上游基线

Blockbench 5.2.1，`e2ede0809ee6bc91f374ac7e00d34cffbdf86a14`。

重点参考：

- `js/formats/bbmodel.js`：原生 Project codec 的 compile/parse。
- `js/io/project.ts`：`unhandled_root_fields` 为原生 object Property。
- `js/undo.js`：`create_undo_save`、`load_undo_save`、`init_edit`、`finish_edit`。
- `js/texturing/textures.js`：纹理内嵌、原生绘画层与更新接口。
- `js/preview/preview.ts`、`OrbitControls.js`：相机和混合 Pointer/Mouse 事件。
- `js/io/model_loader.ts`：原生“新建”列表入口，创建结果仍使用 `Formats.free`；开始页双重调用在插件内合并，不修改宿主方法。

### 数据载体

`unhandled_root_fields.mcui_studio` 存放版本化 carrier，包含 portable document 与 adapter-owned native source snapshots。Domain 不读取原生绘画层结构。

原生 Cube 和纹理是实际显示结果；规则是继续编辑的源数据。打开文件时不会立刻用规则重建整个场景。先检查上次结果指纹，发生外部编辑时采用或暂停，避免覆盖。

所用原生字段为兼容策略而非 Blockbench 官方的任意插件存储协议。未来更改数据载体只应影响适配器及格式迁移，不影响业务节点和布局规则。转换模型格式会清空该字段，应保留 `.bbmodel` 编辑源。

### 事务

输入意图 → 克隆文档 → 约束与布局验证 → 生成脏节点贴图 → 开始 Undo → 应用原生变更 → 保存规则 → 完成 Undo。

连续拖动共用一次事务。原生编辑通过 init/finish 钩子扩展快照；元数据通过 Undo save 的独立命名空间保存。选择、平移、缩放相机不触发烘焙。

### 资源与失效

原图按源版本缓存；成品按源版本、内容参数、尺寸与透明度缓存。移动和 Y 排序不使贴图失效。图片解码完成之前不修改项目。所有处理均有画布像素上限。

面板、监听器、Tool、Overlay 和命令都注册清理函数；切换项目会释放当前视口接管，卸载会恢复原生相机与工具。

## 升级步骤

1. 在独立测试宿主检出新 Blockbench 版本，不改业务代码。
2. 运行依赖边界、类型、业务测试和真实宿主测试。
3. 对照适配器能力检测与四个适配文件定位差异。
4. 必要时新增版本适配分支或数据迁移；不要把宿主对象传进 Domain 作为快捷修复。
5. 检查有／无插件文件往返、Undo、绘画层、相机输入和完整卸载。
6. 更新最低版本、契约基线和人工硬件验证记录。
