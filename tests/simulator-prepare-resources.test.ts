/**
 * `prepareResources()` 的端到端测试。
 *
 * 靠 `ISimulatorPrepareOptions.runtimeRoot` 把产物写到临时目录，所以不会覆盖
 * `SimulatorApp-Mac.app/Contents/Resources` 里开发者当前准备好的 runtime。
 *
 * 只 mock 掉「需要真实项目 / preview server」的三个依赖（builder、asset-db、
 * include-modules 校验），其余全部走真实实现 —— native 可执行文件和引擎产物也是真的，
 * 所以 `getExecutablePath` / `assertRequiredSimulatorArtifacts` 这两道校验依然有效。
 */

import { mkdtemp, pathExists, readFile, readJSON, remove } from 'fs-extra';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const enginePath = resolve(__dirname, '..', 'packages', 'engine');

/** `cc.config.json` 里挂在 physics 后端下的内置物理材质，项目没开物理时必须被裁掉。 */
const PHYSICS_MATERIAL_UUID = 'ba21476f-2866-4f81-9c4d-6e359316e448';
/** 分别挂在 `base` / `2d` 下的真实内置资源，必须被保留。 */
const BASE_ASSET_UUID = '970b0598-bcb0-4714-91fb-2e81440dccd8';
const SPRITE_ASSET_UUID = '60f7195c-ec2a-45eb-ba94-8955f60e81d0';

/** 项目实际启用的模块，不含任何物理后端。 */
const INCLUDE_MODULES = ['base', '2d', 'ui', 'gfx-webgl2'];

const mockGetPreviewSettings = jest.fn();
const mockQueryDefaultBuildConfigByPlatform = jest.fn();
const mockQueryAssetInfos = jest.fn();
const mockGetEffectBinPath = jest.fn();

jest.mock('../src/core/builder', () => ({
    getPreviewSettings: (...args: unknown[]) => mockGetPreviewSettings(...args),
    queryDefaultBuildConfigByPlatform: (...args: unknown[]) => mockQueryDefaultBuildConfigByPlatform(...args),
}));

jest.mock('../src/core/builder/share/common-options-validator', () => ({
    fillIncludeModulesFromProjectConfig: (options: Record<string, unknown>) => {
        options.includeModules = [...INCLUDE_MODULES];
    },
}));

jest.mock('../src/core/assets', () => ({
    assetDBManager: {},
    assetManager: {
        queryAssetInfos: (...args: unknown[]) => mockQueryAssetInfos(...args),
        getEffectBinPath: (...args: unknown[]) => mockGetEffectBinPath(...args),
    },
}));

import { simulatorManager, type ISimulatorPreparedResources } from '../src/core/simulator';

/**
 * 模拟 `builder.getPreviewSettings` 的返回。`builtinAssets` 刻意按预览构建的真实行为
 * 写成「全部 feature 的 dependentAssets」，好验证 prepareResources 的裁剪。
 */
function previewSettings(bundleNames = ['main']): Record<string, unknown> {
    return {
        settings: {
            engine: {
                engineModules: [...INCLUDE_MODULES],
                builtinAssets: [BASE_ASSET_UUID, PHYSICS_MATERIAL_UUID, SPRITE_ASSET_UUID],
            },
            assets: { projectBundles: ['resources'] },
            screen: { designResolution: { width: 1280, height: 720, policy: 4 } },
            splashScreen: { totalTime: 3000 },
            launch: { launchScene: 'scene-uuid' },
        },
        bundleConfigs: bundleNames.map((name) => ({
            name,
            importBase: 'http://127.0.0.1:7509/import',
            nativeBase: 'http://127.0.0.1:7509/native',
            uuids: [],
        })),
    };
}

let tempDir = '';
let runtimeRoot = '';
let projectPath = '';

beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cocos-simulator-prepare-'));
    runtimeRoot = join(tempDir, 'Resources');
    projectPath = join(tempDir, 'project');

    mockQueryDefaultBuildConfigByPlatform.mockResolvedValue({
        platform: 'windows',
        includeModules: [],
    });
    mockQueryAssetInfos.mockReturnValue([
        { url: 'db://assets/scene.scene', uuid: 'scene-uuid' },
    ]);
    mockGetEffectBinPath.mockResolvedValue('');
    mockGetPreviewSettings.mockResolvedValue(previewSettings());
});

afterEach(async () => {
    jest.clearAllMocks();
    await remove(tempDir);
});

async function prepare(
    overrides: Parameters<typeof simulatorManager.prepareResources>[0] = {},
): Promise<ISimulatorPreparedResources> {
    return await simulatorManager.prepareResources({
        enginePath,
        runtimeRoot,
        projectPath,
        serverURL: 'http://127.0.0.1:7509',
        startScene: 'scene-uuid',
        previewSceneJson: { __type__: 'cc.SceneAsset' },
        ...overrides,
    });
}

describe('prepareResources runtimeRoot override', () => {
    it('writes everything under the given runtimeRoot and nothing into the app bundle', async () => {
        const prepared = await prepare();

        expect(prepared.runtimeRoot).toBe(runtimeRoot);
        // 默认（不传 writablePath）时跟随 runtimeRoot，不去写 %LOCALAPPDATA% / app bundle。
        expect(prepared.writablePath).toBe(runtimeRoot);
        for (const filePath of [
            prepared.mainScriptPath,
            prepared.applicationScriptPath,
            prepared.settingsPath,
            prepared.previewSceneJsonPath,
            prepared.configPath,
        ]) {
            expect(filePath.startsWith(runtimeRoot)).toBe(true);
            expect(await pathExists(filePath)).toBe(true);
        }
        expect(prepared.configPaths).toEqual([prepared.configPath]);
    });

    it('still resolves the real native executable', async () => {
        const prepared = await prepare();
        // runtimeRoot 只影响产物写在哪里，可执行文件仍然从 enginePath 的 Release 目录取。
        expect(prepared.executablePath.startsWith(runtimeRoot)).toBe(false);
        expect(prepared.executablePath).toContain(join('native', 'simulator', 'Release'));
        expect(await pathExists(prepared.executablePath)).toBe(true);
    });

    it('honours an explicit writablePath and writes both config copies', async () => {
        // 模拟 Windows 的形态：writable path 与 runtime 根目录不是同一个。
        const writablePath = join(tempDir, 'debugruntime');
        const prepared = await prepare({ writablePath });

        expect(prepared.writablePath).toBe(writablePath);
        expect(prepared.configPaths).toEqual([
            join(runtimeRoot, 'config.json'),
            join(writablePath, 'config.json'),
        ]);
        const [a, b] = await Promise.all(prepared.configPaths.map((p) => readFile(p, 'utf8')));
        expect(a).toBe(b);
    });

    it('resolves a relative writablePath against the runtimeRoot', async () => {
        const prepared = await prepare({ writablePath: 'gamecaches' });
        expect(prepared.writablePath).toBe(join(runtimeRoot, 'gamecaches'));
    });
});

describe('prepareResources output', () => {
    it('keeps builtin preload assets of the enabled modules and drops the rest', async () => {
        // 这就是 cc.PhysicMaterial 反序列化崩溃的修复点：项目没开物理，
        // 内置物理材质就不能进 builtinResMgr 的预加载列表，但 base / 2d 的必须留下。
        await prepare();
        const settings = await readJSON(join(runtimeRoot, 'src', 'settings.json'));
        expect(settings.engine.builtinAssets).toEqual([BASE_ASSET_UUID, SPRITE_ASSET_UUID]);
        expect(settings.engine.engineModules).toEqual(INCLUDE_MODULES);
    });

    it('zeroes the splash screen time', async () => {
        await prepare();
        const settings = await readJSON(join(runtimeRoot, 'src', 'settings.json'));
        expect(settings.splashScreen.totalTime).toBe(0);
    });

    it('strips the remote bundle bases and emits a bundle index', async () => {
        await prepare();
        const bundleConfig = await readJSON(join(runtimeRoot, 'assets', 'main', 'cc.config.json'));
        expect(bundleConfig).not.toHaveProperty('importBase');
        expect(bundleConfig).not.toHaveProperty('nativeBase');
        expect(await readFile(join(runtimeRoot, 'assets', 'main', 'index.js'), 'utf8'))
            .toContain('cce:/internal/x/prerequisite-imports');
    });

    it('copies the engine runtime, adapters and systemjs bundles', async () => {
        await prepare();
        for (const relative of [
            join('jsb-adapter', 'web-adapter.js'),
            join('jsb-adapter', 'engine-adapter.js'),
            join('src', 'import-map.json'),
            join('src', 'system.bundle.js'),
            join('src', 'polyfills.bundle.js'),
            join('src', 'cocos-js', 'base.js'),
            join('src', 'builtin', 'cce.env.js'),
        ]) {
            expect(await pathExists(join(runtimeRoot, relative))).toBe(true);
        }
    });

    it('does not emit a simulator-owned cc index module', async () => {
        // cc 索引必须来自 preview server 的 quick-pack，本地再生成一份就会 feature 不一致。
        await prepare();
        expect(await pathExists(join(runtimeRoot, 'src', 'cocos-js', 'cc.js'))).toBe(false);
        const importMap = await readJSON(join(runtimeRoot, 'src', 'import-map.json'));
        expect(importMap.imports).not.toHaveProperty('cc');
        expect(importMap.imports).not.toHaveProperty('cce:/internal/x/cc');
    });

    it('renders bootable main.js / application.js pointing at the preview server', async () => {
        const prepared = await prepare();
        const main = await readFile(prepared.mainScriptPath, 'utf8');
        const application = await readFile(prepared.applicationScriptPath, 'utf8');

        for (const source of [main, application]) {
            expect(source).not.toContain('<%');
            expect(() => new Function(source)).not.toThrow();
        }
        expect(main).toContain('http://127.0.0.1:7509/scripting/x/import-map.json');
        expect(application).toContain('1280');
        expect(application).toContain('720');
    });

    it('takes the config.json resolution from the design resolution by default', async () => {
        const prepared = await prepare();
        await expect(readJSON(prepared.configPath)).resolves.toMatchObject({
            entry: 'main.js',
            width: 1280,
            height: 720,
            isLandscape: false,
            waitForConnect: false,
        });
    });

    it('lets explicit resolution / landscape / waitForConnect win', async () => {
        const prepared = await prepare({
            resolution: { width: 1334, height: 750 },
            landscape: true,
            waitForConnect: true,
        });
        await expect(readJSON(prepared.configPath)).resolves.toMatchObject({
            width: 1334,
            height: 750,
            isLandscape: true,
            waitForConnect: true,
        });
        expect(await readFile(prepared.mainScriptPath, 'utf8')).toContain('debugger');
    });

    it('points config.json entry at the generated main.js', async () => {
        const prepared = await prepare();
        const config = await readJSON(prepared.configPath) as { entry: string };
        expect(join(runtimeRoot, config.entry)).toBe(prepared.mainScriptPath);
    });

    it('writes the given previewSceneJson verbatim', async () => {
        const prepared = await prepare({ previewSceneJson: '["raw-scene"]' });
        expect(await readFile(prepared.previewSceneJsonPath, 'utf8')).toBe('["raw-scene"]');
    });

    it('marks project bundles as remote when an assetServerURL is given', async () => {
        await prepare({ assetServerURL: 'http://10.0.0.2:7509/' });
        const settings = await readJSON(join(runtimeRoot, 'src', 'settings.json'));
        expect(settings.assets.server).toBe('http://10.0.0.2:7509');
        expect(settings.assets.remoteBundles).toEqual(['resources']);
    });

    it('is idempotent across repeated runs', async () => {
        const first = await prepare();
        const before = await readFile(first.mainScriptPath, 'utf8');
        const second = await prepare();
        expect(second.runtimeRoot).toBe(first.runtimeRoot);
        expect(await readFile(second.mainScriptPath, 'utf8')).toBe(before);
    });

    it('clears stale bundles instead of merging them', async () => {
        await prepare();
        expect(await pathExists(join(runtimeRoot, 'assets', 'main'))).toBe(true);

        mockGetPreviewSettings.mockResolvedValueOnce(previewSettings(['resources']));
        await prepare();
        expect(await pathExists(join(runtimeRoot, 'assets', 'resources', 'index.js'))).toBe(true);
        expect(await pathExists(join(runtimeRoot, 'assets', 'main'))).toBe(false);
    });
});
