# 摸鱼浏览器投影（CDP）

在 Cursor、Kiro、VS Code 这类基于 VS Code 的编辑器里，把默认浏览器标签页投影到代码编辑区中操作（CDP）。

## 功能

- 连接默认浏览器标签页并投影到编辑区（CDP）
- 自动重连上次标签页（可配置）
- 地址栏输入/回车跳转，支持刷新
- 投影工具栏支持：切换标签 / 刷新 / 新标签 / 地址输入跳转
- 投影质量预设：`低延迟` / `高画质`
- 主题滤镜：`关/轻/强` 三档，减少投影画面与编辑器配色的割裂感
- 使用 VS Code 主题变量，界面颜色自动跟随深浅主题
- 字体读取 `editor.fontFamily`、`editor.fontSize`、`editor.fontWeight`
- 一键“老板键”：立即关闭浏览器并切回普通代码文件

## 安装（VSIX）

1. 打开扩展视图
2. 点击右上角 `...`
3. 选择 `Install from VSIX...`
4. 选择本目录中的 `vsix`文件

## 命令

- `摸鱼: 连接默认浏览器投影（CDP）`
- `摸鱼: 一键启动（投影）`
- `摸鱼: 老板键（立即切回代码）`

## 默认快捷键

- 老板键：`Esc Esc`（双击 Esc，仅在内嵌浏览器面板激活时）

如果和你当前快捷键冲突，请在键盘快捷方式中按 `moyu` 搜索并改绑。

## 配置项

- `moyu.cdp.host`：CDP 主机（默认 `127.0.0.1`）
- `moyu.cdp.port`：CDP 端口（默认 `9222`）
- `moyu.cdp.fps`：投影帧率（默认 `40`，极速）
- `moyu.cdp.jpegQuality`：投影画质（默认 `20`，极低延迟）
- `moyu.cdp.quickStartAskRestore`：一键启动时是否询问“恢复上次页面”（默认 `true`）
- `moyu.cdp.defaultUrl`：一键启动新建标签页默认地址（默认 `https://www.bing.com`）
- `moyu.cdp.minimizeBrowserWindow`：自动最小化浏览器窗口（默认 `true`，Windows）
- `moyu.cdp.autoLaunchManagedBrowser`：接管失败时自动最小化启动受管浏览器并重试投影（默认 `true`，Windows）
- `moyu.cdp.headlessManaged`：受管浏览器使用无窗口模式（默认 `true`）
- `moyu.cdp.allowOpenExternalFallback`：允许回退到系统浏览器打开（默认 `false`，避免弹窗）
- `moyu.cdp.browserPreference`：受管启动浏览器优先级（默认 `edge`，可选 `system` / `chrome`）

## 使用说明

### A. 默认浏览器投影（推荐）

1. 先用远程调试参数启动你的浏览器（建议复用你平时的用户数据目录）
2. 在扩展执行 `摸鱼: 连接默认浏览器投影（CDP）`
3. 输入端口（默认 `9222`），选择要投影的标签页
4. 投影工具栏中可：切换标签、刷新、新标签、地址栏跳转、切换低延迟/高画质、主题滤镜（关/轻/强）
5. 点击投影画面后，可直接鼠标/滚轮/键盘操作
6. 若“新标签”失败，会自动写入 `Output: moyu-browser` 详细诊断日志，可一键复制
7. 默认主题滤镜为“强”

### 一键启动入口

- 右下状态栏有 `fish` 按钮（纯文本，无图标）
- 点击后会：
  1) 新建并连接一个浏览器标签页  
  2) 如果存在上次记录，会弹出是否恢复上次页面（可通过配置关闭询问）

Windows 示例（Chrome）：

```powershell
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Windows 示例（Edge）：

```powershell
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

> 说明：若你要明确复用某个资料目录，可再追加 `--user-data-dir=...` 参数。

## 限制说明

- CDP 投影模式：是“远程控制与画面投送”，不是系统窗口句柄硬嵌入；但可复用你浏览器环境，贴近日常使用习惯。
- 主题同步说明：会同步扩展 UI（工具栏/按钮/字体）到编辑器主题；网页内容本身由网站决定，不能强制改成编辑器主题。

## 开发与打包

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```
