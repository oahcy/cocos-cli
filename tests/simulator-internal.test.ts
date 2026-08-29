/**
 * Simulator 纯逻辑单元测试。
 *
 * 重点是 Windows 分支：`getSimulatorWritablePath` / `createArgs` 在 macOS 上跑 CI 也能
 * 覆盖 win32 行为，靠的是把宿主环境（platform + LOCALAPPDATA）显式注入。
 */

import { mkdtemp, readFile, readJSON, remove } from 'fs-extra';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';

import {
    collectPreloadAssets,
    createArgs,
    createSimulatorConfig,
    currentHostEnv,
    formatPath,
    getHostManifest,
    getSimulatorDir,
    getSimulatorResourcesPath,
    getSimulatorRoot,
    getSimulatorWritablePath,
    isReadyServerURL,
    markSessionStopped,
    normalizeServerURL,
    parsePreviewServer,
    resolveOptionPath,
    resolvePreloadAssetList,
    resolvePrepareTargets,
    resolveRuntimeRoot,
    writeSimulatorConfig,
    type ISimulatorHostEnv,
    type ISimulatorSessionInfo,
} from '../src/core/simulator/internal';

const MAC: ISimulatorHostEnv = { platform: 'darwin' };
const WIN: ISimulatorHostEnv = { platform: 'win32', localAppData: 'C:\\Users\\tester\\AppData\\Local' };
const WIN_NO_APPDATA: ISimulatorHostEnv = { platform: 'win32' };
const LINUX: ISimulatorHostEnv = { platform: 'linux' };

const ENGINE = resolve('/tmp/fake-engine');

/** 断言时统一分隔符，这样 win32 分支在 posix 宿主上也能写出可读的期望值。 */
function slashes(pathValue: string): string {
    return pathValue.split(sep).join('/').replace(/\\/g, '/');
}

describe('host manifest', () => {
    it('describes the mac app bundle', () => {
        expect(getHostManifest(MAC)).toEqual({
            platform: 'darwin',
            bundle: 'SimulatorApp-Mac.app',
            entry: 'SimulatorApp-Mac.app/Contents/MacOS/SimulatorApp-Mac',
        });
    });

    it('describes the win32 executable', () => {
        expect(getHostManifest(WIN)).toEqual({
            platform: 'win32',
            bundle: 'SimulatorApp-Win32.exe',
            entry: 'SimulatorApp-Win32.exe',
        });
    });

    it('returns null on unsupported hosts', () => {
        expect(getHostManifest(LINUX)).toBeNull();
    });

    it('reflects the real process by default', () => {
        expect(currentHostEnv().platform).toBe(process.platform);
    });
});

describe('simulator paths', () => {
    it('puts the release dir under native/simulator/Release', () => {
        expect(slashes(getSimulatorDir(ENGINE))).toBe(`${slashes(ENGINE)}/native/simulator/Release`);
    });

    it('resolves the mac runtime root inside Contents/Resources', () => {
        expect(slashes(getSimulatorRoot(ENGINE, MAC)))
            .toBe(`${slashes(ENGINE)}/native/simulator/Release/SimulatorApp-Mac.app`);
        expect(slashes(getSimulatorResourcesPath(ENGINE, MAC)))
            .toBe(`${slashes(ENGINE)}/native/simulator/Release/SimulatorApp-Mac.app/Contents/Resources`);
    });

    it('resolves the win32 runtime root to the release dir itself', () => {
        // Windows 上没有 app bundle，`SimulatorApp-Win32.exe` 和资源同级。
        expect(slashes(getSimulatorRoot(ENGINE, WIN)))
            .toBe(`${slashes(ENGINE)}/native/simulator/Release`);
        expect(slashes(getSimulatorResourcesPath(ENGINE, WIN)))
            .toBe(`${slashes(ENGINE)}/native/simulator/Release`);
    });

    it('throws on unsupported hosts', () => {
        expect(() => getSimulatorRoot(ENGINE, LINUX)).toThrow(/not supported on host platform: linux/);
    });
});

describe('getSimulatorWritablePath', () => {
    it('equals the runtime root on macOS', () => {
        // native 的 FileUtils::getWritablePath() 在 macOS 上返回 app bundle 的 Contents/Resources。
        expect(getSimulatorWritablePath(ENGINE, MAC)).toBe(getSimulatorResourcesPath(ENGINE, MAC));
    });

    it('matches %LOCALAPPDATA%/<exe name>/debugruntime on Windows', () => {
        // 对应 FileUtils-win32.cpp getWritablePath() + FileServer::init 追加的 debugruntime/。
        expect(slashes(getSimulatorWritablePath(ENGINE, WIN)))
            .toBe('C:/Users/tester/AppData/Local/SimulatorApp-Win32/debugruntime');
    });

    it('is not the runtime root on Windows', () => {
        // 这条不成立的话 prepareResources 的 config.json / gamecaches 双写逻辑就没意义了。
        expect(getSimulatorWritablePath(ENGINE, WIN)).not.toBe(getSimulatorResourcesPath(ENGINE, WIN));
    });

    it('falls back to the runtime root when LOCALAPPDATA is missing', () => {
        expect(getSimulatorWritablePath(ENGINE, WIN_NO_APPDATA))
            .toBe(getSimulatorResourcesPath(ENGINE, WIN_NO_APPDATA));
    });
});

describe('server url helpers', () => {
    it('strips trailing slashes', () => {
        expect(normalizeServerURL('http://localhost:7456///')).toBe('http://localhost:7456');
        expect(normalizeServerURL('http://localhost:7456')).toBe('http://localhost:7456');
    });

    it('only accepts http(s) urls as ready', () => {
        expect(isReadyServerURL('http://127.0.0.1:7456')).toBe(true);
        expect(isReadyServerURL('https://example.com')).toBe(true);
        expect(isReadyServerURL('ws://127.0.0.1:7456')).toBe(false);
        expect(isReadyServerURL('')).toBe(false);
        expect(isReadyServerURL(undefined)).toBe(false);
        expect(isReadyServerURL(null)).toBe(false);
    });

    it('splits host and port, defaulting by protocol', () => {
        expect(parsePreviewServer('http://127.0.0.1:7509')).toEqual({ previewIp: '127.0.0.1', previewPort: 7509 });
        expect(parsePreviewServer('http://localhost')).toEqual({ previewIp: 'localhost', previewPort: 80 });
        expect(parsePreviewServer('https://example.com')).toEqual({ previewIp: 'example.com', previewPort: 443 });
    });
});

describe('formatPath', () => {
    it('turns windows separators into forward slashes', () => {
        // 生成的 main.js / application.js 把路径当 JS 字符串字面量插值，`\` 会被吃掉。
        expect(formatPath('C:\\projects\\demo\\library')).toBe('C:/projects/demo/library');
        expect(formatPath('/Users/tester/demo/library')).toBe('/Users/tester/demo/library');
    });
});

describe('resolveRuntimeRoot / resolveOptionPath', () => {
    it('prefers runtimeRoot over the deprecated projectDir alias', () => {
        expect(resolveRuntimeRoot({ runtimeRoot: '/a/b', projectDir: '/c/d' }, MAC)).toBe(resolve('/a/b'));
        expect(resolveRuntimeRoot({ projectDir: '/c/d' }, MAC)).toBe(resolve('/c/d'));
    });

    it('falls back to the simulator resources path', () => {
        expect(resolveRuntimeRoot({ enginePath: ENGINE }, MAC)).toBe(getSimulatorResourcesPath(ENGINE, MAC));
    });

    it('keeps absolute option paths and resolves relative ones against the runtime root', () => {
        const root = resolve('/runtime/root');
        expect(resolveOptionPath(root, 'main.js')).toBe(join(root, 'main.js'));
        expect(resolveOptionPath(root, resolve('/elsewhere/main.js'))).toBe(resolve('/elsewhere/main.js'));
    });
});

describe('resolvePrepareTargets', () => {
    it('defaults to the simulator resources path — no isolation', () => {
        // 不传 runtimeRoot 时行为必须与加这个入参之前完全一致。
        expect(resolvePrepareTargets({ enginePath: ENGINE }, MAC)).toEqual({
            runtimeRoot: getSimulatorResourcesPath(ENGINE, MAC),
            writablePath: getSimulatorWritablePath(ENGINE, MAC),
        });
        expect(resolvePrepareTargets({ enginePath: ENGINE }, WIN)).toEqual({
            runtimeRoot: getSimulatorResourcesPath(ENGINE, WIN),
            writablePath: getSimulatorWritablePath(ENGINE, WIN),
        });
    });

    it('redirects both targets when runtimeRoot is overridden', () => {
        // 覆盖 runtimeRoot 的意图就是别碰真实产物目录，所以 writable path 必须跟着走，
        // 否则 Windows 上 config.json 还会写进 %LOCALAPPDATA%。
        const sandbox = resolve('/tmp/sandbox/Resources');
        for (const host of [MAC, WIN]) {
            expect(resolvePrepareTargets({ enginePath: ENGINE, runtimeRoot: sandbox }, host)).toEqual({
                runtimeRoot: sandbox,
                writablePath: sandbox,
            });
        }
    });

    it('honours an explicit writablePath, absolute or runtimeRoot-relative', () => {
        const sandbox = resolve('/tmp/sandbox/Resources');
        expect(resolvePrepareTargets({ runtimeRoot: sandbox, writablePath: 'gamecaches' }, MAC).writablePath)
            .toBe(join(sandbox, 'gamecaches'));
        expect(resolvePrepareTargets({ runtimeRoot: sandbox, writablePath: resolve('/tmp/elsewhere') }, MAC).writablePath)
            .toBe(resolve('/tmp/elsewhere'));
        // 只给 writablePath、不覆盖 runtimeRoot 也应该生效（相对路径按真实产物目录解析）。
        expect(resolvePrepareTargets({ enginePath: ENGINE, writablePath: 'gamecaches' }, WIN).writablePath)
            .toBe(join(getSimulatorResourcesPath(ENGINE, WIN), 'gamecaches'));
    });

    it('normalizes a relative runtimeRoot', () => {
        expect(resolvePrepareTargets({ runtimeRoot: 'build/sim' }, MAC).runtimeRoot).toBe(resolve('build/sim'));
    });
});

describe('createArgs', () => {
    const runtimeRoot = resolve('/runtime/root');

    function argValue(args: string[], flag: string): string | undefined {
        const index = args.indexOf(flag);
        return index < 0 ? undefined : args[index + 1];
    }

    it('always starts with -workdir', () => {
        const args = createArgs({ runtimeRoot }, MAC);
        expect(args[0]).toBe('-workdir');
        expect(args[1]).toBe(runtimeRoot);
    });

    it('resolves -entry against the runtime root', () => {
        const args = createArgs({ runtimeRoot, entryFile: 'main.js' }, MAC);
        expect(argValue(args, '-entry')).toBe(join(runtimeRoot, 'main.js'));
    });

    it('defaults -writable-path to the platform writable path', () => {
        expect(argValue(createArgs({ runtimeRoot, enginePath: ENGINE }, MAC), '-writable-path'))
            .toBe(getSimulatorWritablePath(ENGINE, MAC));
        expect(argValue(createArgs({ runtimeRoot, enginePath: ENGINE }, WIN), '-writable-path'))
            .toBe(getSimulatorWritablePath(ENGINE, WIN));
    });

    it('honours an explicit writablePath', () => {
        expect(argValue(createArgs({ runtimeRoot, writablePath: 'gamecaches' }, MAC), '-writable-path'))
            .toBe(join(runtimeRoot, 'gamecaches'));
    });

    it('joins search paths with ";" on every host', () => {
        // native 的 ProjectConfig::parseCommandLine 一律用 `;` 切分，不能用 path.delimiter。
        const expected = [join(runtimeRoot, 'a'), join(runtimeRoot, 'b')].join(';');
        expect(argValue(createArgs({ runtimeRoot, searchPaths: ['a', 'b'] }, MAC), '-search-path')).toBe(expected);
        expect(argValue(createArgs({ runtimeRoot, searchPaths: ['a', 'b'] }, WIN), '-search-path')).toBe(expected);
    });

    it('omits -search-path when there is nothing to add', () => {
        expect(createArgs({ runtimeRoot, searchPaths: [] }, MAC)).not.toContain('-search-path');
        expect(createArgs({ runtimeRoot }, MAC)).not.toContain('-search-path');
    });

    it('formats resolution, scale and position the way native expects', () => {
        const args = createArgs({
            runtimeRoot,
            resolution: { width: 1280, height: 720 },
            scale: 0.5,
            position: { x: 10, y: -20 },
        }, MAC);
        expect(argValue(args, '-resolution')).toBe('1280x720');
        expect(argValue(args, '-scale')).toBe('0.5');
        expect(argValue(args, '-position')).toBe('10,-20');
    });

    it('passes -console as an explicit boolean string', () => {
        expect(argValue(createArgs({ runtimeRoot, showConsole: true }, MAC), '-console')).toBe('true');
        expect(argValue(createArgs({ runtimeRoot, showConsole: false }, MAC), '-console')).toBe('false');
        expect(createArgs({ runtimeRoot }, MAC)).not.toContain('-console');
    });

    it('adds orientation flags without values', () => {
        expect(createArgs({ runtimeRoot, landscape: true }, MAC)).toContain('-landscape');
        expect(createArgs({ runtimeRoot, portrait: true }, MAC)).toContain('-portrait');
        expect(createArgs({ runtimeRoot }, MAC)).not.toContain('-landscape');
    });

    it('resolves -write-debug-log and passes -listen through', () => {
        const args = createArgs({ runtimeRoot, debugLogFile: 'sim.log', bindAddress: '0.0.0.0' }, MAC);
        expect(argValue(args, '-write-debug-log')).toBe(join(runtimeRoot, 'sim.log'));
        expect(argValue(args, '-listen')).toBe('0.0.0.0');
    });
});

describe('createSimulatorConfig', () => {
    it('defaults to 960x640 portrait without waiting for a debugger', () => {
        expect(createSimulatorConfig({})).toEqual({
            name: 'Simulator',
            entry: 'main.js',
            isLandscape: false,
            isWindowTop: false,
            waitForConnect: false,
            width: 960,
            height: 640,
            consolePort: 6050,
            uploadPort: 6060,
            debugPort: 5086,
        });
    });

    it('carries resolution, landscape and waitForConnect through', () => {
        expect(createSimulatorConfig({
            resolution: { width: 1334, height: 750 },
            landscape: true,
            waitForConnect: true,
        })).toMatchObject({
            width: 1334,
            height: 750,
            isLandscape: true,
            waitForConnect: true,
        });
    });

    it('keeps the entry aligned with the generated main.js', () => {
        expect(createSimulatorConfig({}).entry).toBe('main.js');
    });
});

describe('writeSimulatorConfig', () => {
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'cocos-simulator-config-'));
    });

    afterEach(async () => {
        await remove(tempDir);
    });

    it('writes an identical config.json to every target dir', async () => {
        const runtimeRoot = join(tempDir, 'runtime');
        const writablePath = join(tempDir, 'debugruntime');
        const paths = await writeSimulatorConfig([runtimeRoot, writablePath], { landscape: true });

        expect(paths).toEqual([join(runtimeRoot, 'config.json'), join(writablePath, 'config.json')]);
        const [first, second] = await Promise.all(paths.map((p) => readFile(p, 'utf8')));
        expect(first).toBe(second);
        await expect(readJSON(paths[0])).resolves.toMatchObject({ isLandscape: true, entry: 'main.js' });
    });

    it('dedupes targets that resolve to the same dir (the macOS case)', async () => {
        const runtimeRoot = join(tempDir, 'runtime');
        const paths = await writeSimulatorConfig([runtimeRoot, join(runtimeRoot, 'nested', '..')], {});
        expect(paths).toEqual([join(runtimeRoot, 'config.json')]);
    });

    it('ignores empty target dirs', async () => {
        const runtimeRoot = join(tempDir, 'runtime');
        const paths = await writeSimulatorConfig([runtimeRoot, ''], {});
        expect(paths).toEqual([join(runtimeRoot, 'config.json')]);
    });

    it('creates missing directories and ends the file with a newline', async () => {
        const deep = join(tempDir, 'a', 'b', 'c');
        const [configPath] = await writeSimulatorConfig([deep], {});
        expect(await readFile(configPath, 'utf8')).toMatch(/\n$/);
    });
});

describe('collectPreloadAssets', () => {
    const features = {
        base: { dependentAssets: ['asset-base'] },
        '2d': { dependentAssets: ['asset-2d'], dependentModules: ['base'] },
        'physics-framework': {
            dependentAssets: ['default-physics-material'],
            dependentScripts: ['script-physics'],
        },
        'physics-ammo': { dependentModules: ['physics-framework'] },
        cyclic: { dependentAssets: ['asset-cyclic'], dependentModules: ['cyclic', 'base'] },
    };

    it('collects assets and scripts of the requested features', () => {
        expect(collectPreloadAssets(features, ['physics-framework']))
            .toEqual(['default-physics-material', 'script-physics']);
    });

    it('follows dependentModules transitively', () => {
        expect(collectPreloadAssets(features, ['physics-ammo']))
            .toEqual(['default-physics-material', 'script-physics']);
        expect(collectPreloadAssets(features, ['2d'])).toEqual(['asset-2d', 'asset-base']);
    });

    it('excludes features that are not enabled', () => {
        // 这正是 cc.PhysicMaterial 反序列化崩溃的修复点：没开 physics-framework 时
        // default-physics-material 不能进 builtinResMgr 的预加载列表。
        expect(collectPreloadAssets(features, ['base'])).not.toContain('default-physics-material');
    });

    it('dedupes and tolerates cycles and unknown features', () => {
        expect(collectPreloadAssets(features, ['base', 'base', '2d'])).toEqual(['asset-base', 'asset-2d']);
        expect(collectPreloadAssets(features, ['cyclic'])).toEqual(['asset-cyclic', 'asset-base']);
        expect(collectPreloadAssets(features, ['nope'])).toEqual([]);
        expect(collectPreloadAssets({}, ['base'])).toEqual([]);
    });
});

describe('resolvePreloadAssetList', () => {
    const enginePath = resolve(__dirname, '..', 'packages', 'engine');

    it('reads cc.config.json and keeps physics assets scoped to physics features', async () => {
        // 内置物理材质 default-physics-material 挂在各物理后端 feature 的 dependentAssets 下，
        // 它反序列化时用旧类名 cc.PhysicMaterial，别名只在 physics-framework 注册。
        const physicsMaterial = 'ba21476f-2866-4f81-9c4d-6e359316e448';
        const withPhysics = await resolvePreloadAssetList(enginePath, ['physics-ammo']);
        const withoutPhysics = await resolvePreloadAssetList(enginePath, ['base']);
        expect(withPhysics).toContain(physicsMaterial);
        expect(withoutPhysics).not.toContain(physicsMaterial);
    });

    it('matches the builder queryPreloadAssetList behaviour for the full feature set', async () => {
        const ccConfigJson = await readJSON(join(enginePath, 'cc.config.json')) as { features: Record<string, unknown> };
        const all = await resolvePreloadAssetList(enginePath, Object.keys(ccConfigJson.features));
        const subset = await resolvePreloadAssetList(enginePath, ['base', '2d']);
        expect(all.length).toBeGreaterThan(subset.length);
        for (const uuid of subset) {
            expect(all).toContain(uuid);
        }
    });

    it('returns a deduped list', async () => {
        const list = await resolvePreloadAssetList(enginePath, ['base', 'base', '2d']);
        expect(new Set(list).size).toBe(list.length);
    });
});

describe('markSessionStopped', () => {
    it('records the exit code, signal and timestamp', () => {
        const info = { status: 'running' } as ISimulatorSessionInfo;
        markSessionStopped(info, 0, null);
        expect(info.status).toBe('stopped');
        expect(info.exitCode).toBe(0);
        expect(info.signal).toBeNull();
        expect(typeof info.exitedAt).toBe('string');
    });
});
