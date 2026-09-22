# 测试宿主

测试副本固定 Blockbench 5.2.1 / e2ede0809ee6bc91f374ac7e00d34cffbdf86a14。原始源码仓库仅用作只读参考。

在插件根目录准备独立测试副本：

```sh
mkdir -p .cache
git clone --shared /Users/fangyizhou/Documents/coding/blockbench .cache/blockbench
git -C .cache/blockbench checkout --detach e2ede0809ee6bc91f374ac7e00d34cffbdf86a14
npm --prefix .cache/blockbench ci --ignore-scripts
cd .cache/blockbench
node build.js --target=web
cd ../..
npm run build
npm run test:host
```

默认使用系统 Chrome 和独立临时浏览器上下文，WebGL 采用软件渲染。可通过 `MCUI_HOST_DIR` 指定其他已构建宿主路径。测试服务只监听 127.0.0.1:4178。

测试原生往返时使用另一个未加载插件的页面，原生解析后再保存；不以手工读取 JSON 代替这个测试。像素测试比较解码后的 RGBA，而不是 PNG 编码字节。

人工检查：Mac 触摸板惯性与捏合、鼠标中键、真实剪贴板图片、半透明视觉、绘画手感，以及未安装插件的桌面应用。执行结果与未完成项目记录在 `docs/verification.md`。
