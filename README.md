# 摸鱼浏览器投影（CDP）

在 Cursor、Kiro、VS Code 等基于 VS Code 的编辑器中，将浏览器页面通过 CDP 投影到编辑区并可直接交互操作。

## 当前版本亮点

- CDP 投影浏览器页面（鼠标、滚轮、键盘可操作）
- 顶部工具栏精简布局，按钮会随编辑器宽度动态缩放
- 标签区默认折叠，展开后可切换/关闭/清空标签
- 收藏夹支持：新增、重命名、删除、点击跳转
- 新标签按钮改为“网址选择模式”：`Bing` + 收藏夹二选一
- 主题滤镜三档（关/轻/强），放在二级“设置”区域
- 设置区支持 `Clash` 开关，可在受管启动时走代理
- 默认目标帧率提升到 `120fps`（受设备与页面复杂度影响）
- 所有提示/报错统一输出到 `Output: moyu-browser`（不弹通知）
- `Esc Esc` 老板键：按关闭语义退出并清理相关受管进程

## 安装（VSIX）

1. 打开扩展视图
2. 右上角点击 `...`
3. 选择 `Install from VSIX...`
4. 选择本目录中的 `moyu-browser-0.1.47.vsix`

## 命令

- `摸鱼: 连接默认浏览器投影（CDP）`
- `摸鱼: 一键启动（投影）`
- `摸鱼: 老板键（立即切回代码）`

## 默认快捷键

- `Esc Esc`：老板键（仅在投影面板激活时）

## 工具栏说明（当前 UI）

- **导航**：`返回` / `刷新` / `新标签` / 地址栏输入 / `跳转`
- **标签区**：点击 `已打开 n 个标签页` 展开；支持：
  - 点击行切换标签
  - 行内 `×` 关闭单个标签
  - 顶部 `清空标签`
- **收藏夹**：
  - `+` 新增当前页面到收藏（会要求输入名称）
  - 展开后点击收藏项直接跳转
  - `✎` 重命名收藏
  - `×` 删除收藏
- **设置**：
  - 点击 `显示设置` 展开二级设置
  - `主题滤镜` 在 `关/轻/强` 之间循环
  - `Clash` 在 `开/关` 之间切换（受管浏览器模式下生效）

## 新标签逻辑（已调整）

点击 `新标签` 后，会弹出选择列表，只允许从以下来源打开：

1. `https://www.bing.com`
2. 收藏夹中的任一网址

不再直接走旧的“默认 URL 新建”逻辑。

## 输入与兼容性

- 支持中文输入法（IME 组合输入）
- 常用控制键（回车、退格、方向键等）已做单独处理
- 回车提交搜索已针对 CDP 键盘事件做兼容字段补全

## 日志与诊断

- 扩展不再弹出提示通知
- 所有状态、告警、错误写入 `Output: moyu-browser`
- 失败诊断会自动输出详细日志；必要时会复制诊断文本到剪贴板

## 配置项（仍可用）

- `moyu.cdp.host`：CDP 主机（默认 `127.0.0.1`）
- `moyu.cdp.port`：CDP 端口（默认 `9222`）
- `moyu.cdp.fps`：投影帧率
- `moyu.cdp.jpegQuality`：投影 JPEG 质量
- `moyu.cdp.defaultUrl`：默认网址（作为兜底）
- `moyu.cdp.clashProxyServer`：Clash 代理地址（默认 `127.0.0.1:7890`）
- `moyu.cdp.minimizeBrowserWindow`：自动最小化浏览器窗口（Windows）
- `moyu.cdp.autoLaunchManagedBrowser`：接管失败时尝试受管启动浏览器（Windows）
- `moyu.cdp.headlessManaged`：受管浏览器无窗口模式
- `moyu.cdp.allowOpenExternalFallback`：允许回退到系统浏览器打开
- `moyu.cdp.browserPreference`：受管浏览器优先级（`edge` / `system` / `chrome`）

## 快速启动说明

- 右下状态栏有 `fish` 按钮
- 点击后会直接走“一键启动 + 新建标签投影”
- 当前流程不再询问“恢复上次页面”

## 浏览器启动示例（Windows）

Chrome:

```powershell
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Edge:

```powershell
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

## 限制说明

- CDP 投影是远程控制与画面流，不是系统窗口原生嵌入
- 网页内容样式由网站决定；扩展只能调整外围 UI 和滤镜
- Clash 开关主要作用于扩展“受管启动”的浏览器进程；外部已运行浏览器是否走代理取决于其自身设置

## 资源治理

- 后台定时维护：默认每 `15min` 清理一次过期临时 profile 目录
- CDP 请求超时回收 + 帧背压渲染，降低长时运行内存增长风险

## 开发与打包

```bash
npm install
npm run compile
npm run package
```

> `npm run package` 会在打包前自动清理目录里的旧版 `moyu-browser-*.vsix`，仅保留最新包。
