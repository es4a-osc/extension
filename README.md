# ES4A VSC扩展

基于 [Simple](https://code.google.com/archive/p/simple/) 语言的安卓应用开发工具，使用[中文代码](https://gitee.com/es4a/sdk/blob/main/docs/Simple语言定义.md)开发、可视化窗口设计与编译运行。

## 界面预览

<img src="https://cdn.jsdmirror.cn/gh/es4a-osc/extension@main/preview1.png" alt="窗口设计器：属性、布局与组件选择" width="640">
<br />
<img src="https://cdn.jsdmirror.cn/gh/es4a-osc/extension@main/preview2.png" alt="Simple 代码编辑与项目管理" width="640">


## 功能特性

### VSC 扩展

- **项目管理**：同时管理多个项目，统一浏览单元、资产、资源和构建产物。
- **类库浏览**：按分类查看 SDK 中的组件、对象及其成员说明。
- **窗口设计**：拖放组件、调整布局、编辑属性，快速插入事件处理代码。
- **代码编辑**：语法与语义着色、智能补全、参数提示和悬停说明。
- **导航与诊断**：转到定义、查找引用、项目内代码搜索和引用诊断。
- **关联重构**：重命名变量、组件、单元和源码文件夹，同步更新关联引用；支持单元与文件夹移动。
- **构建运行**：一键构建 APK，安装到安卓设备或模拟器并启动应用。

### 编译器与运行库

- **中文代码**：支持命名空间、对象继承、接口实现、按参数个数重载及变量声明时的表达式初始化。
- **编码支持**：代码内容采用 UTF-8 编码，文本支持中文与表情符号。
- **构建环境**：使用 JDK 11，编译与目标安卓 API 为 30，最低支持 API 24。
- **扩展库接入**：支持 JAR、AAR 和在线、离线依赖，自动解析传递依赖、选择版本并检查冲突。
- **资源与清单**：打包资产与资源，生成 R 资源索引，合并第三方资源与清单，支持权限汇总和配置宏。
- **APK 构建**：支持多 DEX 与原生库（`.so`）打包，默认生成 V1、V2、V3 签名，可使用调试或自定义密钥库。
- **运行支持**：提供常用组件与对象，支持服务、多线程、事件来源查询、事件转移和动态事件调用。
- **布局支持**：支持线性与相对布局，按方向、权重或组件关系组织界面。
- **数据与网络**：提供 SQLite、JSON、XML、正则、加密及 HTTP、TCP/UDP 等常用能力。

> 💖永远相信美好的事情即将发生！

## 快速上手

1. 在 VS Code 扩展市场安装 [ES4A](https://marketplace.visualstudio.com/items?itemName=paike.es4a)。
2. [下载完整 SDK](https://dwz.wsd.cx/es4a-sdk)并解压。
3. 在 ES4A “类库”视图中选择 SDK 根目录。
4. 在“项目”视图中新建 Simple 项目，或添加已有项目、示例的 `project.properties`。
5. 连接安卓设备或启动模拟器，按 `F5` 构建调试运行。

SDK 自带示例：

- Simple 示例：`sdk/simple/examples/`
- 扩展库示例：`sdk/libraries/*/example/`

语法和项目开发说明见 [SDK 文档](https://gitee.com/es4a/sdk/blob/main/docs/README.md)。


## 快捷提示

- 在变量或组件名处按 `F2`，重命名并同步关联引用。
- 在标识符处按 `Ctrl + I`显示匹配建议，选择后替换整个标识符。


## 相关链接

- [VSIX扩展](https://dwz.wsd.cx/es4a-vsix)
- [开源仓库](https://gitee.com/es4a)
- [留言反馈](https://dwz.wsd.cx/wsd-ly)
