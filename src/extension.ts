import * as vscode from "vscode";
import WebSocket from "ws";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const VIEW_TYPE = "moyu.embeddedBrowser";
const CDP_VIEW_TITLE = "浏览器投影 (CDP)";

let panel: vscode.WebviewPanel | undefined;
let cdpSession: CdpSession | undefined;
let extensionContextRef: vscode.ExtensionContext | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let diagnosticOutput: vscode.OutputChannel | undefined;
let minimizePulseTimer: NodeJS.Timeout | undefined;
let autoFollowTimer: NodeJS.Timeout | undefined;
let tabOperationBusy = false;
let newTabBusy = false;
let silentCloseReason: string | undefined;
let replacingPanel = false;
let projectionRuntime:
  | {
      host: string;
      port: number;
      target: CdpTarget;
    }
  | undefined;

const LAST_PROJECTION_KEY = "moyu.lastProjection";
const BOOKMARKS_KEY = "moyu.bookmarks";

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
}

interface CdpHistoryEntry {
  id: number;
  title?: string;
  url?: string;
}

interface BookmarkItem {
  title: string;
  url: string;
}

function logLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  diagnosticOutput?.appendLine(line);
}

function readBookmarks(): BookmarkItem[] {
  const raw = extensionContextRef?.globalState.get<BookmarkItem[]>(BOOKMARKS_KEY) || [];
  return raw.filter((b) => typeof b?.title === "string" && typeof b?.url === "string");
}

async function writeBookmarks(items: BookmarkItem[]): Promise<void> {
  await extensionContextRef?.globalState.update(BOOKMARKS_KEY, items);
}

type CdpPending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

class CdpSession {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, CdpPending>();
  private streamTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private disposed = false;
  private readonly onFrame: (base64Jpeg: string) => void;
  private readonly onClosed: (reason: string) => void;
  private isScreencast = false;

  private constructor(
    ws: WebSocket,
    fps: number,
    jpegQuality: number,
    onFrame: (base64Jpeg: string) => void,
    onClosed: (reason: string) => void
  ) {
    this.ws = ws;
    this.onFrame = onFrame;
    this.onClosed = onClosed;

    this.streamTimer = undefined;
  }

  static async connect(
    wsUrl: string,
    fps: number,
    jpegQuality: number,
    onFrame: (base64Jpeg: string) => void,
    onClosed: (reason: string) => void
  ): Promise<CdpSession> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      sock.once("open", () => resolve(sock));
      sock.once("error", reject);
    });

    const session = new CdpSession(ws, fps, jpegQuality, onFrame, onClosed);
    session.bindEvents();
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await session.send("Page.setLifecycleEventsEnabled", { enabled: false });
    session.captureQuality = Math.min(95, Math.max(20, jpegQuality));
    await session.startStreaming(Math.max(1, fps));
    return session;
  }

  private captureQuality = 60;
  private fpsToInterval(fps: number): number {
    return Math.max(16, Math.floor(1000 / Math.max(1, fps)));
  }

  private bindEvents(): void {
    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString()) as {
          id?: number;
          result?: { data?: string };
          error?: { message?: string };
          method?: string;
          params?: { data?: string; sessionId?: number };
        };
        if (typeof data.id === "number") {
          const pending = this.pending.get(data.id);
          if (!pending) {
            return;
          }
          this.pending.delete(data.id);
          if (data.error) {
            pending.reject(new Error(data.error.message || "CDP 调用失败"));
          } else {
            pending.resolve(data.result);
          }
          return;
        }

        // Event-driven frame stream for lower latency.
        if (data.method === "Page.screencastFrame" && data.params?.data) {
          this.onFrame(data.params.data);
          void this.send("Page.screencastFrameAck", { sessionId: data.params.sessionId ?? 0 });
        }
      } catch {
        // Ignore malformed payloads.
      }
    });

    this.ws.on("close", () => {
      this.close("浏览器调试连接已关闭");
    });
    this.ws.on("error", () => {
      this.close("浏览器调试连接出错");
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) {
      throw new Error("会话已关闭");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(payload);
    return p;
  }

  async capture(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const result = (await this.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.captureQuality,
        fromSurface: true,
      })) as { data?: string };
      if (result?.data) {
        this.onFrame(result.data);
      }
    } catch {
      // Keep running; transient failures happen while pages navigate.
    }
  }

  private async startStreaming(fps: number): Promise<void> {
    // Prefer Page.screencast for lower latency and smoother updates.
    try {
      await this.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.captureQuality,
        everyNthFrame: 1,
      });
      this.isScreencast = true;
      return;
    } catch {
      this.isScreencast = false;
    }

    // Fallback polling for browsers lacking screencast.
    this.streamTimer = setInterval(() => {
      void this.capture();
    }, this.fpsToInterval(fps));
    await this.capture();
  }

  private async stopStreaming(): Promise<void> {
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
    if (this.isScreencast) {
      try {
        await this.send("Page.stopScreencast");
      } catch {
        // ignore
      }
      this.isScreencast = false;
    }
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  async reload(ignoreCache = false): Promise<void> {
    await this.send("Page.reload", { ignoreCache });
  }

  async goBack(): Promise<void> {
    try {
      const result = (await this.send("Page.getNavigationHistory")) as {
        currentIndex?: number;
        entries?: CdpHistoryEntry[];
      };
      const currentIndex = typeof result.currentIndex === "number" ? result.currentIndex : -1;
      const entries = Array.isArray(result.entries) ? result.entries : [];
      if (currentIndex > 0 && entries[currentIndex - 1]?.id) {
        await this.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
        return;
      }
    } catch {
      // Fallback below.
    }
    await this.send("Runtime.evaluate", {
      expression: "history.back()",
      awaitPromise: false,
      userGesture: true,
    });
  }

  async createTarget(url: string): Promise<string | undefined> {
    const result = (await this.send("Target.createTarget", { url })) as { targetId?: string };
    return result?.targetId;
  }

  async openWindow(url: string): Promise<void> {
    await this.send("Runtime.evaluate", {
      expression: `window.open(${JSON.stringify(url)}, "_blank")`,
      awaitPromise: false,
      userGesture: true,
    });
  }

  async minimizeWindowByCdp(): Promise<void> {
    try {
      const win = (await this.send("Browser.getWindowForTarget")) as { windowId?: number };
      if (!win?.windowId) {
        return;
      }
      await this.send("Browser.setWindowBounds", {
        windowId: win.windowId,
        bounds: { windowState: "minimized" },
      });
    } catch {
      // Ignore unsupported Browser domain errors.
    }
  }

  setStreamProfile(fps: number, quality: number): void {
    this.captureQuality = Math.min(95, Math.max(20, quality));
    void (async () => {
      await this.stopStreaming();
      await this.startStreaming(Math.max(1, fps));
    })();
  }

  async mouse(
    eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
    x: number,
    y: number,
    button: "none" | "left" | "middle" | "right",
    deltaX = 0,
    deltaY = 0
  ): Promise<void> {
    const buttonMask = button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0;
    await this.send("Input.dispatchMouseEvent", {
      type: eventType,
      x,
      y,
      button,
      clickCount: button === "none" ? 0 : 1,
      buttons: buttonMask,
      deltaX,
      deltaY,
    });
  }

  async key(type: "keyDown" | "keyUp", key: string, code: string, keyCode: number): Promise<void> {
    if (type === "keyDown" && key.length === 1) {
      await this.send("Input.insertText", { text: key });
      return;
    }
    const isEnter = key === "Enter" || code === "Enter" || keyCode === 13;
    await this.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      text: type === "keyDown" && (key.length === 1 || isEnter) ? (isEnter ? "\r" : key) : undefined,
      unmodifiedText: type === "keyDown" && (key.length === 1 || isEnter) ? (isEnter ? "\r" : key) : undefined,
    });
  }

  async getCursorAt(x: number, y: number): Promise<string | undefined> {
    const result = (await this.send("Runtime.evaluate", {
      expression: `(function(){var e=document.elementFromPoint(${Math.round(x)},${Math.round(y)});if(!e){return "default";}var c=getComputedStyle(e).cursor;return c||"default";})()`,
      returnByValue: true,
      awaitPromise: false,
    })) as { result?: { value?: unknown } };
    const v = result?.result?.value;
    return typeof v === "string" ? v : undefined;
  }

  close(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(new Error(`会话结束: ${id}`));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.onClosed(reason);
  }
}

function normalizePageTargets(targets: CdpTarget[]): CdpTarget[] {
  return targets
    .filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

async function closeCdpTarget(host: string, port: number, targetId: string): Promise<boolean> {
  try {
    const endpoint = `http://${host}:${port}/json/close/${encodeURIComponent(targetId)}`;
    let resp = await fetch(endpoint, { method: "PUT" });
    if (!resp.ok) {
      resp = await fetch(endpoint, { method: "GET" });
    }
    return resp.ok;
  } catch {
    return false;
  }
}

async function syncTabList(host: string, port: number, activeId?: string): Promise<void> {
  if (!panel) {
    return;
  }
  const targets = await getCdpTargets(host, port);
  const pages = normalizePageTargets(targets || []);
  await panel.webview.postMessage({
    type: "tabs",
    items: pages.map((p) => ({
      id: p.id,
      title: p.title || "(无标题)",
      url: p.url || "",
    })),
    activeId: activeId || projectionRuntime?.target.id || "",
  });
}

async function syncBookmarks(): Promise<void> {
  if (!panel) {
    return;
  }
  const items = readBookmarks();
  await panel.webview.postMessage({ type: "bookmarks", items });
}

async function withTabOperationLock(run: () => Promise<void>): Promise<void> {
  if (tabOperationBusy) {
    return;
  }
  tabOperationBusy = true;
  try {
    await run();
  } finally {
    tabOperationBusy = false;
  }
}

async function closeAllProjectionTabs(host: string, port: number): Promise<void> {
  const targets = await getCdpTargets(host, port);
  const pages = normalizePageTargets(targets || []);
  for (const t of pages) {
    await closeCdpTarget(host, port, t.id);
  }
}

async function cleanupProjectionResources(reason: string): Promise<void> {
  stopAutoFollowNewestTab();
  stopMinimizePulse();
  const rt = projectionRuntime;
  projectionRuntime = undefined;
  try {
    if (rt) {
      await closeAllProjectionTabs(rt.host, rt.port);
    }
  } catch {
    // Ignore cleanup errors.
  }
  if (cdpSession) {
    silentCloseReason = reason;
    cdpSession.close(reason);
    cdpSession = undefined;
  }
}

async function runBossKey(): Promise<void> {
  await cleanupProjectionResources("老板键触发");
  panel?.dispose();
  panel = undefined;

  const visibleCodeEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file");
  if (visibleCodeEditor) {
    await vscode.window.showTextDocument(visibleCodeEditor.document, {
      viewColumn: visibleCodeEditor.viewColumn,
      preview: false,
      preserveFocus: false,
    });
    return;
  }

  const firstWsFolder = vscode.workspace.workspaceFolders?.[0];
  if (firstWsFolder) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(firstWsFolder.uri);
      const fileEntry = entries.find(([, type]) => type === vscode.FileType.File);
      if (fileEntry) {
        const fileUri = vscode.Uri.joinPath(firstWsFolder.uri, fileEntry[0]);
        await vscode.window.showTextDocument(fileUri, { preview: false });
        return;
      }
    } catch {
      // Ignore and fallback.
    }
  }

  const doc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "// working notes\n" });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function getEditorTypography(): { family: string; size: string; weight: string } {
  const cfg = vscode.workspace.getConfiguration("editor");
  const family = cfg.get<string>("fontFamily") || "Consolas, 'Courier New', monospace";
  const size = `${cfg.get<number>("fontSize") ?? 14}px`;
  const weight = String(cfg.get<string | number>("fontWeight") ?? "400");
  return { family, size, weight };
}

/** Avoid breaking out of &lt;style&gt; if fontFamily contained angle brackets. */
function familyForInlineStyle(family: string): string {
  return family.replace(/</g, "");
}

function normalizeUrl(input: string): string | undefined {
  const t = input.trim();
  if (!t) {
    return undefined;
  }
  try {
    if (/^https?:\/\//i.test(t)) {
      new URL(t);
      return t;
    }
    const withScheme = `https://${t}`;
    new URL(withScheme);
    return withScheme;
  } catch {
    return undefined;
  }
}

function safeText(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function toPositiveInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  const n = Math.floor(v);
  return n > 0 ? n : fallback;
}

async function minimizeBrowserWindowsIfEnabled(log?: (line: string) => void): Promise<void> {
  const enabled = vscode.workspace.getConfiguration("moyu.cdp").get<boolean>("minimizeBrowserWindow") !== false;
  if (!enabled) {
    return;
  }
  if (process.platform !== "win32") {
    log?.("minimize skipped: non-win32");
    return;
  }
  const script = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class WinApi {",
    "  [DllImport(\"user32.dll\")]",
    "  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null",
    "$names = @('chrome','msedge','brave','vivaldi','firefox')",
    "foreach ($n in $names) {",
    "  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {",
    "    if ($_.MainWindowHandle -ne 0) { [WinApi]::ShowWindowAsync($_.MainWindowHandle, 6) | Out-Null }",
    "  }",
    "}",
  ].join("; ");

  await new Promise<void>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      () => resolve()
    );
  });
  log?.("minimize attempted for known browser windows");
}

function startAutoFollowNewestTab(context: vscode.ExtensionContext): void {
  stopAutoFollowNewestTab();
  autoFollowTimer = setInterval(() => {
    const rt = projectionRuntime;
    if (!rt || !panel) {
      return;
    }
    void (async () => {
      const targets = await getCdpTargets(rt.host, rt.port);
      if (!targets || targets.length === 0) {
        return;
      }
      const pages = targets.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl);
      if (pages.length === 0) {
        return;
      }
      const newest = pages.sort((a, b) => (a.id < b.id ? 1 : -1))[0];
      if (!newest || newest.id === rt.target.id) {
        return;
      }
      await attachProjectionTarget(context, rt.host, rt.port, newest);
    })();
  }, 1000);
}

function stopAutoFollowNewestTab(): void {
  if (autoFollowTimer) {
    clearInterval(autoFollowTimer);
    autoFollowTimer = undefined;
  }
}

function startMinimizePulse(log?: (line: string) => void): void {
  stopMinimizePulse();
  let count = 0;
  minimizePulseTimer = setInterval(() => {
    count += 1;
    void minimizeBrowserWindowsIfEnabled(log);
    if (count >= 12) {
      stopMinimizePulse();
    }
  }, 500);
}

function stopMinimizePulse(): void {
  if (minimizePulseTimer) {
    clearInterval(minimizePulseTimer);
    minimizePulseTimer = undefined;
  }
}

async function launchManagedBrowserWindowsIfEnabled(
  host: string,
  port: number,
  url: string,
  log?: (line: string) => void
): Promise<boolean> {
  const enabled = vscode.workspace.getConfiguration("moyu.cdp").get<boolean>("autoLaunchManagedBrowser") !== false;
  if (!enabled) {
    log?.("managed launch skipped: config disabled");
    return false;
  }
  if (process.platform !== "win32" || (host !== "127.0.0.1" && host !== "localhost")) {
    log?.("managed launch skipped: unsupported platform/host");
    return false;
  }

  const defaultExe = await detectWindowsDefaultBrowserExe(log);
  const preference =
    (vscode.workspace.getConfiguration("moyu.cdp").get<string>("browserPreference") || "edge").toLowerCase();
  const edgePaths = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const chromePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const ordered =
    preference === "system"
      ? [defaultExe || "", ...edgePaths, ...chromePaths]
      : preference === "chrome"
        ? [...chromePaths, defaultExe || "", ...edgePaths]
        : [...edgePaths, defaultExe || "", ...chromePaths];
  const candidates = [
    ...ordered,
  ].filter((p) => fs.existsSync(p));

  if (candidates.length === 0) {
    log?.("managed launch failed: no chrome/edge executable found");
    return false;
  }

  const browserExe = candidates[0];
  const profileRoot = path.join(os.tmpdir(), "moyu-cdp-profile-");
  const userDataDir = fs.mkdtempSync(profileRoot);
  const cfg = vscode.workspace.getConfiguration("moyu.cdp");
  const headlessManaged = cfg.get<boolean>("headlessManaged") !== false;
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-minimized",
    "--new-window",
    url,
  ];
  if (headlessManaged) {
    args.push("--headless=new");
    args.push("--disable-gpu");
    args.push("--window-size=1366,768");
  }
  const psArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(", ");
  const script = `Start-Process -FilePath '${browserExe.replace(/'/g, "''")}' -ArgumentList @(${psArgs}) -WindowStyle Hidden`;

  await new Promise<void>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      () => resolve()
    );
  });
  log?.(`managed browser launch requested: ${browserExe}`);
  log?.(`managed browser user-data-dir: ${userDataDir}`);
  log?.(`managed browser mode: ${headlessManaged ? "headless" : "visible-minimized"}`);
  log?.(`managed browser preference: ${preference}`);
  return true;
}

async function detectWindowsDefaultBrowserExe(log?: (line: string) => void): Promise<string | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }
  const userChoiceKey =
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice";
  const commandKeyBase = "HKCR";

  const runReg = async (args: string[]): Promise<string | undefined> =>
    new Promise((resolve) => {
      execFile("reg.exe", args, { windowsHide: true }, (_err, stdout) => {
        resolve(stdout || undefined);
      });
    });

  const userChoiceOut = await runReg(["query", userChoiceKey, "/v", "ProgId"]);
  const progIdMatch = userChoiceOut?.match(/ProgId\s+REG_SZ\s+([^\r\n]+)/i);
  const progId = progIdMatch?.[1]?.trim();
  if (!progId) {
    log?.("default browser detection: no ProgId");
    return undefined;
  }

  const cmdKey = `${commandKeyBase}\\${progId}\\shell\\open\\command`;
  const cmdOut = await runReg(["query", cmdKey, "/ve"]);
  const cmdMatch = cmdOut?.match(/REG_SZ\s+([^\r\n]+)/i);
  const rawCmd = cmdMatch?.[1]?.trim();
  if (!rawCmd) {
    log?.(`default browser detection: command missing for ${progId}`);
    return undefined;
  }

  const quotedExe = rawCmd.match(/^"([^"]+\.exe)"/i)?.[1];
  const bareExe = rawCmd.match(/^([^\s]+\.exe)/i)?.[1];
  const exe = quotedExe || bareExe;
  if (exe && fs.existsSync(exe)) {
    log?.(`default browser detection: ${exe}`);
    return exe;
  }
  log?.(`default browser detection: resolved exe not found (${exe || "unknown"})`);
  return undefined;
}

function getCdpProjectionHtml(webview: vscode.Webview, pageTitle: string): string {
  const { family, size, weight } = getEditorTypography();
  const familyCss = familyForInlineStyle(family);
  const nonce = String(Math.random()).slice(2);
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src data: blob:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --moyu-font: ${familyCss};
      --moyu-font-size: ${size};
      --moyu-font-weight: ${weight};
      --moyu-ui-scale: 1;
      --moyu-btn-font-size: 12px;
      --moyu-btn-padding-y: 4px;
      --moyu-btn-padding-x: 8px;
      --moyu-btn-height: 28px;
      --moyu-gap: 6px;
    }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--moyu-font);
      font-size: var(--moyu-font-size);
      font-weight: var(--moyu-font-weight);
    }
    .root { display: flex; flex-direction: column; height: 100%; }
    .bar {
      display: flex;
      flex-direction: column;
      gap: var(--moyu-gap);
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--moyu-gap);
      min-width: 0;
      flex-wrap: wrap;
    }
    .group {
      display: flex;
      align-items: center;
      gap: var(--moyu-gap);
      padding: 2px 0;
      min-width: 0;
    }
    .group-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-right: 2px;
      white-space: nowrap;
    }
    .bar input {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--moyu-font);
      font-size: var(--moyu-btn-font-size);
      border-radius: 2px;
      padding: var(--moyu-btn-padding-y) var(--moyu-btn-padding-x);
      min-height: var(--moyu-btn-height);
      box-sizing: border-box;
    }
    .bar button {
      border: none;
      border-radius: 2px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-family: var(--moyu-font);
      font-size: var(--moyu-btn-font-size);
      padding: var(--moyu-btn-padding-y) var(--moyu-btn-padding-x);
      min-height: var(--moyu-btn-height);
      box-sizing: border-box;
      cursor: pointer;
    }
    .bar button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .tabs {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 120px;
      overflow-y: auto;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
    }
    .tabs.collapsed {
      display: none;
    }
    .tabs-actions {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 2px;
    }
    .tabs-clear {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--moyu-font);
      font-size: 12px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .tabs-toggle {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--moyu-font);
      font-size: 12px;
      padding: 4px 8px;
      text-align: left;
      cursor: pointer;
      width: 100%;
    }
    .tabs-toggle:hover {
      background: color-mix(in srgb, var(--vscode-button-background) 14%, var(--vscode-editor-background));
    }
    .tab-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      padding: 2px 4px 2px 8px;
      user-select: none;
      cursor: pointer;
    }
    .tab-row.active {
      border-color: var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-button-background) 16%, var(--vscode-editor-background));
    }
    .tab-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      flex: 1;
    }
    .tab-url {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      max-width: 40%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tab-close {
      border: none;
      border-radius: 999px;
      width: 20px;
      height: 20px;
      line-height: 18px;
      text-align: center;
      padding: 0;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      flex: 0 0 auto;
    }
    .tab-close:hover {
      background: color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
      color: var(--vscode-editor-foreground);
    }
    .bookmark-panel {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 150px;
      overflow-y: auto;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
    }
    .bookmark-panel.collapsed {
      display: none;
    }
    .settings-panel {
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
    }
    .settings-panel.collapsed {
      display: none;
    }
    .bookmark-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      padding: 2px 4px 2px 8px;
      user-select: none;
      cursor: pointer;
    }
    .bookmark-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      flex: 1;
    }
    .bookmark-url {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      max-width: 40%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bookmark-add {
      border-radius: 999px;
      width: 20px;
      height: 20px;
      line-height: 18px;
      padding: 0;
      text-align: center;
    }
    .bookmark-edit {
      border: none;
      border-radius: 999px;
      width: 20px;
      height: 20px;
      line-height: 18px;
      text-align: center;
      padding: 0;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      flex: 0 0 auto;
    }
    .stage {
      flex: 1;
      position: relative;
      outline: none;
      cursor: default;
      user-select: none;
    }
    .stage img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .hint {
      position: absolute;
      right: 8px;
      bottom: 8px;
      font-size: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
      padding: 4px 6px;
      border-radius: 3px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="root">
    <div class="bar">
      <div class="row">
        <div class="group">
          <span class="group-label">导航</span>
          <button id="back" type="button">返回</button>
          <button id="reload" type="button">刷新</button>
          <button id="newTab" type="button">新标签</button>
          <input id="url" type="text" value="" placeholder="输入网址并回车" />
          <button id="go" type="button">跳转</button>
        </div>
        <div class="group">
          <span class="group-label">标签管理</span>
          <button id="settingsToggle" type="button">显示设置</button>
        </div>
        <div class="group">
          <span class="group-label">收藏夹</span>
          <button id="bookmarkToggle" type="button">收藏夹（0）</button>
          <button id="bookmarkAddInline" class="bookmark-add" type="button" title="收藏当前">+</button>
        </div>
      </div>
      <button id="tabsToggle" class="tabs-toggle" type="button">已打开 0 个标签页</button>
      <div id="tabs" class="tabs collapsed"></div>
      <div id="bookmarkPanel" class="bookmark-panel collapsed"></div>
      <div id="settingsPanel" class="settings-panel collapsed">
        <button id="themeFilter" type="button">主题滤镜: 强</button>
      </div>
    </div>
    <div id="stage" class="stage" tabindex="0">
      <img id="frame" alt="cdp-stream-frame" />
      <div id="tint" style="position:absolute;inset:0;pointer-events:none;background:var(--vscode-editor-background);mix-blend-mode:multiply;opacity:0;"></div>
      <div class="hint">Esc Esc 老板键 | ${escapeAttr(pageTitle)}</div>
    </div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const stage = document.getElementById("stage");
      const frame = document.getElementById("frame");
      const tint = document.getElementById("tint");
      const urlInput = document.getElementById("url");
      const themeFilterBtn = document.getElementById("themeFilter");
      const settingsToggleEl = document.getElementById("settingsToggle");
      const settingsPanelEl = document.getElementById("settingsPanel");
      const tabsEl = document.getElementById("tabs");
      const tabsToggleEl = document.getElementById("tabsToggle");
      const bookmarkToggleEl = document.getElementById("bookmarkToggle");
      const bookmarkPanelEl = document.getElementById("bookmarkPanel");
      const textBridge = document.createElement("textarea");
      textBridge.setAttribute("aria-hidden", "true");
      textBridge.style.position = "fixed";
      textBridge.style.left = "-9999px";
      textBridge.style.top = "0";
      textBridge.style.opacity = "0";
      textBridge.style.pointerEvents = "none";
      textBridge.style.width = "1px";
      textBridge.style.height = "1px";
      document.body.appendChild(textBridge);
      let imeComposing = false;
      let tabsCollapsed = true;
      let bookmarksCollapsed = true;
      let settingsCollapsed = true;
      let lastTabs = [];
      let lastActiveTabId = "";
      let lastBookmarks = [];
      let themeFilterLevel = 2; // 0 off, 1 soft, 2 strong

      function applyResponsiveScale() {
        const w = Math.max(320, window.innerWidth || 320);
        // 0.82 ~ 1.18 scaling based on editor width.
        const scale = Math.max(0.82, Math.min(1.18, w / 1200));
        document.documentElement.style.setProperty("--moyu-ui-scale", String(scale));
        document.documentElement.style.setProperty("--moyu-btn-font-size", (12 * scale).toFixed(2) + "px");
        document.documentElement.style.setProperty("--moyu-btn-padding-y", Math.round(4 * scale) + "px");
        document.documentElement.style.setProperty("--moyu-btn-padding-x", Math.round(8 * scale) + "px");
        document.documentElement.style.setProperty("--moyu-btn-height", Math.round(28 * scale) + "px");
        document.documentElement.style.setProperty("--moyu-gap", Math.max(4, Math.round(6 * scale)) + "px");
      }

      function applyThemeFilter() {
        if (themeFilterLevel === 0) {
          frame.style.filter = "";
          tint.style.opacity = "0";
          themeFilterBtn.textContent = "主题滤镜: 关";
          return;
        }
        if (themeFilterLevel === 1) {
          frame.style.filter = "saturate(0.9) contrast(0.95) brightness(0.97)";
          tint.style.opacity = "0.14";
          themeFilterBtn.textContent = "主题滤镜: 轻";
          return;
        }
        frame.style.filter = "saturate(0.82) contrast(0.9) brightness(0.95)";
        tint.style.opacity = "0.24";
        themeFilterBtn.textContent = "主题滤镜: 强";
      }

      function mapPoint(clientX, clientY) {
        const rect = stage.getBoundingClientRect();
        const w = frame.naturalWidth || rect.width || 1;
        const h = frame.naturalHeight || rect.height || 1;
        const scale = Math.min(rect.width / w, rect.height / h);
        const displayW = w * scale;
        const displayH = h * scale;
        const offsetX = (rect.width - displayW) / 2;
        const offsetY = (rect.height - displayH) / 2;
        const xIn = Math.min(Math.max(clientX - rect.left - offsetX, 0), displayW);
        const yIn = Math.min(Math.max(clientY - rect.top - offsetY, 0), displayH);
        return {
          x: Math.round(xIn / scale),
          y: Math.round(yIn / scale)
        };
      }

      function btn(button) {
        if (button === 1) return "middle";
        if (button === 2) return "right";
        return "left";
      }

      function renderTabs(items, activeId) {
        const list = Array.isArray(items) ? items : [];
        const count = list.length;
        tabsToggleEl.textContent = tabsCollapsed ? ("已打开 " + count + " 个标签页（点击展开）") : ("已打开 " + count + " 个标签页（点击收起）");
        tabsEl.classList.toggle("collapsed", tabsCollapsed);
        tabsEl.innerHTML = "";
        if (tabsCollapsed) {
          return;
        }

        const actions = document.createElement("div");
        actions.className = "tabs-actions";
        const clearBtn = document.createElement("button");
        clearBtn.className = "tabs-clear";
        clearBtn.type = "button";
        clearBtn.textContent = "清空标签";
        clearBtn.addEventListener("click", function () {
          vscode.postMessage({ type: "clearTabs" });
        });
        actions.appendChild(clearBtn);
        tabsEl.appendChild(actions);

        for (const item of list) {
          const row = document.createElement("div");
          row.className = "tab-row" + (item.id === activeId ? " active" : "");
          row.title = (item.title || "(无标题)") + "\\n" + (item.url || "");
          row.dataset.id = item.id || "";

          const title = document.createElement("span");
          title.className = "tab-title";
          title.textContent = item.title || item.url || "(无标题)";
          row.appendChild(title);

          const url = document.createElement("span");
          url.className = "tab-url";
          url.textContent = item.url || "";
          row.appendChild(url);

          const close = document.createElement("button");
          close.className = "tab-close";
          close.type = "button";
          close.textContent = "×";
          close.title = "关闭此标签";
          close.addEventListener("click", function (e) {
            e.stopPropagation();
            if (!item.id) return;
            vscode.postMessage({ type: "closeTab", targetId: item.id });
          });
          row.appendChild(close);

          row.addEventListener("click", function () {
            if (!item.id) return;
            tabsCollapsed = true; // temporary expand behavior
            vscode.postMessage({ type: "activateTab", targetId: item.id });
          });
          tabsEl.appendChild(row);
        }
      }

      function renderBookmarks(items) {
        const list = Array.isArray(items) ? items : [];
        bookmarkToggleEl.textContent = bookmarksCollapsed
          ? ("收藏夹（" + list.length + "）")
          : ("收藏夹（" + list.length + "，点击收起）");
        bookmarkPanelEl.classList.toggle("collapsed", bookmarksCollapsed);
        bookmarkPanelEl.innerHTML = "";
        if (bookmarksCollapsed) {
          return;
        }
        for (const b of list) {
          const row = document.createElement("div");
          row.className = "bookmark-row";
          row.title = (b.title || "") + "\\n" + (b.url || "");

          const title = document.createElement("span");
          title.className = "bookmark-title";
          title.textContent = b.title || b.url || "(无标题)";
          row.appendChild(title);

          const url = document.createElement("span");
          url.className = "bookmark-url";
          url.textContent = b.url || "";
          row.appendChild(url);

          const close = document.createElement("button");
          close.className = "tab-close";
          close.type = "button";
          close.textContent = "×";
          close.title = "删除收藏";
          close.addEventListener("click", function (e) {
            e.stopPropagation();
            if (!b.url) return;
            vscode.postMessage({ type: "bookmarkRemove", url: b.url });
          });
          row.appendChild(close);

          const edit = document.createElement("button");
          edit.className = "bookmark-edit";
          edit.type = "button";
          edit.textContent = "✎";
          edit.title = "重命名收藏";
          edit.addEventListener("click", function (e) {
            e.stopPropagation();
            if (!b.url) return;
            vscode.postMessage({ type: "bookmarkRename", url: b.url });
          });
          row.appendChild(edit);

          row.addEventListener("click", function () {
            if (!b.url) return;
            bookmarksCollapsed = true;
            vscode.postMessage({ type: "navigate", url: b.url });
          });
          bookmarkPanelEl.appendChild(row);
        }
      }
      function renderSettings() {
        settingsPanelEl.classList.toggle("collapsed", settingsCollapsed);
        settingsToggleEl.textContent = settingsCollapsed ? "显示设置" : "收起设置";
      }

      stage.addEventListener("mousedown", function (e) {
        stage.focus();
        textBridge.focus();
        const p = mapPoint(e.clientX, e.clientY);
        vscode.postMessage({ type: "mouse", eventType: "mousePressed", x: p.x, y: p.y, button: btn(e.button) });
        e.preventDefault();
      });
      stage.addEventListener("mouseup", function (e) {
        const p = mapPoint(e.clientX, e.clientY);
        vscode.postMessage({ type: "mouse", eventType: "mouseReleased", x: p.x, y: p.y, button: btn(e.button) });
      });
      stage.addEventListener("mousemove", function (e) {
        const p = mapPoint(e.clientX, e.clientY);
        vscode.postMessage({ type: "mouse", eventType: "mouseMoved", x: p.x, y: p.y, button: "none" });
      });
      stage.addEventListener("wheel", function (e) {
        const p = mapPoint(e.clientX, e.clientY);
        vscode.postMessage({
          type: "mouse",
          eventType: "mouseWheel",
          x: p.x,
          y: p.y,
          button: "none",
          deltaX: Math.round(e.deltaX),
          deltaY: Math.round(e.deltaY)
        });
        e.preventDefault();
      }, { passive: false });
      function handleStageKeyDown(e) {
        if (e.target === urlInput) {
          return;
        }
        // IME composition (Chinese/Japanese/Korean) should not be intercepted here.
        if (e.isComposing || e.key === "Process" || e.keyCode === 229) {
          textBridge.focus();
          return;
        }
        // Let normal typing go through textBridge input event channel.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          textBridge.focus();
          return;
        }
        vscode.postMessage({
          type: "key",
          eventType: "keyDown",
          key: e.key,
          code: e.code,
          keyCode: e.keyCode || e.which || 0
        });
        if (e.key !== "Escape") {
          e.preventDefault();
        }
      }
      function handleStageKeyUp(e) {
        if (e.target === urlInput) {
          return;
        }
        if (e.isComposing || e.key === "Process" || e.keyCode === 229) {
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          return;
        }
        vscode.postMessage({
          type: "key",
          eventType: "keyUp",
          key: e.key,
          code: e.code,
          keyCode: e.keyCode || e.which || 0
        });
        if (e.key !== "Escape") {
          e.preventDefault();
        }
      }
      stage.addEventListener("keydown", handleStageKeyDown);
      stage.addEventListener("keyup", handleStageKeyUp);
      textBridge.addEventListener("keydown", handleStageKeyDown);
      textBridge.addEventListener("keyup", handleStageKeyUp);
      textBridge.addEventListener("compositionstart", function () {
        imeComposing = true;
      });
      textBridge.addEventListener("compositionend", function () {
        imeComposing = false;
        if (!textBridge.value) return;
        vscode.postMessage({ type: "text", text: textBridge.value });
        textBridge.value = "";
      });
      textBridge.addEventListener("input", function () {
        if (imeComposing) return;
        if (!textBridge.value) return;
        vscode.postMessage({ type: "text", text: textBridge.value });
        textBridge.value = "";
      });

      document.getElementById("back").addEventListener("click", function () {
        vscode.postMessage({ type: "back" });
      });
      document.getElementById("reload").addEventListener("click", function () {
        vscode.postMessage({ type: "reload" });
      });
      document.getElementById("newTab").addEventListener("click", function () {
        vscode.postMessage({ type: "newTabPick" });
      });
      document.getElementById("bookmarkAddInline").addEventListener("click", function () {
        vscode.postMessage({ type: "bookmarkAdd" });
      });
      bookmarkToggleEl.addEventListener("click", function () {
        bookmarksCollapsed = !bookmarksCollapsed;
        renderBookmarks(lastBookmarks);
      });
      settingsToggleEl.addEventListener("click", function () {
        settingsCollapsed = !settingsCollapsed;
        renderSettings();
      });
      tabsToggleEl.addEventListener("click", function () {
        tabsCollapsed = !tabsCollapsed;
        renderTabs(lastTabs, lastActiveTabId);
      });
      document.getElementById("go").addEventListener("click", function () {
        vscode.postMessage({ type: "navigate", url: urlInput.value });
      });
      urlInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          vscode.postMessage({ type: "navigate", url: urlInput.value });
        }
      });
      themeFilterBtn.addEventListener("click", function () {
        themeFilterLevel = (themeFilterLevel + 1) % 3;
        applyThemeFilter();
      });
      applyThemeFilter();
      renderSettings();
      applyResponsiveScale();
      window.addEventListener("resize", applyResponsiveScale);

      window.addEventListener("message", function (event) {
        const m = event.data;
        if (!m || typeof m !== "object") return;
        if (m.type === "frame" && m.data) {
          frame.src = "data:image/jpeg;base64," + m.data;
        }
        if (m.type === "setUrl") {
          urlInput.value = m.url || "";
        }
        if (m.type === "typography") {
          document.documentElement.style.setProperty("--moyu-font", m.family || "monospace");
          document.documentElement.style.setProperty("--moyu-font-size", m.size || "14px");
          document.documentElement.style.setProperty("--moyu-font-weight", m.weight || "400");
        }
        if (m.type === "cursor" && typeof m.value === "string") {
          stage.style.cursor = m.value;
        }
        if (m.type === "tabs") {
          lastTabs = Array.isArray(m.items) ? m.items : [];
          lastActiveTabId = m.activeId || "";
          renderTabs(lastTabs, lastActiveTabId);
        }
        if (m.type === "bookmarks") {
          lastBookmarks = Array.isArray(m.items) ? m.items : [];
          renderBookmarks(lastBookmarks);
        }
      });
    })();
  </script>
</body>
</html>`;
}


function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}


function revealOrCreateCdpPanel(
  context: vscode.ExtensionContext,
  title: string,
  onInput: (msg: {
    type?: string;
    eventType?: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel" | "keyDown" | "keyUp";
    x?: number;
    y?: number;
    button?: "none" | "left" | "middle" | "right";
    deltaX?: number;
    deltaY?: number;
    key?: string;
    code?: string;
    keyCode?: number;
    profile?: "lowLatency" | "highQuality";
    url?: string;
    text?: string;
    targetId?: string;
    title?: string;
  }) => void
): void {
  const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
  replacingPanel = true;
  panel?.dispose();
  panel = vscode.window.createWebviewPanel(VIEW_TYPE, CDP_VIEW_TITLE, column, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  });
  panel.webview.html = getCdpProjectionHtml(panel.webview, title);
  pushTypography(panel.webview);

  panel.webview.onDidReceiveMessage(
    (msg) => {
      if (msg?.type === "autoBossKey") {
        void runBossKey();
        return;
      }
      onInput(msg);
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(
    () => {
      if (replacingPanel) {
        return;
      }
      void cleanupProjectionResources("面板已关闭");
      panel = undefined;
    },
    null,
    context.subscriptions
  );
  replacingPanel = false;
}

async function connectCdpProjection(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("moyu.cdp");
  const host = cfg.get<string>("host") || "127.0.0.1";
  const defaultPort = cfg.get<number>("port") ?? 9222;
  const fps = cfg.get<number>("fps") ?? 4;
  const jpegQuality = cfg.get<number>("jpegQuality") ?? 60;

  const inputPort = await vscode.window.showInputBox({
    title: "连接浏览器调试端口",
    prompt: "请输入 Chrome/Edge remote-debugging-port",
    value: String(defaultPort),
  });
  if (!inputPort) {
    return;
  }
  const port = Number(inputPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    logLine("ERROR", "连接失败：端口无效");
    diagnosticOutput?.show(true);
    return;
  }

  const targets = await getCdpTargets(host, port);
  if (!targets) {
    logLine("ERROR", `无法连接调试端口 http://${host}:${port}，请先用 --remote-debugging-port 启动浏览器`);
    diagnosticOutput?.show(true);
    return;
  }

  const pages = targets.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl);
  if (pages.length === 0) {
    logLine("WARN", "未发现可投影页面，请先在浏览器打开一个网页标签");
    diagnosticOutput?.show(true);
    return;
  }

  const picked = await pickPageTarget(pages, "选择要投影的浏览器标签页");
  if (!picked) {
    return;
  }

  await attachProjectionTarget(context, host, port, picked);
}

async function getCdpTargets(host: string, port: number): Promise<CdpTarget[] | undefined> {
  try {
    const resp = await fetch(`http://${host}:${port}/json/list`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return (await resp.json()) as CdpTarget[];
  } catch {
    return undefined;
  }
}

async function getCdpVersion(host: string, port: number): Promise<CdpVersionInfo | undefined> {
  try {
    const resp = await fetch(`http://${host}:${port}/json/version`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return (await resp.json()) as CdpVersionInfo;
  } catch {
    return undefined;
  }
}

async function createTargetViaBrowserWs(
  host: string,
  port: number,
  url: string,
  log?: (line: string) => void
): Promise<string | undefined> {
  const version = await getCdpVersion(host, port);
  if (!version?.webSocketDebuggerUrl) {
    log?.(`getCdpVersion missing webSocketDebuggerUrl, keys=${JSON.stringify(Object.keys(version || {}))}`);
    return undefined;
  }
  log?.(`browser ws: ${version.webSocketDebuggerUrl}`);
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(version.webSocketDebuggerUrl!);
    sock.once("open", () => resolve(sock));
    sock.once("error", reject);
  });

  try {
    const targetId = await new Promise<string | undefined>((resolve, reject) => {
      const id = Math.floor(Math.random() * 1000000) + 1;
      const timeout = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error("Target.createTarget timeout"));
      }, 5000);

      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString()) as {
            id?: number;
            result?: { targetId?: string };
            error?: { message?: string };
            method?: string;
          };
          // Ignore event frames; only consume the response matching this request id.
          if (typeof data.id !== "number" || data.id !== id) {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          if (data.error) {
            reject(new Error(data.error.message || "Target.createTarget failed"));
            return;
          }
          log?.(`Target.createTarget raw result=${JSON.stringify(data.result || {})}`);
          resolve(data.result?.targetId);
        } catch {
          // Ignore malformed non-response frames.
        }
      };

      ws.on("message", onMessage);
      ws.send(JSON.stringify({ id, method: "Target.createTarget", params: { url } }));
    });
    return targetId;
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

async function pickPageTarget(
  pages: CdpTarget[],
  title: string
): Promise<CdpTarget | undefined> {
  const picked = await vscode.window.showQuickPick(
    pages.map((p) => ({
      label: p.title || "(无标题)",
      description: p.url,
      detail: p.webSocketDebuggerUrl,
      target: p,
    })),
    { title }
  );
  return picked?.target;
}

function saveLastProjection(host: string, port: number, target: CdpTarget): void {
  if (!extensionContextRef) {
    return;
  }
  void extensionContextRef.globalState.update(LAST_PROJECTION_KEY, {
    host,
    port,
    targetId: target.id,
    targetUrl: target.url,
    targetTitle: target.title,
  });
}

async function attachProjectionTarget(
  context: vscode.ExtensionContext,
  host: string,
  port: number,
  target: CdpTarget
): Promise<void> {
  silentCloseReason = "切换会话";
  cdpSession?.close("切换会话");
  cdpSession = undefined;
  projectionRuntime = { host, port, target };

  let lastCursorSampleTs = 0;
  revealOrCreateCdpPanel(context, target.title || "(无标题)", (msg) => {
    const session = cdpSession;
    if (!session) {
      return;
    }
    if (msg.type === "mouse" && msg.eventType && typeof msg.x === "number" && typeof msg.y === "number") {
      void session.mouse(
        msg.eventType as "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
        msg.x,
        msg.y,
        msg.button || "none",
        msg.deltaX || 0,
        msg.deltaY || 0
      );
      if (msg.eventType === "mouseMoved") {
        const now = Date.now();
        if (now - lastCursorSampleTs > 80) {
          lastCursorSampleTs = now;
          void session.getCursorAt(msg.x, msg.y).then((cursor) => {
            if (cursor) {
              void panel?.webview.postMessage({ type: "cursor", value: cursor });
            }
          });
        }
      }
    }
    if (msg.type === "key" && msg.eventType && typeof msg.key === "string" && typeof msg.code === "string") {
      void session.key(
        msg.eventType === "keyUp" ? "keyUp" : "keyDown",
        msg.key,
        msg.code,
        typeof msg.keyCode === "number" ? msg.keyCode : 0
      );
    }
    if (msg.type === "text" && typeof msg.text === "string" && msg.text.length > 0) {
      void session.send("Input.insertText", { text: msg.text });
    }
    if (msg.type === "reload") {
      void session.reload(true);
    }
    if (msg.type === "back") {
      void session.goBack();
    }
    if (msg.type === "navigate") {
      const url = normalizeUrl(safeText(msg.url));
      if (!url) {
        logLine("WARN", "网址无效，已忽略跳转请求");
        return;
      }
      void panel?.webview.postMessage({ type: "setUrl", url });
      void session.navigate(url);
      if (projectionRuntime?.target) {
        projectionRuntime.target.url = url;
      }
    }
    if (msg.type === "preset") {
      if (msg.profile === "lowLatency") {
        session.setStreamProfile(60, 20);
      } else if (msg.profile === "highQuality") {
        session.setStreamProfile(20, 65);
      }
    }
    if (msg.type === "switchTab") {
      void switchProjectionTab(context);
    }
    if (msg.type === "activateTab" && typeof msg.targetId === "string" && msg.targetId) {
      void (async () => {
        const targets = await getCdpTargets(host, port);
        const picked = targets?.find((t) => t.id === msg.targetId && t.type === "page" && !!t.webSocketDebuggerUrl);
        if (picked) {
          await attachProjectionTarget(context, host, port, picked);
        }
      })();
    }
    if (msg.type === "closeTab" && typeof msg.targetId === "string" && msg.targetId) {
      void withTabOperationLock(async () => {
        const targetId = msg.targetId!;
        const currentId = projectionRuntime?.target.id || "";
        if (currentId === targetId) {
          const targets = await getCdpTargets(host, port);
          const pages = normalizePageTargets(targets || []);
          const backup = pages.find((p) => p.id !== targetId);
          if (backup) {
            await attachProjectionTarget(context, host, port, backup);
          } else {
            await createAndAttachNewTab(context);
          }
        }
        await closeCdpTarget(host, port, targetId);
        await syncTabList(host, port, projectionRuntime?.target.id);
      });
    }
    if (msg.type === "clearTabs") {
      void withTabOperationLock(async () => {
        await createAndAttachNewTab(context);
        const keepId = projectionRuntime?.target.id || "";
        const targets = await getCdpTargets(host, port);
        const pages = normalizePageTargets(targets || []);
        for (const t of pages) {
          if (t.id === keepId) {
            continue;
          }
          await closeCdpTarget(host, port, t.id);
        }
        await syncTabList(host, port, keepId);
      });
    }
    if (msg.type === "bookmarkAdd") {
      void (async () => {
        const currentUrl = normalizeUrl(projectionRuntime?.target.url || "");
        if (!currentUrl) {
          logLine("WARN", "收藏失败：当前网址为空");
          return;
        }
        const existing = readBookmarks();
        if (existing.some((b) => b.url === currentUrl)) {
          logLine("INFO", `收藏已存在：${currentUrl}`);
          await syncBookmarks();
          return;
        }
        const defaultTitle = projectionRuntime?.target.title || currentUrl;
        const inputTitle = await vscode.window.showInputBox({
          title: "添加收藏",
          prompt: "输入收藏名称",
          value: defaultTitle,
        });
        if (inputTitle === undefined) {
          return;
        }
        const customTitle = inputTitle.trim();
        const title = customTitle || defaultTitle;
        await writeBookmarks([{ title, url: currentUrl }, ...existing].slice(0, 100));
        logLine("INFO", `已添加收藏：${title} -> ${currentUrl}`);
        await syncBookmarks();
      })();
    }
    if (msg.type === "bookmarkRemove") {
      void (async () => {
        const toRemove = normalizeUrl(safeText(msg.url) || "") || safeText(msg.url);
        const existing = readBookmarks();
        const next = existing.filter((b) => b.url !== toRemove);
        await writeBookmarks(next);
        logLine("INFO", `已删除收藏：${toRemove}`);
        await syncBookmarks();
      })();
    }
    if (msg.type === "bookmarkRename") {
      void (async () => {
        const targetUrl = normalizeUrl(safeText(msg.url) || "") || safeText(msg.url);
        if (!targetUrl) {
          logLine("WARN", "重命名收藏失败：参数无效");
          return;
        }
        const hit = readBookmarks().find((b) => b.url === targetUrl);
        if (!hit) {
          logLine("WARN", `重命名收藏失败：未找到 ${targetUrl}`);
          return;
        }
        const inputTitle = await vscode.window.showInputBox({
          title: "重命名收藏",
          prompt: "输入新的收藏名称",
          value: hit.title || hit.url,
        });
        if (inputTitle === undefined) {
          return;
        }
        const nextTitle = inputTitle.trim() || hit.title || hit.url;
        const next = readBookmarks().map((b) => (b.url === targetUrl ? { ...b, title: nextTitle } : b));
        await writeBookmarks(next);
        logLine("INFO", `已重命名收藏：${targetUrl} -> ${nextTitle}`);
        await syncBookmarks();
      })();
    }
    if (msg.type === "newTabPick") {
      if (newTabBusy) {
        logLine("INFO", "新标签请求已忽略：上一个新建流程仍在进行");
        return;
      }
      void (async () => {
        const bookmarkItems = readBookmarks();
        const picks = [
          { label: "Bing", description: "https://www.bing.com", url: "https://www.bing.com" },
          ...bookmarkItems.map((b) => ({
            label: b.title || b.url,
            description: b.url,
            url: b.url,
          })),
        ];
        const picked = await vscode.window.showQuickPick(picks, {
          title: "新标签页：选择要打开的网址",
          placeHolder: "Bing 或收藏夹网址",
        });
        if (!picked?.url) {
          return;
        }
        newTabBusy = true;
        await createAndAttachNewTab(context, picked.url);
      })().finally(() => {
        newTabBusy = false;
      });
    }
  });

  try {
    const cfg = vscode.workspace.getConfiguration("moyu.cdp");
    const fps = cfg.get<number>("fps") ?? 4;
    const jpegQuality = cfg.get<number>("jpegQuality") ?? 60;
    cdpSession = await CdpSession.connect(
      target.webSocketDebuggerUrl!,
      toPositiveInt(fps, 4),
      toPositiveInt(jpegQuality, 60),
      (frameData) => {
        void panel?.webview.postMessage({ type: "frame", data: frameData });
      },
      (reason) => {
        if (silentCloseReason && reason === silentCloseReason) {
          silentCloseReason = undefined;
          return;
        }
        if (panel) {
          logLine("WARN", reason);
          diagnosticOutput?.show(true);
        }
      }
    );
  } catch {
    cdpSession = undefined;
    logLine("ERROR", "连接 CDP 会话失败");
    diagnosticOutput?.show(true);
    return;
  }
  await minimizeBrowserWindowsIfEnabled();
  startMinimizePulse();
  await cdpSession.minimizeWindowByCdp();
  void panel?.webview.postMessage({ type: "setUrl", url: target.url || "" });
  await syncTabList(host, port, target.id);
  await syncBookmarks();
  saveLastProjection(host, port, target);
  startAutoFollowNewestTab(context);
}

async function switchProjectionTab(context: vscode.ExtensionContext): Promise<void> {
  const rt = projectionRuntime;
  if (!rt) {
    return;
  }
  const targets = await getCdpTargets(rt.host, rt.port);
  if (!targets) {
    logLine("WARN", "无法获取标签列表");
    return;
  }
  const pages = targets.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl);
  const picked = await pickPageTarget(pages, "切换到其他标签页");
  if (!picked) {
    return;
  }
  await attachProjectionTarget(context, rt.host, rt.port, picked);
}

async function createAndAttachNewTab(context: vscode.ExtensionContext, preferredUrl?: string): Promise<void> {
  const rt = projectionRuntime;
  if (!rt) {
    return;
  }
  const url =
    normalizeUrl(preferredUrl || "") ||
    normalizeUrl(vscode.workspace.getConfiguration("moyu.cdp").get<string>("defaultUrl") || "https://www.bing.com") ||
    "https://www.bing.com";
  const logs: string[] = [];
  const stamp = () => new Date().toISOString();
  const log = (line: string) => logs.push(`[${stamp()}] ${line}`);
  log(`createAndAttachNewTab start host=${rt.host} port=${rt.port} url=${url}`);
  try {
    const endpoint = `http://${rt.host}:${rt.port}/json/new?${encodeURIComponent(url)}`;
    // Newer Chromium may require PUT for /json/new; older builds accept GET.
    log(`try HTTP PUT ${endpoint}`);
    let resp = await fetch(endpoint, { method: "PUT" });
    log(`PUT /json/new status=${resp.status}`);
    if (!resp.ok) {
      log(`try HTTP GET ${endpoint}`);
      resp = await fetch(endpoint, { method: "GET" });
      log(`GET /json/new status=${resp.status}`);
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const target = (await resp.json()) as CdpTarget;
    log(`HTTP /json/new success targetId=${target.id || "(none)"}`);
    if (!target.webSocketDebuggerUrl) {
      log("HTTP /json/new missing webSocketDebuggerUrl");
      throw new Error("missing ws url");
    }
    log("attachProjectionTarget via /json/new");
    await attachProjectionTarget(context, rt.host, rt.port, target);
    return;
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}${e.stack ? ` | ${e.stack.split("\n")[0]}` : ""}` : String(e);
    log(`HTTP /json/new path failed: ${msg}`);
    // Fallback to browser-level CDP target creation.
  }

  try {
    log("fallback Target.createTarget begin");
    const newTargetId = await createTargetViaBrowserWs(rt.host, rt.port, url, log);
    if (!newTargetId) {
      log("Target.createTarget returned empty targetId");
      throw new Error("no target id");
    }
    log(`Target.createTarget success targetId=${newTargetId}`);
    for (let i = 0; i < 10; i++) {
      const targets = await getCdpTargets(rt.host, rt.port);
      const target = targets?.find((t) => t.id === newTargetId && !!t.webSocketDebuggerUrl);
      if (target) {
        log(`target found in /json/list on retry=${i}`);
        await attachProjectionTarget(context, rt.host, rt.port, target);
        return;
      }
      log(`target not yet visible in /json/list retry=${i}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    log("target not found in /json/list after retries");
    throw new Error("target not found in list");
  } catch (e) {
    log(`Target.createTarget path failed: ${e instanceof Error ? e.message : String(e)}`);
    // Third fallback: if already attached to one tab, try creating via current page context.
    try {
      if (cdpSession) {
        const before = await getCdpTargets(rt.host, rt.port);
        const beforeIds = new Set((before || []).map((t) => t.id));
        log(`fallback current-session window.open begin, beforeCount=${before?.length || 0}`);
        await cdpSession.openWindow(url);
        for (let i = 0; i < 12; i++) {
          const targets = await getCdpTargets(rt.host, rt.port);
          const created = targets?.find((t) => !beforeIds.has(t.id) && t.type === "page" && !!t.webSocketDebuggerUrl);
          if (created) {
            log(`window.open created target found retry=${i} id=${created.id}`);
            await attachProjectionTarget(context, rt.host, rt.port, created);
            return;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        log("window.open did not create detectable new target");
        // Try Target.createTarget on current session as secondary in-session path.
        const fromCurrent = await cdpSession.createTarget(url);
        log(`current-session Target.createTarget result=${fromCurrent || "(empty)"}`);
        if (fromCurrent) {
          for (let i = 0; i < 10; i++) {
            const targets = await getCdpTargets(rt.host, rt.port);
            const target = targets?.find((t) => t.id === fromCurrent && !!t.webSocketDebuggerUrl);
            if (target) {
              log(`current-session target found in /json/list retry=${i}`);
              await attachProjectionTarget(context, rt.host, rt.port, target);
              return;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
    } catch (e2) {
      log(`current-session fallback failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }

    // Fourth fallback: do not fail hard, reuse an existing page target and navigate it.
    try {
      const pages = (await getCdpTargets(rt.host, rt.port))?.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl);
      if (pages && pages.length > 0) {
        const fallback = pages[0];
        log(`reuse existing target fallback id=${fallback.id} title=${fallback.title || "(none)"}`);
        await attachProjectionTarget(context, rt.host, rt.port, fallback);
        await cdpSession?.navigate(url);
        void panel?.webview.postMessage({ type: "setUrl", url });
        return;
      }
      log("reuse existing target fallback found no page targets");
    } catch (e3) {
      log(`reuse existing target fallback failed: ${e3 instanceof Error ? e3.message : String(e3)}`);
    }

    // Final fallback: if the current projection session is alive, reuse it directly.
    try {
      if (cdpSession) {
        log("final fallback: navigate in current active session");
        await cdpSession.navigate(url);
        void panel?.webview.postMessage({ type: "setUrl", url });
        logLine("WARN", "当前环境不支持新建标签，已在当前标签打开网址");
        return;
      }
      log("final fallback unavailable: no active cdpSession");
    } catch (e4) {
      log(`final fallback failed: ${e4 instanceof Error ? e4.message : String(e4)}`);
    }

    // Prefer managed-launch first to avoid popping a visible default-browser window.
    try {
      log("managed-launch fallback begin");
      const launched = await launchManagedBrowserWindowsIfEnabled(rt.host, rt.port, url, log);
      if (launched) {
        await minimizeBrowserWindowsIfEnabled(log);
        startMinimizePulse(log);
        for (let i = 0; i < 25; i++) {
          const targets = await getCdpTargets(rt.host, rt.port);
          const newest =
            targets
              ?.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl)
              .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
          if (newest) {
            log(`managed-launch attach success retry=${i} id=${newest.id}`);
            await attachProjectionTarget(context, rt.host, rt.port, newest);
            await cdpSession?.navigate(url);
            void panel?.webview.postMessage({ type: "setUrl", url });
            return;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        log("managed-launch polling ended without target");
      }
    } catch (e6) {
      log(`managed-launch fallback failed: ${e6 instanceof Error ? e6.message : String(e6)}`);
    }

    // Last-resort: open in system browser and try to auto-attach soon after.
    try {
      const allowOpenExternal =
        vscode.workspace.getConfiguration("moyu.cdp").get<boolean>("allowOpenExternalFallback") === true;
      if (!allowOpenExternal) {
        log("openExternal fallback skipped by config");
        throw new Error("openExternal disabled");
      }
      log("last-resort: openExternal + auto-attach polling");
      await vscode.env.openExternal(vscode.Uri.parse(url));
      await minimizeBrowserWindowsIfEnabled(log);
      startMinimizePulse(log);
      for (let i = 0; i < 15; i++) {
        const targets = await getCdpTargets(rt.host, rt.port);
        const newest =
          targets
            ?.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl)
            .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
        if (newest) {
          log(`openExternal auto-attach success retry=${i} id=${newest.id}`);
          await attachProjectionTarget(context, rt.host, rt.port, newest);
          await cdpSession?.navigate(url);
          void panel?.webview.postMessage({ type: "setUrl", url });
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      log("openExternal auto-attach polling ended without target");
    } catch (e5) {
      log(`last-resort openExternal failed: ${e5 instanceof Error ? e5.message : String(e5)}`);
    }

    const detail = ["创建新标签页失败诊断", `host=${rt.host}`, `port=${rt.port}`, `url=${url}`, ...logs].join("\n");
    diagnosticOutput?.appendLine(detail);
    diagnosticOutput?.show(true);
    await vscode.env.clipboard.writeText(detail);
    logLine("ERROR", "创建新标签页失败，诊断信息已写入输出窗口并复制到剪贴板");
  }
}

async function runQuickStart(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("moyu.cdp");
  const host = cfg.get<string>("host") || "127.0.0.1";
  const port = cfg.get<number>("port") ?? 9222;
  projectionRuntime = { host, port, target: { id: "", type: "page", title: "", url: "" } };
  await createAndAttachNewTab(context);
}

function pushTypography(webview: vscode.Webview): void {
  const t = getEditorTypography();
  webview.postMessage({
    type: "typography",
    family: t.family,
    size: t.size,
    weight: t.weight,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;
  diagnosticOutput = vscode.window.createOutputChannel("moyu-browser");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
  statusItem.text = "fish";
  statusItem.tooltip = "fish quick start";
  statusItem.command = "moyu.quickStart";
  statusItem.show();

  context.subscriptions.push(statusItem);
  context.subscriptions.push(diagnosticOutput);

  context.subscriptions.push(
    vscode.commands.registerCommand("moyu.connectBrowserProjection", async () => {
      await connectCdpProjection(context);
    }),
    vscode.commands.registerCommand("moyu.quickStart", async () => {
      await runQuickStart(context);
    }),
    vscode.commands.registerCommand("moyu.bossKey", async () => {
      await runBossKey();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!panel) {
        return;
      }
      if (e.affectsConfiguration("editor.fontFamily") || e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.fontWeight")) {
        pushTypography(panel.webview);
      }
    })
  );
}

export function deactivate(): void {
  void cleanupProjectionResources("扩展停用");
  panel?.dispose();
  panel = undefined;
  statusItem?.dispose();
  statusItem = undefined;
  diagnosticOutput?.dispose();
  diagnosticOutput = undefined;
}
