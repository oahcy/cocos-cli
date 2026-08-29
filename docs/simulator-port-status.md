# Cocos CLI Simulator 移植进展简述

## 工作目的

本次工作的目标是：

**把 editor 现有的 simulator 预览能力移植到 Pink + cocos-cli 体系里。**

当前分工上：

- `cocos-cli` 负责提供 simulator 的构建、资源准备、启动能力
- Pink 作为最终使用方，后续通过调用 `cocos-cli` 提供的接口来使用 simulator

当前阶段主要完成的是 **cocos-cli 侧能力落地和链路打通**，Pink 侧集成还没有做。

## 目前做了什么

这次主要把 Cocos Creator 现有 simulator 预览链路移了一部分到 `cocos-cli`，当前已经做到：

- 可以在 `cocos-cli` 内构建 simulator native 可执行程序
- 可以构建 simulator 运行时 TS 产物
- 可以准备 simulator 所需 `Resources`
- 可以从 `cocos-cli` 直接启动 preview server + 启动 simulator
- 已经在项目 `~/project/steamTestCase` 上验证可以进入场景并稳定出帧
- 有 110 个单测覆盖构建产物一致性、Windows 路径逻辑和 `prepareResources` 端到端产物

已接入的构建入口：

- `npm run build:simulator:native`
- `npm run build:simulator:runtime`
- `npm run build:simulator`
- `npm run build` 已带上 simulator
- `workflow/release.js` 也接了 simulator build

主要实现文件：

| 文件 | 职责 |
| --- | --- |
| `src/core/simulator/index.ts` | 编排：preview server、build、`prepareResources`、进程启停 |
| `src/core/simulator/internal.ts` | 纯逻辑：平台产物表、路径推导、CLI 参数、`config.json`、preload 资源裁剪 |
| `src/core/simulator/runtime-writer.ts` | 往 runtime 目录写产物：settings / bundle 索引 / `cc/env` / 模板渲染 / 产物校验 |
| `static/simulator/main.ejs` | simulator bootstrap（与 editor 逐字节对齐） |
| `workflow/build-simulator-runtime.js` | 引擎 runtime 产物 + `static/simulator/import-map.json` |
| `workflow/build-simulator.js` | native 可执行程序 |
| `src/lib/simulator/simulator.ts` | 对外命令层 |

`internal.ts` / `runtime-writer.ts` 是从 `index.ts` 里拆出来的（1033 行 → 465 行）。拆分动机是可测：这两个文件不依赖 builder / asset-db / preview server，可以在单测里直接对着临时目录跑。对外接口没有变化，八个 interface 仍从 `index.ts` 重新导出。

## 参考了哪些实现

主要参考来源：

- editor
  - `/Users/cocos/code/editor/app/builtin/preview/source/browser/simulator.ts`
  - `/Users/cocos/code/editor/app/builtin/preview/source/browser/build-simulator-engine-ts.ts`
  - `/Users/cocos/code/editor/app/builtin/preview/static/simulator/main.ejs`
  - `/Users/cocos/code/editor/app/builtin/preview/source/programming/Facet.ts`
- cocos-cli
  - `src/core/preview/scripting-routes.ts`
  - `src/core/scripting/programming/Facet.ts`
- engine
  - `/Users/cocos/code/cocos-engine/cocos/game/game.ts`
  - `/Users/cocos/code/cocos-engine/cocos/core/settings.ts`
  - `/Users/cocos/code/cocos-engine/bin/adapter/native/engine-adapter.js`

## 这次解决过的关键问题

已经排查并修掉过这些问题：

- `cc.PhysicMaterial` 反序列化失败

  最早是在 `main.ejs` 里 eager import `physics-framework` 规避的，但那只是掩盖症状。

  真正的根因在 `resolvePreviewData`：preview 模式下 builder 走的是 `queryAllPreloadAssetList`，
  会把**引擎全部 feature** 的 `dependentAssets` 都塞进 `settings.engine.builtinAssets`，
  其中包含内置物理材质 `ba21476f-2866-4f81-9c4d-6e359316e448`。jsb 版 `builtinResMgr`
  在 game init 阶段会无条件预加载这份清单，而该资源序列化时用的是旧类名 `cc.PhysicMaterial`，
  这个别名只在 `cocos/physics/framework/deprecated.ts` 里注册 —— 项目没开物理模块时别名不存在，
  于是反序列化直接抛错。

  修法是按项目实际启用的 feature 裁剪 `builtinAssets`（`collectPreloadAssets` 复刻了
  builder 的 `traversalDependencies` + `queryPreloadAssetList`）。修完之后 `main.ejs` 里的
  eager import 就可以删掉，也就不再需要为了一个资源把整个物理模块拖进 bootstrap。

- `exports is not defined`  
  根因是 simulator 不能直接吃 quick-pack 的 `cce:/internal/x/cc` 映射。

- `Unresolved id: base`  
  根因是 simulator 自己生成的 `cc.js` 使用 bare feature unit import，但 import-map 不完整。

- `gfx-webgpu.js did not instantiate`  
  根因是 `cc.js` 生成时把没真正 build 出来的 feature unit 也带进去了。

  后两条的最终解法是**不再生成 `cc.js`**，见下一节。

## bootstrap / import-map 已对齐 editor

之前 simulator bootstrap 靠几处补丁才能跑，现在都拆掉了：

| 之前的补丁 | 现在 |
| --- | --- |
| 项目 import-map 用 `/scripting/x/pack-import-map-url` | 用 `/scripting/x/import-map.json`（保留 `cce:/internal/x/cc` 的原样版本） |
| `main.ejs` 手动注入 `cce:/internal/x/cc -> ./src/cocos-js/cc.js` | 删掉，`cce:/internal/x/cc` 由 quick-pack import-map 提供 |
| `main.ejs` 手动 eager import `physics-framework` | 删掉（根因见上一节） |
| `buildImportMap` 额外产出 `base` / `2d` / `gfx-webgl` 等 bare alias | 删掉，只保留 `cce:/internal/x/cc-fu/*` 和 `cc/env` |
| `resolveBuiltRuntimeFeatureUnits` 按实际产物过滤 feature | 整个函数删掉 |

`main.ejs` 现在与 editor 原样一致，本地 import-map 只剩两条 alias（`cc` 和 `cc/userland/macro`）。

由此 feature 一致性变成天然成立的：

- **配置 feature** → 项目 `settings.engine.engineModules`
- **实际产物** → `workflow/build-simulator-runtime.js` 按同一份 feature 产出 `src/cocos-js/*.js`，
  并写出对应的 `static/simulator/import-map.json`
- **bootstrap feature** → `cc` 索引来自 preview server 的 quick-pack（与项目配置同源），
  它 import 的 feature unit 再由 import-map 指到本地产物

不再有第二份 `cc.js` 参与其中，所以也不再需要"按产物兜底筛 feature"。运行时可以直接验：

```
System.resolve("cc")                                    // → .../scripting/x/chunks/93/93ba….js
System.resolve("cce:/internal/x/cc")                    // → 同一个 chunk
System.resolve("cce:/internal/x/cc-fu/physics-framework") // → no-schema:/src/cocos-js/physics-framework.js
```

## Windows 适配

Windows 与 macOS 的差异集中在两处，都已按 native 侧实现对齐：

- **runtime 根目录**：macOS 是 app bundle 的 `Contents/Resources`；Windows 上
  `SimulatorApp-Win32.exe` 与资源同级，根目录就是 `Release/` 本身。
- **writable path**：`FileUtilsWin32::getWritablePath()` 返回
  `%LOCALAPPDATA%/<exe 名>/`，`FileServer` 再追加 `debugruntime/`，即
  `%LOCALAPPDATA%/SimulatorApp-Win32/debugruntime`。它**不等于** runtime 根目录，
  而 native 的 `ConfigParser::readConfig()` 会优先从 writable path 读 `config.json`，
  所以 `prepareResources` 现在往两个目录各写一份（macOS 上两者 resolve 相同，会自动去重）。

另外 `-search-path` 在所有平台都用 `;` 拼接 —— native 的 `ProjectConfig::parseCommandLine`
一律按 `;` 切分，不能用 `path.delimiter`。

为了让这些 win32 分支在 macOS 上也能测，宿主环境（`platform` + `LOCALAPPDATA`）改成显式注入
（`ISimulatorHostEnv`），默认取 `process`。

## 自动化测试

`npx jest tests/simulator-` —— 110 个用例，四个 suite：

| 文件 | 覆盖 |
| --- | --- |
| `tests/simulator-internal.test.ts`（48） | 平台产物表、路径推导、`getSimulatorWritablePath` 的 win32 分支、`resolvePrepareTargets` 的默认/覆盖行为、`createArgs` 全部参数格式、`config.json` 双写/去重、`collectPreloadAssets` 与真实 `cc.config.json` 的 preload 裁剪 |
| `tests/simulator-build-artifacts.test.ts`（22） | `workflow/build-simulator.js` 与 `internal.ts` 的产物表逐字段一致；`import-map.json` 与 `buildImportMap()` 往返一致、不含 bare alias / `cc` / `cce:/internal/x/cc`；`main.ejs` 的 bootstrap 约定（无 eager import、`cce:/internal/x/` 只出现一次） |
| `tests/simulator-runtime-writer.test.ts`（23） | settings / bundle 索引 / `cc/env` 产物、模板渲染（无残留 `<%`、能过 `new Function`、Windows 路径转正斜杠）、产物缺失时的报错信息 |
| `tests/simulator-prepare-resources.test.ts`（17） | `prepareResources()` 端到端：产物落点、`builtinAssets` 裁剪、bundle 清理与远端前缀剥离、引擎产物拷贝、`main.js` / `application.js` / `config.json` 内容、幂等性 |

`prepareResources` 的端到端测试靠 `runtimeRoot` 入参把产物写进临时目录（见下节），
只 mock 掉需要真实项目 / preview server 的三个依赖（builder、asset-db、includeModules 校验），
其余全走真实实现 —— native 可执行文件和引擎产物是真的，所以 `getExecutablePath` 和
`assertRequiredSimulatorArtifacts` 这两道校验依然有效。

这些测试的定位是**锁死"两个地方必须说同一件事"的关系**：产物表、import-map、`main.ejs` 约定，
任何一边被单独改动都会红。

## `runtimeRoot` / `writablePath` 覆盖入参

`ISimulatorPrepareOptions` 新增两个可选入参，**默认行为完全不变（不做隔离）**：

| 入参 | 不传时 | 传了之后 |
| --- | --- | --- |
| `runtimeRoot` | simulator 自己的资源目录（macOS 的 `Contents/Resources`、Windows 的 `Release/`） | 只往这个目录写，不碰 app bundle |
| `writablePath` | 未覆盖 `runtimeRoot` → 平台真实 writable path；已覆盖 → 跟随 `runtimeRoot` | 作为 `config.json` 的第二个写入目录（对应 native 的 `-writable-path`），相对路径按 `runtimeRoot` 解析 |

推导集中在 `resolvePrepareTargets()`。`writablePath` 跟随 `runtimeRoot` 是刻意的：覆盖 runtimeRoot
的意图就是别碰真实产物目录，否则 Windows 上 `config.json` 还是会写进 `%LOCALAPPDATA%`。

native 可执行文件仍然从 `enginePath` 下的 Release 目录取，不受这两个入参影响。

`launchPreview` 也接受这两个入参（`ISimulatorLaunchPreviewOptions` 继承自
`ISimulatorPrepareOptions`），并会把 `prepared.runtimeRoot` / `prepared.writablePath`
透传给 `start()` 的 `-workdir` / `-writable-path`，所以指定后整条链路是自洽的。

当前引入它主要是为了让 `prepareResources` 可测；真正的多实例隔离（默认就把不同项目分到不同目录）
还没做，见下一节。

## 当前还有哪些问题

- runtime 目录默认还是直接写 simulator app 自己的 `Contents/Resources`。
  - 单项目单实例可用
  - 多项目/多实例会互相覆盖
  - `prepareResources` 已经支持 `runtimeRoot` 覆盖入参，隔离所需的接口已经在了，
    但还没有"默认按项目分目录"的策略，也没做 runtime 产物在多目录间的复用

- Windows 逻辑已按 native 实现对齐并有单测覆盖，但**没有实机验证**。
  - 需要在 Windows 上跑一次 `npm run build:simulator` + `launchPreview`

- Pink 侧集成还没开始。

## 目前怎么测试

统一使用 Node `22.17.0`。

### 1. 编译 TS

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
./node_modules/.bin/tsc -b
```

### 2. 跑 simulator 单测

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
npx jest tests/simulator-
```

不需要启动 simulator 窗口，也不会碰 app bundle 里的 runtime 目录
（`prepareResources` 的端到端用例走 `runtimeRoot` 入参写临时目录）。
`assertRequiredSimulatorArtifacts` 那条用例会对着本地引擎产物断言，如果它红了说明本地没跑过
`npm run build:simulator`。

### 3. 只重建 simulator runtime

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
node workflow/build-simulator-runtime.js --enginePath=/Users/cocos/code/cocos-cli/packages/engine
```

### 4. 构建 simulator 全量产物

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
npm run build:simulator
```

### 5. 直接启动 simulator 预览

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
node - <<'NODE'
const { simulatorManager } = require('/Users/cocos/code/cocos-cli/dist/core/simulator');
(async()=>{
  const result = await simulatorManager.launchPreview({
    projectPath:'/Users/cocos/project/steamTestCase',
    startScene:'db://assets/scene.scene',
    port: 7509,
    showConsole:false,
  });
  console.log(JSON.stringify(result, null, 2));
  setInterval(() => {}, 1000);
})().catch((e)=>{console.error(e); process.exit(1);});
NODE
```

验证标准：

- preview server 正常起来
- simulator 窗口出现
- 能进入 `db://assets/scene.scene`
- 不是黑屏

更细的回归项（用下面「调试」一节的 CDP 脚本查）：

| 表达式 | 期望 |
| --- | --- |
| `cc.game._inited` | `true` |
| `cc.director.getScene().name` | `"scene"` |
| `cc.director.getScene().children.map(c=>c.name).join(",")` | `"Canvas,PROFILER_NODE"` |
| `System.resolve("cc")` | 指向 `/scripting/x/chunks/...`（不是本地 `cc.js`） |
| `System.resolve("cce:/internal/x/cc")` | 与上一条同一个 chunk |
| `System.resolve("cce:/internal/x/cc-fu/physics-framework")` | `no-schema:/src/cocos-js/physics-framework.js` |
| `cc.director.getTotalFrames()` | 隔一会儿再查要有增长 |

以及不应出现 `cc.PhysicMaterial` / `exports is not defined` / `Unresolved id: base`。

注意 `waitForConnect: true` 会让 simulator 停在 `main.js` 的 `debugger` 上等调试器 resume，
窗口表现就是「卡死」，那是预期行为，不是 bug。

## 目前怎么调试

### 1. 查 preview server import-map

```bash
curl -s http://localhost:7509/scripting/x/import-map.json
```

这是 simulator bootstrap 实际用的那份（保留 `cce:/internal/x/cc`）。
浏览器预览用的是 `/scripting/x/pack-import-map-url` 变体，会把 cc 索引删掉交给浏览器 bundle —— 
simulator **不要**用它。

### 2. 查 resolution map

```bash
curl -s http://localhost:7509/scripting/x/resolution-detail-map.json
```

### 3. 看当前是否有残留 simulator 进程

```bash
ps -Ao pid,command | rg "SimulatorApp-Mac|launchPreview|steamTestCase"
```

### 4. 杀掉旧 simulator

```bash
kill -9 <pid>
```

### 5. 查 simulator debug 端口

```bash
curl -s http://127.0.0.1:5086/json/list
```

### 6. 用调试脚本探测 runtime 状态

检查 `cc` 是否 resolve：

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
node - <<'NODE'
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:5086/00010002-0003-4004-8005-000600070008');
let id = 1;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function call(method, params = {}) {
  return new Promise((resolve) => {
    const currentId = id++;
    pending.set(currentId, resolve);
    ws.send(JSON.stringify({ id: currentId, method, params }));
  });
}
(async () => {
  await new Promise((resolve) => ws.once('open', resolve));
  await call('Runtime.enable');
  const exprs = [
    'typeof cc',
    'cc.game && cc.game._inited',
    'System.resolve("cc")',
    'Promise.race([System.import("cc").then(() => "cc-resolved", (e) => "cc-rejected:" + e.message), new Promise((r)=>setTimeout(()=>r("cc-timeout"),1000))])',
  ];
  for (const expression of exprs) {
    const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify({ expression, result: out.result?.result }, null, 2));
  }
  ws.close();
})().catch((e)=>{console.error(e); process.exit(1);});
NODE
```

检查 `fsUtils` 是否存在：

```bash
cd /Users/cocos/code/cocos-cli
source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null
node - <<'NODE'
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:5086/00010002-0003-4004-8005-000600070008');
let id = 1;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function call(method, params = {}) {
  return new Promise((resolve) => {
    const currentId = id++;
    pending.set(currentId, resolve);
    ws.send(JSON.stringify({ id: currentId, method, params }));
  });
}
(async () => {
  await new Promise((resolve) => ws.once('open', resolve));
  await call('Runtime.enable');
  const exprs = [
    'typeof fsUtils',
    'typeof require',
    '(() => { try { require("jsb-adapter/engine-adapter.js"); return typeof fsUtils; } catch (e) { return "require-failed:" + e.message; } })()',
  ];
  for (const expression of exprs) {
    const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify({ expression, result: out.result?.result }, null, 2));
  }
  ws.close();
})().catch((e)=>{console.error(e); process.exit(1);});
NODE
```

## 当前结论

目前可以认为：

- 这次工作的目的，是把 editor 的 simulator 功能迁到 Pink + cocos-cli 体系里。
- 当前已经完成了 `cocos-cli` 侧构建、资源准备、启动和进入场景这条链路。
- bootstrap / import-map 已与 editor 对齐，之前的四处兼容补丁全部拆除；
  配置 feature → 实际产物 → bootstrap feature 现在是天然一致的，不再靠兜底筛选。
- Windows 的路径 / writable path / `config.json` 双写逻辑已按 native 实现对齐，并有单测覆盖。
- 有了 110 个单测锁住产物表、import-map、`main.ejs` 约定这几处易漂移的一致性关系，
  `prepareResources` 也能借 `runtimeRoot` 入参端到端跑而不污染真实产物目录。
- 剩下的主要缺口是 **runtime 目录默认多实例隔离** 和 **Windows 实机验证**，以及 Pink 侧集成。
- 所以当前更适合定义为：**cocos-cli 侧已跑通、mac 上已回归的可用版本**，还不是最终稳定版。
