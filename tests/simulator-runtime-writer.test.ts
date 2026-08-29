/**
 * `prepareResources` 各写入步骤的测试。
 *
 * 完整的 `prepareResources()` 会写进 simulator app bundle 的 `Contents/Resources`
 * （真实产物目录），跑测试会覆盖开发者当前准备好的 runtime，所以这里按步骤对着临时目录
 * 逐个验证：settings / bundle 索引 / `cc/env` / `main.js` / `application.js` /
 * `config.json` / 产物校验。覆盖的正是 `prepareResources` 会调用的同一批函数。
 */

import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile } from 'fs-extra';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { createSimulatorConfig, writeSimulatorConfig } from '../src/core/simulator/internal';
import {
    PACK_IMPORT_MAP_URL,
    assertRequiredSimulatorArtifacts,
    copyIfExists,
    generateBundleIndex,
    listRequiredSimulatorArtifacts,
    renderApplicationScript,
    renderMainScript,
    writeRuntimeEngineBootstrap,
    writeSettingsFiles,
} from '../src/core/simulator/runtime-writer';

const enginePath = resolve(__dirname, '..', 'packages', 'engine');
const workspace = resolve(__dirname, '..');

let tempDir = '';

beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cocos-simulator-runtime-'));
});

afterEach(async () => {
    await remove(tempDir);
});

describe('generateBundleIndex', () => {
    it('pulls prerequisite-imports into the main bundle only', async () => {
        const main = await generateBundleIndex('main');
        const resources = await generateBundleIndex('resources');
        expect(main).toContain('cce:/internal/x/prerequisite-imports');
        expect(resources).not.toContain('cce:/internal/x/prerequisite-imports');
    });

    it('names the bundle it registers', async () => {
        expect(await generateBundleIndex('resources')).toContain('resources');
    });
});

describe('writeSettingsFiles', () => {
    const previewData = {
        settings: { engine: { engineModules: ['base'], builtinAssets: [] }, assets: {} },
        bundleConfigs: [
            { name: 'main', importBase: 'http://127.0.0.1:7509/import', nativeBase: 'http://127.0.0.1:7509/native', uuids: [] },
            { name: 'resources', importBase: 'http://127.0.0.1:7509/import', nativeBase: '', uuids: [] },
        ],
        features: ['base'],
    };

    it('writes src/settings.json', async () => {
        await writeSettingsFiles(tempDir, previewData);
        await expect(readJSON(join(tempDir, 'src', 'settings.json'))).resolves.toMatchObject({
            engine: { engineModules: ['base'] },
        });
    });

    it('writes one cc.config.json + index.js per bundle', async () => {
        await writeSettingsFiles(tempDir, previewData);
        for (const name of ['main', 'resources']) {
            expect(await pathExists(join(tempDir, 'assets', name, 'cc.config.json'))).toBe(true);
            expect(await pathExists(join(tempDir, 'assets', name, 'index.js'))).toBe(true);
        }
    });

    it('strips the remote import/native bases', async () => {
        // simulator 从本地 assets/<bundle> 读，留着远端前缀会让 AssetManager 走 HTTP。
        await writeSettingsFiles(tempDir, previewData);
        const config = await readJSON(join(tempDir, 'assets', 'main', 'cc.config.json'));
        expect(config).not.toHaveProperty('importBase');
        expect(config).not.toHaveProperty('nativeBase');
        expect(config.name).toBe('main');
    });

    it('does not mutate the caller bundleConfigs', async () => {
        await writeSettingsFiles(tempDir, previewData);
        expect(previewData.bundleConfigs[0].importBase).toBe('http://127.0.0.1:7509/import');
    });
});

describe('writeRuntimeEngineBootstrap', () => {
    it('emits a systemjs cc/env module and nothing else', async () => {
        await writeRuntimeEngineBootstrap(tempDir, enginePath);
        const cceEnv = join(tempDir, 'src', 'builtin', 'cce.env.js');
        expect(await pathExists(cceEnv)).toBe(true);

        const source = await readFile(cceEnv, 'utf8');
        expect(source).toContain('System.register');
        // PREVIEW / NATIVE / DEBUG 三个常量必须落在产物里，application.js 和引擎都要读。
        expect(source).toContain('PREVIEW');
        expect(source).toContain('NATIVE');
        expect(source).toContain('DEBUG');
    });

    it('does not generate a cc index module', async () => {
        // cc 索引改由 preview server 的 quick-pack 提供；这里再生成一份就会 feature 不一致。
        await writeRuntimeEngineBootstrap(tempDir, enginePath);
        expect(await pathExists(join(tempDir, 'src', 'cocos-js', 'cc.js'))).toBe(false);
    });
});

describe('renderMainScript', () => {
    const context = {
        serverURL: 'http://127.0.0.1:7509',
        projectPath: 'C:\\projects\\demo',
    };

    it('injects the preview server host and port', async () => {
        const source = await renderMainScript(context);
        expect(source).toContain('http://127.0.0.1:7509/');
        expect(source).toContain(`http://127.0.0.1:7509${PACK_IMPORT_MAP_URL}`);
    });

    it('emits windows paths with forward slashes', async () => {
        // 生成的是 JS 源码，`\` 会被当转义符；native 的 FileUtils 认 `/`。
        const source = await renderMainScript(context);
        expect(source).not.toContain('C:\\projects');
    });

    it('only emits the debugger statement when waiting for a connection', async () => {
        expect(await renderMainScript({ ...context, waitForConnect: true })).toContain('debugger');
        expect(await renderMainScript({ ...context, waitForConnect: false })).not.toContain('debugger');
    });

    it('produces syntactically valid javascript', async () => {
        const source = await renderMainScript(context);
        expect(() => new Function(source)).not.toThrow();
    });

    it('does not leave unrendered ejs tags behind', async () => {
        const source = await renderMainScript(context);
        expect(source).not.toContain('<%');
    });
});

describe('renderApplicationScript', () => {
    const context = {
        serverURL: 'http://127.0.0.1:7509',
        projectPath: 'C:\\projects\\demo',
        previewSceneJsonPath: 'C:\\sim\\Resources\\preview-scene.json',
        designResolution: { width: 1280, height: 720, policy: 4 },
        hasPhysicsAmmo: false,
    };

    it('injects the design resolution and policy', async () => {
        const source = await renderApplicationScript(context);
        expect(source).toContain('1280');
        expect(source).toContain('720');
    });

    it('emits windows paths with forward slashes', async () => {
        const source = await renderApplicationScript(context);
        expect(source).toContain('C:/sim/Resources/preview-scene.json');
        expect(source).toContain('C:/projects/demo/library');
        expect(source).not.toContain('C:\\');
    });

    it('produces syntactically valid javascript', async () => {
        const source = await renderApplicationScript(context);
        expect(() => new Function(source)).not.toThrow();
    });

    it('does not leave unrendered ejs tags behind', async () => {
        const source = await renderApplicationScript(context);
        expect(source).not.toContain('<%');
    });
});

describe('copyIfExists', () => {
    it('is a no-op for a missing source', async () => {
        const dest = join(tempDir, 'dest', 'missing.js');
        await copyIfExists(join(tempDir, 'nope.js'), dest);
        expect(await pathExists(dest)).toBe(false);
    });

    it('creates the destination directory and overwrites', async () => {
        const src = join(tempDir, 'src.js');
        const dest = join(tempDir, 'a', 'b', 'dest.js');
        await writeFile(src, 'v1', 'utf8');
        await copyIfExists(src, dest);
        await writeFile(src, 'v2', 'utf8');
        await copyIfExists(src, dest);
        expect(await readFile(dest, 'utf8')).toBe('v2');
    });
});

describe('assertRequiredSimulatorArtifacts', () => {
    it('lists the engine and static artifacts prepareResources depends on', () => {
        const required = listRequiredSimulatorArtifacts(enginePath);
        expect(required).toContain(join(enginePath, 'bin', 'native-preview'));
        expect(required).toContain(join(enginePath, 'bin', 'adapter', 'native', 'engine-adapter.js'));
        expect(required).toContain(join(workspace, 'static', 'simulator', 'import-map.json'));
        expect(required).toContain(join(workspace, 'static', 'simulator', 'system.bundle.js'));
        expect(required).toContain(join(workspace, 'static', 'simulator', 'polyfills.bundle.js'));
    });

    it('passes against the checked-out engine build', async () => {
        // 如果这条红了，说明本地没跑过 `npm run build:simulator`。
        await expect(assertRequiredSimulatorArtifacts(enginePath)).resolves.toBeUndefined();
    });

    it('names the missing artifact and points at the build script', async () => {
        const emptyEngine = join(tempDir, 'engine');
        await ensureDir(emptyEngine);
        await expect(assertRequiredSimulatorArtifacts(emptyEngine))
            .rejects.toThrow(/Required simulator artifact is missing.*npm run build:simulator/s);
    });
});

describe('prepared runtime layout', () => {
    it('writes every file prepareResources promises in its result', async () => {
        // 走一遍 prepareResources 的写入步骤（跳过 copy 引擎产物），断言返回值里承诺的路径都真实存在。
        const runtimeRoot = join(tempDir, 'Resources');
        const writablePath = join(tempDir, 'debugruntime');
        const projectPath = join(tempDir, 'project');

        await writeSettingsFiles(runtimeRoot, {
            settings: { engine: { engineModules: ['base'] }, screen: { designResolution: { width: 960, height: 640, policy: 4 } } },
            bundleConfigs: [{ name: 'main', uuids: [] }],
            features: ['base'],
        });
        await writeRuntimeEngineBootstrap(runtimeRoot, enginePath);

        const previewSceneJsonPath = join(runtimeRoot, 'preview-scene.json');
        await writeFile(previewSceneJsonPath, '[]', 'utf8');
        await writeFile(join(runtimeRoot, 'main.js'), await renderMainScript({
            serverURL: 'http://127.0.0.1:7509',
            projectPath,
        }), 'utf8');
        await writeFile(join(runtimeRoot, 'src', 'application.js'), await renderApplicationScript({
            serverURL: 'http://127.0.0.1:7509',
            projectPath,
            previewSceneJsonPath,
            designResolution: { width: 960, height: 640, policy: 4 },
            hasPhysicsAmmo: false,
        }), 'utf8');
        const configPaths = await writeSimulatorConfig([runtimeRoot, writablePath], {});

        for (const filePath of [
            join(runtimeRoot, 'main.js'),
            join(runtimeRoot, 'src', 'application.js'),
            join(runtimeRoot, 'src', 'settings.json'),
            join(runtimeRoot, 'src', 'builtin', 'cce.env.js'),
            join(runtimeRoot, 'assets', 'main', 'cc.config.json'),
            join(runtimeRoot, 'assets', 'main', 'index.js'),
            previewSceneJsonPath,
            ...configPaths,
        ]) {
            expect(await pathExists(filePath)).toBe(true);
        }

        // config.json 的 entry 必须指向 runtimeRoot 下真实生成的 main.js。
        const config = await readJSON(configPaths[0]);
        expect(config.entry).toBe(createSimulatorConfig({}).entry);
        expect(await pathExists(join(runtimeRoot, config.entry as string))).toBe(true);

        // Windows 上 native 会优先从 writable path 读 config.json，两份必须一致。
        expect(configPaths).toHaveLength(2);
        const [a, b] = await Promise.all(configPaths.map((p) => readFile(p, 'utf8')));
        expect(a).toBe(b);
    });
});
