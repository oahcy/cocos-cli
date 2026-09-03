# Simulator 对 Pink 的接口设计（cocos-cli 侧）

只覆盖 cocos-cli 需要做的改动。Pink 侧的 `cocosHostSimulator` channel 由 Pink 负责，
本文档只在「为什么 cocos-cli 要长这样」的地方引用它的行为。

**设计原则：接口与 editor 保持一致。** 下面每条改动都标注了 editor 的出处；
刻意超出 editor 的部分单列在第 6 节，并给出理由。

## 1. editor 侧的接口是什么样的

来源 `~/code/editor/app/builtin/preview/`：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `source/browser/simulator.ts` | 308 | `runSimulator` / `writeSettingFile` / `generateBundleIndex` |
| `source/browser/simulator-utils.ts` | 92 | 路径、偏好设置、`generateSimulatorConfig` |
| `source/browser/build-simulator-engine-ts.ts` | 140 | `buildSimulatorEngineTS` |
| `source/browser/index.ts` | 231 | `methods` —— 对外的 message 表 |
| `source/panel/debugger.ts` | 81 | 调试面板（分辨率 + 屏幕方向两个下拉） |

**对外只有四个动作**（`package.json` 的 `messages` 声明 + `index.ts` 的 `methods`）：

| editor message | 实现 | 说明 |
| --- | --- | --- |
| `open-terminal`（`currMode === 'simulator'`） | `runSimulator(onCompleted?)` | 唯一的启动入口 |
| `restart-simulator` | `runSimulator()` | 就是再调一次，没有别的逻辑 |
| `build-simulator-engine-ts` | `buildSimulatorEngineTS()` | 构建 native 引擎 TS 产物 |
| `write-setting-file` | `writeSettingFile(dstDir)` | 写 settings / bundle 索引 |

**没有的东西**（这三条是本次对比最重要的发现）：

- **没有 stop。** `runSimulator` 第一句就是 `stopSimulatorProcess()`（`simulator.ts:100`），
  「启动」的语义本身就是先停后起。调试面板里也确实没有停止按钮，只有分辨率和朝向两个下拉，
  改任何一个都是 `Editor.Message.send('preview', 'restart-simulator')`（`debugger.ts:45` / `53`）。
- **没有 session id、没有状态查询。** 模块级一个 `let simulatorProcess: ChildProcess | null`
  （`simulator.ts:19`），单实例。
- **没有退出清理。** `unload()` 只调 `browserPreviewManager.destroyed()`（`index.ts:228`），
  不碰 simulator 进程。

editor 的三个信号消费点（都是进程内直接监听，因为同进程）：

```ts
// simulator.ts:292-307
simulatorProcess.on('close', () => { Editor.Panel.close('preview.debugger'); });
simulatorProcess.stdout?.on('data', data => {
    if (firstMetrics && onCompleted) { firstMetrics = false; onCompleted(); }   // 「起来了」
    console.log(data.toString ? data.toString() : data);
});
simulatorProcess.stderr?.on('data', data => { console.error(...); });
simulatorProcess.on('error', data => { console.error(...); });
```

构建侧只广播开始 / 结束两个点，**没有逐行进度**（`index.ts:36-48`）：

```ts
Editor.Message.broadcast('programming:compile-start', 'nativeEngine');
buildSimulatorEngineTS().then(() => {
    Editor.Message.broadcast('programming:compiled', 'nativeEngine');
    ...
});
```

## 2. Pink 侧的约束

以下全部是从装机版 **PinK 1.127.0**（`/Applications/PinK.app`）读出来的实测事实。
相关文件：`out/vs/platform/cocos/node/cocosHost.pink.js`、`out/main.js`。

Pink 为每个工程拉起一个 utility process 跑 `cocosHost.pink.js`，按固定顺序加载
`<cocos-path>/dist/lib/<module>/<module>.js`，每个 facade 注册成一个 IPC channel
（现有九个：`cocosHostAssets` / `Builder` / `Configuration` / `Engine` / `Mcp` /
`Project` / `Scene` / `Scripting` / `Server`）。

| # | 约束 | 依据 |
| --- | --- | --- |
| C1 | 入参与返回值只能是 JSON 值（`undefined` / `Buffer` 也支持），不能有函数、class 实例、`Map` / `Set` / `Date` | IPC 序列化器只有 `Undefined \| String \| Buffer \| VSBuffer \| Array \| Object \| Uint` 七种 tag |
| C2 | 事件只能写成 `onXxx(listener): () => void` 导出 | Pink wrapper 在 `init` 里订阅并 `sendEvent(name, payload)` 转发，见 `configuration.onDidSave` / `assets.onReady` |
| C3 | 导出 `init` 会被自动调用 | 基类 `init(cocosPath, ...args)` 里 `typeof mod.init === 'function' && await mod.init(...args)` |
| C4 | **每一个导出函数都自动是公开 API** | `handle` 是无白名单的通用转发 |
| C5 | 单次调用没有时长上限 | `timeoutDelay`（默认 1000ms）只管「channel 未注册时的 pending request」 |

C1 直接决定了 editor 的 `runSimulator(onCompleted)` 那种回调参数**不能照搬**——
函数过不了序列化。这是唯一一处必须改形态的地方，改法见 3.3。

C4 是最需要注意的一条：facade 的导出列表**就是**协议，接入之后再删就是跨仓库 break。
所以**冻结点在 Pink 接入之前**。

## 3. 按 editor 对齐

`src/lib/simulator/simulator.ts` 已有 16 个方法，形式上已满足 C1/C3/C4，
Pink 加个 channel 就能调 `launchPreview`。要改的是**语义**和**信号**。

### 3.1 方法映射

| editor | cocos-cli | 处理 |
| --- | --- | --- |
| `open-terminal`（simulator 分支）/ `restart-simulator` | `launchPreview(options?)` | 改成先停后起，见 3.2 |
| `build-simulator-engine-ts` | `buildRuntime(enginePath?)` | 不变 |
| `write-setting-file` | `prepareResources(options?)` | 不变（cocos-cli 的是超集） |
| —— | `buildNative` / `build` / `isBuilt` / 四个路径 getter | editor 无对应；构建 native 可执行文件在 editor 里是独立于 preview 包的流程 |

**名字不跟 editor 逐字一致**是刻意的：在 `Simulator` 命名空间下
`Simulator.buildSimulatorEngineTS()` 是重复表述，而 `buildRuntime` 已经写进
`packages/cocos-cli-types/index.d.ts` 和四个测试 suite。这张映射表就是给对照用的。
如果希望逐字对齐，改名的成本也就是这一张表加一次 `generate:dts`。

### 3.2 `launchPreview` 改成先停后起（单实例）

editor 的 `runSimulator` 第一句是 `stopSimulatorProcess()`。cocos-cli 现在每次
`start()` 都 `randomUUID()` 开新 session，连点两次会得到两个窗口。改成对齐 editor：

```ts
export async function launchPreview(
    options?: ISimulatorLaunchPreviewOptions,
): Promise<ISimulatorLaunchPreviewResult>;   // 进入时先停掉现有会话
```

一次改动解决三件事：

1. 行为与 editor 一致，用户不会拿到两个窗口；
2. **`restart(id)` 可以删掉**——editor 的「重启」就是再调一次 `runSimulator`，
   Pink 改分辨率 / 朝向也应该是这么做（对应 `debugger.ts:45` / `53`）；
3. 天然消掉并发问题，不需要额外的 in-flight guard。

底层 `start()` 保留多实例能力（`_sessions` Map 不动），只是 `launchPreview` 这个
Pink 实际用的入口收敛成单实例。

`build` / `buildNative` / `buildRuntime` / `prepareResources` 仍需要 in-flight promise
去重——它们写同一个输出目录，并行跑结果不确定。先例：`lib/mcp` 的
`registeringPromise ??= doRegisterMcp()`。

### 3.3 事件：三个，对应 editor 的三个消费点

C2 要求 `onXxx(listener) => dispose`，C1 禁掉了 editor 的回调参数写法。

```ts
/** 对应 editor 的 simulatorProcess.on('close') + onCompleted 回调 */
export function onDidChangeSession(
    listener: (session: ISimulatorSessionInfo) => void,
): () => void;

/** 对应 editor 的 stdout/stderr → console.log/console.error */
export function onLog(
    listener: (entry: {
        source: 'simulator' | 'build';
        level: 'log' | 'error';
        message: string;
    }) => void,
): () => void;

/** 对应 editor 的 broadcast('programming:compile-start'/'compiled', 'nativeEngine') */
export function onDidChangeBuildState(
    listener: (state: {
        step: 'native' | 'runtime';
        state: 'start' | 'success' | 'failed';
        error?: string;
    }) => void,
): () => void;
```

`onDidChangeSession` 在 start 成功、首个 stdout（editor 的 `onCompleted` 时机）、
`exit`、`error`、`stop` 五处 fire，payload 直接是 `{ ...info }`，已是纯数据。
**不拆成 `onDidStart` / `onDidExit`**：C2 下每个事件都要 Pink 单独订阅 + 转发 + 声明 dts，
事件数就是对接成本，而 `status` / `exitCode` / `signal` 已经够区分正常退出和崩溃。

`onDidChangeBuildState` 只给 start / success / failed 三态，**不给百分比、不给逐行**——
对齐 editor 的两点广播。逐行输出走 `onLog`，Pink 那边进 log 面板就行。

### 3.4 把 stdout/stderr 接出来（上一版漏掉的真缺口）

editor 是 piped + `console.log`；cocos-cli 是 `stdio: 'ignore'`
（`src/core/simulator/index.ts:497`），**simulator 的原生 console 输出全部丢掉**——
JS 报错、`cc.log`、native 侧的日志一个都收不到。对 Pink 来说这是主要调试通道，
比 editor 更重要（editor 至少还能看主进程终端）。

两个 build 用的是 `stdio: 'inherit'`（`index.ts:288` / `308`），会直接流到 cocosHost 的
stdout 再进 Pink 的 log；改成 pipe 之后这条路会断，所以每行除了 fire `onLog`
还要 `console.log` 一次，保持 CLI 直跑和 Pink log 两条路都不变。

```
simulator 进程：stdio: 'ignore'      → ['ignore', 'pipe', 'pipe']
build 子进程：  stdio: 'inherit'     → ['ignore', 'pipe', 'pipe'] + 逐行 console.log
```

### 3.5 用 `treeKill` 停进程

editor 用 `treeKill(simulatorProcess.pid)`（`simulator.ts:5` / `23`）；
cocos-cli 的 `stop()` 用裸 `process.kill(pid, 'SIGTERM')`。`tree-kill` 已经在
`package.json` 里，全仓库一处未用——直接换上，
顺便覆盖 simulator 可能拉起子进程的情况。

注意它原本在 **devDependencies**，而 `workflow/release.js:478` 发布时跑
`npm install --production`。现在运行时代码要 `require` 它，所以实现时把它挪进了
`dependencies`，否则发布出去的包一加载 simulator 模块就 MODULE_NOT_FOUND。

### 3.6 冻结前的清理

- 删 `isAvailable`：`isBuilt` 的纯别名。全仓库只有两处定义、零个调用方
  （`core/simulator/index.ts:260` 的 manager 方法 + `lib/simulator/simulator.ts:42` 的转发）。
- 删 `restart`：见 3.2，editor 的重启就是再调 `launchPreview`。
- 删 `ISimulatorStartOptions.projectDir`（`internal.ts:108`）/
  `ISimulatorSessionInfo.projectDir`（`internal.ts:136`）：deprecated 别名，
  注释理由是「等 Pink 迁移」，而 Pink 尚未接入。连带四处：`resolveRuntimeRoot`
  （`internal.ts:288` 的 `?? options.projectDir`）、`ISimulatorLaunchPreviewOptions` 的
  `Omit<..., 'projectDir'>`（`internal.ts:142`）、两处 session 构造
  （`index.ts:511` / `541`），以及 `tests/simulator-internal.test.ts:153` 那个用例。
- `getManifest` / `getExecutablePath` / `getResourcesPath` / `getWritablePath` 保留：
  纯推导、无副作用、对排障有用，Pink 可以不用。

### 3.7 `init(projectPath)`

```ts
export async function init(projectPath: string): Promise<void>;
```

C3 决定了这是免费的：Pink 的初始化表拿到 `(cocosPath, projectPath, locale, ...)`，
基类自动转给 `mod.init`。存下 projectPath 作为默认值，Pink 侧就只需要
`launchPreview({ startScene })`。与 `base.init(projectPath)` / `Project.init(projectPath)` 一致。

`enginePath` **不需要** Pink 传：`resolveEnginePath()` 兜底到
`GlobalPaths.enginePath = <cocos-cli 根>/packages/engine`（`src/global.ts:10`），
而 cocos-cli 根正是 Pink 的 `--cocos-path`。所有 `enginePath?` 入参保持可选即可。

## 4. 最终 facade 形态

`src/lib/simulator/simulator.ts` 的完整导出（C4：这份清单就是协议）。

| 分类 | 签名 | 状态 | editor 对应 |
| --- | --- | --- | --- |
| 生命周期 | `init(projectPath): Promise<void>` | **新增** | —— |
| 构建 | `build(enginePath?): Promise<void>` | 加去重 | —— |
| | `buildNative(enginePath?): Promise<void>` | 加去重 + 事件 | —— |
| | `buildRuntime(enginePath?): Promise<void>` | 加去重 + 事件 | `build-simulator-engine-ts` |
| | `isBuilt(enginePath?): Promise<boolean>` | 不变 | —— |
| 路径 | `getManifest(enginePath?)` | 不变 | —— |
| | `getExecutablePath(enginePath?)` | 不变 | —— |
| | `getResourcesPath(enginePath?)` | 不变 | —— |
| | `getWritablePath(enginePath?)` | 不变 | —— |
| 运行 | `prepareResources(options?)` | 加去重 | `write-setting-file` |
| | `launchPreview(options?)` | **改为先停后起** | `open-terminal` / `restart-simulator` |
| | `start(options)` | 不变（底层多实例） | —— |
| | `stop(id): Promise<boolean>` | 改用 `treeKill` | editor 无（内部 `stopSimulatorProcess`） |
| | `stopAll(): Promise<number>` | **新增** | editor 无，见第 6 节 |
| | `getStatus(id)` | 不变 | —— |
| | `listSessions()` | 不变 | —— |
| 事件 | `onDidChangeSession(listener)` | **新增** | `on('close')` + `onCompleted` |
| | `onLog(listener)` | **新增** | stdout/stderr → console |
| | `onDidChangeBuildState(listener)` | **新增** | `compile-start` / `compiled` 广播 |
| 删除 | ~~`isAvailable`~~ ~~`restart`~~ | **删** | —— |

净变化：**+5 −2 函数** → 19 个函数。

类型：8 个现有（去掉 `projectDir` 字段）继续从 `core/simulator` re-export，
**新增 2 个具名 interface** `ISimulatorLogEntry` / `ISimulatorBuildState`（共 10 个）。
实现时改了主意：原计划用内联字面量，但 C4 下事件 payload 也是冻结的协议，
具名 interface 才能在 Pink 的 `_cli.*` dts 里被引用、被逐字段 review。

已确认全部 JSON-safe（C1）：`previewSceneJson?: string | Record<string, unknown>`、
`env?: Record<string, string | undefined>`、`position?: { x, y }` 都是纯数据。

## 5. 类型交付

`workflow/generate-dts.ts` 的 `entries` 加一条（与其余 8 条同构）：

```ts
{
    name: 'simulator',
    source: 'src/lib/simulator/simulator.ts',
    output: 'simulator.d.ts'
}
```

跑 `npm run generate:dts` 产出 `packages/cocos-cli-types/simulator.d.ts`，
Pink 的 `build/lib/pink-dts-generator.ts` 才能 inline 成 `declare module 'pink'` 里的
`_cli.ISimulator*`。`index.d.ts` 里的 `export declare namespace Simulator` 已经正确。

## 6. 刻意超出 editor 的部分

只有两处，都给出理由。

### 6.1 `stopAll()` + 退出兜底

editor 完全没有清理：`unload()` 只 `browserPreviewManager.destroyed()`。
但**宿主生命周期不同**——Pink 的 cocosHost 是按工程拉起的 utility process，
关工程 / 切工程就被 `process.kill()`，频率远高于 editor 退出。
子进程没有 `detached`、cocos-cli 里也没有任何 `process.on('exit')` 清理，
POSIX 下父进程被杀不会连带杀子进程 → simulator 窗口留着、5086 调试端口被占。

所以两条都要：

- `stopAll()` 给 Pink 在关工程时主动调，能优雅 SIGTERM 并拿到结果；
- `process.on('exit')` 里做**同步** best-effort 清理（回调不能 await，
  只能遍历 `process.kill(pid, 'SIGKILL')`），兜住 Pink 直接 kill 掉 cocosHost 的路径——
  那种情况下 facade 根本没机会被调用。

这不是理论风险：本次移植期间反复遇到残留 `SimulatorApp-Mac` 占住 5086 端口污染 CDP 探测，
就是这个失效模式。

### 6.2 `config.json` 双写

editor 的 `generateSimulatorConfig` 只往 writable path 写一份
（`simulator-utils.ts:78-92`），但同时又给 native 传 `-writable-path simulatorResources`
（`simulator.ts:281`，Windows 上等于 `Release/`）—— 两处指向的目录在 Windows 上不是同一个，
配置可能根本没生效。cocos-cli 往 runtimeRoot 和 writablePath 各写一份（macOS 上 resolve
相同会自动去重），是刻意的加固，已有单测覆盖，不改回去。

这条属于实现细节而非接口，列在这里只是说明「与 editor 不同」是知情的选择。

## 7. 明确不做

| 不做 | 理由 |
| --- | --- |
| CLI 子命令（`cocos simulator ...`） | Pink 走 IPC channel，不经过 `src/cli.ts` |
| MCP tool（`src/api/**` 的 `@tool`） | 那套是给 AI agent 的，与 Pink UI 无关 |
| HTTP 路由 | `lib/server` 的 middleware 服务的是预览资源，不是控制面 |
| `checkBuildState()`（可诊断的构建状态） | 上一版提过：把 `listRequiredSimulatorArtifacts` 的结果变成 `{built, missing, hint}`。editor 无对应物，纯增量，**移出首批**；`isBuilt` 够用，等 Pink 反馈「用户看不懂缺什么」再加 |
| 多实例默认隔离 | `runtimeRoot` 入参已在，缺的是默认策略；editor 也是单实例，不阻塞冻结 |
| build 的取消 | 需要先有取消语义（杀 build 子进程后产物是半成品，下次得能识别）。editor 也没有 |
| `pause` / `step` / `reload` | editor 有 `pause-terminal` / `step-terminal` / `reload-terminal`，但都是转发给 `scene` 包的 `editor-preview-call-method`，不属于 simulator 接口；cocos-cli 侧对应的是 `lib/scene`，另议 |

## 8. 验收

1. **单测**
   - `onDidChangeSession` 在 start / 首个 stdout / exit / error / stop 五条路径都 fire，
     payload 状态正确；
   - `onLog` 能同时收到 simulator 与 build 两个 source；
   - `onDidChangeBuildState` 的 failed 分支带 `error`；
   - `launchPreview` 连调两次只留一个 running 会话（对齐 editor 的先停后起）；
   - 并发调 `build` 只跑一次子进程；
   - `stopAll` 返回数正确。
2. **冻结检查**：断言 `lib/simulator` 的导出名集合等于第 4 节那张表。
   C4 下多导一个辅助函数就是多一条要维护的公开 API。
3. **类型**：`npm run generate:dts` 后 `packages/cocos-cli-types/simulator.d.ts` 存在且含 19 个函数；
   `dist/lib/simulator/simulator.js` 可被 `import('file://...')` 加载（与 Pink 的加载方式一致）。
4. **孤儿验证**：`launchPreview` 后 `kill -9` 宿主 node 进程，确认 `SimulatorApp-Mac`
   随之退出、5086 端口释放。
5. **日志验证**：`launchPreview` 后确认 `onLog` 能收到 simulator 的启动输出——
   这是 `stdio: 'ignore'` 改 pipe 之后唯一能证明改对了的方式。

## 9. Pink 侧接入参考

给接入的人看的简版，机制全文见第 2 节。cocos-cli 侧不用再动，Pink 侧在
`cocosHost.pink.js` 里改两处即可。

**① 在模块描述表 `Qs` 里加一条**（照 `configuration` 的样子）：

```js
class SimulatorHost extends HostBase {
    constructor() { super("cocosHostSimulator", "simulator"); }
    async init(e, ...t) {
        await super.init(e, ...t);
        this.module.onDidChangeSession(s => this.sendEvent("onDidChangeSession", s));
        this.module.onLog(l => this.sendEvent("onLog", l));
        this.module.onDidChangeBuildState(b => this.sendEvent("onDidChangeBuildState", b));
    }
}
// Qs 里追加：
{ name: "simulator", load: (n, e) => (async () => {
    const t = new SimulatorHost; await t.init(n, e); t.register();
})() },
```

**② 就这些。** 剩下的全是基类能力，不需要为 simulator 单独写：

- **模块加载**：`js(n, e) = join(n, "dist", "lib", e, e + ".js")` →
  `<cocos-path>/dist/lib/simulator/simulator.js`，`import("file://...")`。
- **`init` 自动调用**：基类 `init` 里 `typeof mod.init === "function" && await mod.init(...args)`，
  `load` 里传 `(n, e)` → `mod.init(projectPath)`。enginePath 不用传，内部兜底到
  `--cocos-path` 下的 `packages/engine`。
- **19 个函数自动转发**：基类 `handle(method, args)` 对每个不在白名单里的方法都
  `await mod[method](...args)`，所以 `launchPreview` / `build` / `stop` / `stopAll` /
  `prepareResources` 等全部直接可 RPC 调用，无需逐条声明。
- **事件回流**：上面 `init` 里的三行桥接 → `sendEvent(name, payload)` →
  MessagePort → 主进程 → 渲染层订阅者。事件名就是
  `onDidChangeSession` / `onLog` / `onDidChangeBuildState` 三个。

接入后 `cocosHostSimulator` 成为第十个 channel（现有九个业务 channel + 内置 `ping`）。

**两点提醒**：

- 第 4 节的 19 个函数名 + 3 个事件名 + `ISimulator*` 类型就是协议，Pink 接入后
  再删/改就是跨仓库 break（C4）。接入前请过一遍第 4 节那张表，确认没有想再加/改的。
- 关工程 / 切工程时调一次 `stopAll()`；宿主被杀走 `process.on('exit')` 的 SIGKILL
  兜底，见 6.1。

### 9.1 Pink 侧要实现的接口清单（对照 editor）

给 UI 接线的人：editor 有哪些动作/信号，Pink 就照着调 facade 的哪几个。方法级映射见
3.1，这里按「UI 动作」和「信号消费」两个视角列。

**动作（Pink UI → facade 调用）**

| editor 动作 | Pink 侧调用 |
| --- | --- |
| `open-terminal`（simulator 分支） | `launchPreview(options)` —— 启动入口 |
| `restart-simulator` | 再调一次 `launchPreview(options)`（先停后起，见 3.2） |
| `build-simulator-engine-ts` | `buildRuntime()`（只 runtime）或 `build()`（native + runtime） |
| `write-setting-file` | `prepareResources(options)` —— 一般不用单独调，`launchPreview` 内部已做 |
| debugger 面板：分辨率下拉 | `launchPreview({ resolution: { width, height } })` |
| debugger 面板：朝向下拉 | `launchPreview({ landscape })` |

**信号（editor 消费点 → Pink 订阅事件）**

| editor 信号消费点 | Pink 侧订阅 | 用途 |
| --- | --- | --- |
| `simulatorProcess.on('close')` + `runSimulator(onCompleted)` | `onDidChangeSession(listener)` | 用 `status` / `readyAt` / `exitCode` 区分「起来了 / 退了 / 崩了」 |
| stdout/stderr → `console.log/error` | `onLog(listener)` | simulator 的 JS 报错、`cc.log`、构建逐行输出 |
| `broadcast('programming:compile-start' / 'compiled')` | `onDidChangeBuildState(listener)` | 构建开始 / 成功 / 失败三点 |

**editor 有、Pink 不用实现的**

| 项 | 说明 |
| --- | --- |
| stop 按钮 | editor 没有（`runSimulator` 内部先停后起），Pink 也不需要有；`stopAll()` 只在关/切工程时调 |
| 退出清理 | editor 没做；Pink 的 utility process 会被 `process.kill()`，靠 cocos-cli 侧 `process.on('exit')` SIGKILL 兜底（6.1） |
| 单独调 `write-setting-file` | `launchPreview` 已全包，Pink 一般用不到 |
