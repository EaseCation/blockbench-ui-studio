# 测试宿主

测试副本固定 Blockbench 5.2.1 / e2ede0809ee6bc91f374ac7e00d34cffbdf86a14。原始源码仓库仅用作只读参考。

在插件根目录准备独立测试副本：

```sh
mkdir -p .cache
git clone https://github.com/JannisX11/blockbench.git .cache/blockbench
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

配套文字插件的集成用例默认读取同级 `../blockbench-bbmodel-text/dist/bbmodel-text-component.js`，也可设置 `MCUI_TEXT_PLUGIN` 指向实际构建文件。没有提供该插件时，相关用例会标记跳过，其余宿主测试正常执行。需要完整验证时先构建文字插件。

宿主用例通过host-test固定启动新闻和插件统计响应，避免外部CDN连接失败产生与本地编辑无关的未处理异常；不会屏蔽插件自身的pageerror。
