import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { emptyDir, ensureDir, pathExists, readFile, remove, stat, writeFile } from 'fs-extra';
import { join, resolve } from 'path';
import { GlobalPaths } from '../../global';
import {
    ResolutionPolicy,
    createArgs,
    getHostManifest,
    getSimulatorDir,
    getSimulatorResourcesPath,
    getSimulatorWritablePath,
    isReadyServerURL,
    markSessionStopped,
    normalizeServerURL,
    resolveEnginePath,
    resolvePreloadAssetList,
    resolvePrepareTargets,
    resolveRuntimeRoot,
    writeSimulatorConfig,
} from './internal';
import {
    assertRequiredSimulatorArtifacts,
    copyIfExists,
    renderApplicationScript,
    renderMainScript,
    writeRuntimeEngineBootstrap,
    writeSettingsFiles,
    type IPreviewData,
} from './runtime-writer';
import type {
    ISimulatorLaunchPreviewOptions,
    ISimulatorLaunchPreviewResult,
    ISimulatorManifest,
    ISimulatorPrepareOptions,
    ISimulatorPreparedResources,
    ISimulatorResolution,
    ISimulatorSessionInfo,
    ISimulatorStartOptions,
} from './internal';

export type {
    ISimulatorLaunchPreviewOptions,
    ISimulatorLaunchPreviewResult,
    ISimulatorManifest,
    ISimulatorPrepareOptions,
    ISimulatorPreparedResources,
    ISimulatorResolution,
    ISimulatorSessionInfo,
    ISimulatorStartOptions,
};

interface ISimulatorSessionRecord {
    child: ChildProcess;
    startOptions: ISimulatorStartOptions;
    info: ISimulatorSessionInfo;
}

async function resolveProjectPath(projectPath?: string): Promise<string> {
    if (projectPath) {
        return resolve(projectPath);
    }

    const [{ default: scripting }, { default: project }] = await Promise.all([
        import('../scripting'),
        import('../project'),
    ]);

    if (scripting.projectPath) {
        return resolve(scripting.projectPath);
    }
    if (project.path) {
        return resolve(project.path);
    }

    throw new Error('Simulator prepareResources requires an opened project. Pass projectPath explicitly or initialize scripting/project first.');
}

async function resolveServerURL(serverURL?: string): Promise<string> {
    if (isReadyServerURL(serverURL)) {
        return normalizeServerURL(serverURL);
    }

    const { getServerUrl } = await import('../../server');
    const current = getServerUrl();
    if (!isReadyServerURL(current)) {
        throw new Error('Simulator prepareResources requires a running preview server. Pass serverURL explicitly or start the preview server first.');
    }
    return normalizeServerURL(current);
}

async function ensurePreviewServer(
    projectPath: string,
    options: Pick<ISimulatorLaunchPreviewOptions, 'serverURL' | 'port' | 'previewMode' | 'startScene'>,
): Promise<string> {
    const { getServerUrl } = await import('../../server');
    if (isReadyServerURL(options.serverURL)) {
        return normalizeServerURL(options.serverURL);
    }

    let serverURL = getServerUrl();
    if (isReadyServerURL(serverURL)) {
        return normalizeServerURL(serverURL);
    }

    const { default: Launcher } = await import('../launcher');
    const launcher = new Launcher(projectPath);
    if (options.previewMode === 'scene-editor') {
        await launcher.startSceneEditorPreview({
            port: options.port,
            open: false,
        });
    } else {
        await launcher.startGamePreview({
            port: options.port,
            scene: options.startScene && options.startScene !== 'current_scene' ? options.startScene : undefined,
            open: false,
        });
    }

    serverURL = getServerUrl();
    if (!isReadyServerURL(serverURL)) {
        throw new Error('Failed to start simulator preview server.');
    }
    return normalizeServerURL(serverURL);
}

async function resolvePreviewData(
    enginePath: string,
    startScene?: string,
    assetServerURL?: string,
): Promise<IPreviewData> {
    const builder = await import('../builder');
    const { fillIncludeModulesFromProjectConfig } = await import('../builder/share/common-options-validator');
    const { assetManager } = await import('../assets');
    const buildOptions = JSON.parse(JSON.stringify(
        await builder.queryDefaultBuildConfigByPlatform('windows'),
    ));
    buildOptions.debug = true;
    buildOptions.preview = true;
    await fillIncludeModulesFromProjectConfig(buildOptions as any);
    if (startScene) {
        buildOptions.startScene = startScene;
    }
    const allScenes = assetManager.queryAssetInfos({ ccType: 'cc.SceneAsset' }) || [];
    buildOptions.scenes = allScenes.map((scene) => ({ url: scene.url, uuid: scene.uuid }));

    const result = await builder.getPreviewSettings(buildOptions);
    if (!(result && result.settings)) {
        throw new Error('Failed to generate simulator preview settings.');
    }

    const settings = JSON.parse(JSON.stringify(result.settings));
    const bundleConfigs = JSON.parse(JSON.stringify(result.bundleConfigs || []));
    // 与 editor simulator 保持一致：feature 集合完全取自预览 settings（由 getPreviewSettings
    // 按项目 includeModules 生成），不再与 Engine.getConfig().includeModules 求并集。
    // 求并集会把项目里关闭的模块（如 gfx-webgpu）重新写回 settings.engine.engineModules，
    // 使「配置 feature / 实际 runtime 产物 / bootstrap feature」三者不一致。
    const features = Array.isArray(settings.engine?.engineModules) ? settings.engine.engineModules : [];

    if (settings.splashScreen) {
        settings.splashScreen.totalTime = 0;
    }
    // 预览构建的 internal bundle 会收集「全部」feature 的 dependentAssets（见 bundle/index.ts
    // initBundleRootAssets），因为浏览器/场景编辑器预览跑的是完整引擎。simulator 不是：它的 cc
    // 索引由 preview server 的 quick-pack 按项目 feature 生成，未选中的模块根本不在 runtime 里。
    // 因此 builtinResMgr 预加载列表必须按 includeModules 裁剪，否则会去反序列化只有该模块才注册
    // 的类型，例如内置物理材质 default-physics-material 用的旧类名 `cc.PhysicMaterial`
    // （别名只在 physics-framework 的 deprecated.ts 注册），报
    // "Can not find class 'cc.PhysicMaterial'" 后抛 "Cannot set properties of null (setting '_uuid')"。
    if (Array.isArray(settings.engine?.builtinAssets)) {
        const allowed = new Set(await resolvePreloadAssetList(enginePath, buildOptions.includeModules || []));
        const kept = settings.engine.builtinAssets.filter((uuid: string) => allowed.has(uuid));
        const dropped = settings.engine.builtinAssets.length - kept.length;
        if (dropped > 0) {
            console.debug(`[Simulator] Dropped ${dropped} builtin preload asset(s) not covered by project modules.`);
        }
        settings.engine.builtinAssets = kept;
    }
    if (assetServerURL) {
        settings.assets.server = normalizeServerURL(assetServerURL);
        settings.assets.remoteBundles = [...(settings.assets.projectBundles || [])];
    }

    return {
        settings,
        bundleConfigs,
        features,
    };
}

async function resolveDefaultStartScene(): Promise<string> {
    try {
        const { assetManager } = await import('../assets');
        const scenes = assetManager.queryAssetInfos({ ccType: 'cc.SceneAsset' });
        if (scenes && scenes.length) {
            const projectScene = scenes.find((scene) => scene.url.startsWith('db://assets/'));
            return (projectScene || scenes[0]).uuid;
        }
        console.warn('[Simulator] No scene asset found in project; launch scene will be empty.');
    } catch (err) {
        console.warn('[Simulator] Failed to resolve default start scene:', err);
    }
    return '';
}

async function resolvePreviewSceneJson(
    previewSceneJson: ISimulatorPrepareOptions['previewSceneJson'],
    startScene: string,
): Promise<string> {
    if (typeof previewSceneJson === 'string') {
        return previewSceneJson;
    }
    if (previewSceneJson && typeof previewSceneJson === 'object') {
        return JSON.stringify(previewSceneJson, null, 2);
    }
    if (!startScene) {
        throw new Error('Simulator preview scene is unavailable. Provide startScene or previewSceneJson explicitly.');
    }
    if (startScene === 'current_scene') {
        throw new Error('Simulator preview for current unsaved scene requires previewSceneJson to be passed explicitly.');
    }

    const { assetManager } = await import('../assets');
    const scenePath = assetManager.queryPath(startScene);
    if (!scenePath || !(await pathExists(scenePath))) {
        throw new Error(`Unable to resolve simulator preview scene: ${startScene}`);
    }
    return await readFile(scenePath, 'utf8');
}


class SimulatorManager {
    private readonly _sessions = new Map<string, ISimulatorSessionRecord>();

    async getManifest(enginePath?: string): Promise<ISimulatorManifest | null> {
        const manifest = getHostManifest();
        if (!manifest) {
            return null;
        }

        const executablePath = join(getSimulatorDir(enginePath), manifest.entry);
        if (await pathExists(executablePath)) {
            const executableStat = await stat(executablePath);
            manifest.builtAt = executableStat.mtime.toISOString();
        }

        return manifest;
    }

    async isBuilt(enginePath?: string): Promise<boolean> {
        const manifest = await this.getManifest(enginePath);
        if (!manifest || manifest.platform !== process.platform) {
            return false;
        }

        return pathExists(join(getSimulatorDir(enginePath), manifest.entry));
    }

    async isAvailable(enginePath?: string): Promise<boolean> {
        return this.isBuilt(enginePath);
    }

    getResourcesPath(enginePath?: string): string {
        return getSimulatorResourcesPath(enginePath);
    }

    getWritablePath(enginePath?: string): string {
        return getSimulatorWritablePath(enginePath);
    }

    async getExecutablePath(enginePath?: string): Promise<string | null> {
        const manifest = await this.getManifest(enginePath);
        if (!manifest || manifest.platform !== process.platform) {
            return null;
        }

        const executablePath = join(getSimulatorDir(enginePath), manifest.entry);
        return await pathExists(executablePath) ? executablePath : null;
    }

    async buildNative(enginePath?: string): Promise<void> {
        const buildScript = join(GlobalPaths.workspace, 'workflow', 'build-simulator.js');
        const resolvedEnginePath = resolveEnginePath(enginePath);
        await new Promise<void>((resolvePromise, reject) => {
            const child = spawn(process.execPath, [buildScript, `--enginePath=${resolvedEnginePath}`], {
                cwd: GlobalPaths.workspace,
                stdio: 'inherit',
                env: process.env,
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) {
                    resolvePromise();
                } else {
                    reject(new Error(`Simulator build failed with exit code ${code}`));
                }
            });
        });
    }

    async buildRuntime(enginePath?: string): Promise<void> {
        const buildScript = join(GlobalPaths.workspace, 'workflow', 'build-simulator-runtime.js');
        const resolvedEnginePath = resolveEnginePath(enginePath);
        await new Promise<void>((resolvePromise, reject) => {
            const child = spawn(process.execPath, [buildScript, `--enginePath=${resolvedEnginePath}`], {
                cwd: GlobalPaths.workspace,
                stdio: 'inherit',
                env: process.env,
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) {
                    resolvePromise();
                } else {
                    reject(new Error(`Simulator runtime build failed with exit code ${code}`));
                }
            });
        });
    }

    async build(enginePath?: string): Promise<void> {
        await this.buildNative(enginePath);
        await this.buildRuntime(enginePath);
    }

    async prepareResources(options: ISimulatorPrepareOptions = {}): Promise<ISimulatorPreparedResources> {
        const resolvedEnginePath = resolveEnginePath(options.enginePath);
        const executablePath = await this.getExecutablePath(resolvedEnginePath);
        if (!executablePath) {
            throw new Error('Native simulator executable is unavailable. Run `npm run build:simulator` first.');
        }
        await assertRequiredSimulatorArtifacts(resolvedEnginePath);

        const { runtimeRoot: resourcesPath, writablePath } = resolvePrepareTargets({
            ...options,
            enginePath: resolvedEnginePath,
        });
        const projectPath = await resolveProjectPath(options.projectPath);
        const serverURL = await resolveServerURL(options.serverURL);
        const resolvedStartScene = options.startScene || await resolveDefaultStartScene();
        const previewData = await resolvePreviewData(resolvedEnginePath, resolvedStartScene, options.assetServerURL);
        const previewSceneJson = await resolvePreviewSceneJson(
            options.previewSceneJson,
            resolvedStartScene || previewData.settings?.launch?.launchScene || '',
        );

        await ensureDir(join(resourcesPath, 'jsb-adapter'));
        await ensureDir(join(resourcesPath, 'src', 'cocos-js'));
        await emptyDir(join(resourcesPath, 'assets'));
        // 旧版本会在这里生成 simulator 专用的 cc 索引模块；现已改为走 preview server 的
        // quick-pack 产物，遗留文件必须清掉，否则会被误当成引擎 feature unit 产物。
        await remove(join(resourcesPath, 'src', 'cocos-js', 'cc.js'));
        if (options.cleanCaches) {
            // 引擎的 gamecaches 落在 native 的 writable path 下。macOS 上 writablePath 就是
            // Resources；Windows 上是 %LOCALAPPDATA%/<App>/debugruntime，两处都要清。
            await emptyDir(join(resourcesPath, 'gamecaches'));
            if (resolve(writablePath) !== resolve(resourcesPath)) {
                await emptyDir(join(writablePath, 'gamecaches'));
            }
        }

        await writeRuntimeEngineBootstrap(resourcesPath, resolvedEnginePath);

        await copyIfExists(
            join(resolvedEnginePath, 'bin', 'adapter', 'native', 'web-adapter.js'),
            join(resourcesPath, 'jsb-adapter', 'web-adapter.js'),
        );
        await copyIfExists(
            join(resolvedEnginePath, 'bin', 'adapter', 'native', 'engine-adapter.js'),
            join(resourcesPath, 'jsb-adapter', 'engine-adapter.js'),
        );
        await copyIfExists(
            join(resolvedEnginePath, 'bin', 'native-preview'),
            join(resourcesPath, 'src', 'cocos-js'),
        );
        await copyIfExists(
            join(GlobalPaths.workspace, 'static', 'simulator', 'import-map.json'),
            join(resourcesPath, 'src', 'import-map.json'),
        );
        await copyIfExists(
            join(GlobalPaths.workspace, 'static', 'simulator', 'system.bundle.js'),
            join(resourcesPath, 'src', 'system.bundle.js'),
        );
        await copyIfExists(
            join(GlobalPaths.workspace, 'static', 'simulator', 'polyfills.bundle.js'),
            join(resourcesPath, 'src', 'polyfills.bundle.js'),
        );

        const { assetManager } = await import('../assets');
        const effectBinPath = await assetManager.getEffectBinPath();
        if (effectBinPath) {
            await copyIfExists(effectBinPath, join(resourcesPath, 'src', 'effect.bin'));
        }

        await writeSettingsFiles(resourcesPath, previewData);

        const previewSceneJsonPath = join(resourcesPath, 'preview-scene.json');
        await writeFile(previewSceneJsonPath, previewSceneJson, 'utf8');

        const mainScriptPath = join(resourcesPath, 'main.js');
        const settingsPath = join(resourcesPath, 'src', 'settings.json');
        const applicationScriptPath = join(resourcesPath, 'src', 'application.js');
        const designResolution = previewData.settings?.screen?.designResolution || {
            width: options.resolution?.width || 960,
            height: options.resolution?.height || 640,
            policy: ResolutionPolicy.ResolutionShowAll,
        };
        await writeFile(mainScriptPath, await renderMainScript({
            serverURL,
            projectPath,
            waitForConnect: options.waitForConnect,
        }), 'utf8');

        await writeFile(applicationScriptPath, await renderApplicationScript({
            serverURL,
            projectPath,
            previewSceneJsonPath,
            hasPhysicsAmmo: previewData.features.includes('physics-ammo'),
            designResolution,
        }), 'utf8');

        const configPaths = await writeSimulatorConfig([resourcesPath, writablePath], {
            waitForConnect: options.waitForConnect,
            landscape: options.landscape,
            resolution: options.resolution || {
                width: designResolution.width,
                height: designResolution.height,
            },
        });

        return {
            runtimeRoot: resourcesPath,
            writablePath,
            executablePath,
            projectPath,
            serverURL,
            previewSceneJsonPath,
            settingsPath,
            mainScriptPath,
            applicationScriptPath,
            configPath: configPaths[0],
            configPaths,
        };
    }

    async launchPreview(options: ISimulatorLaunchPreviewOptions = {}): Promise<ISimulatorLaunchPreviewResult> {
        const projectPath = await resolveProjectPath(options.projectPath);
        const serverURL = await ensurePreviewServer(projectPath, options);
        const prepared = await this.prepareResources({
            ...options,
            projectPath,
            serverURL,
        });
        const session = await this.start({
            enginePath: options.enginePath,
            runtimeRoot: prepared.runtimeRoot,
            writablePath: prepared.writablePath,
            entryFile: 'main.js',
            searchPaths: options.searchPaths,
            resolution: options.resolution,
            scale: options.scale,
            landscape: options.landscape,
            portrait: options.portrait,
            showConsole: options.showConsole,
            debugLogFile: options.debugLogFile,
            position: options.position,
            bindAddress: options.bindAddress,
            env: options.env,
        });

        return {
            prepared,
            session,
        };
    }

    async start(options: ISimulatorStartOptions): Promise<ISimulatorSessionInfo> {
        const resolvedEnginePath = resolveEnginePath(options.enginePath);
        const executablePath = await this.getExecutablePath(resolvedEnginePath);
        if (!executablePath) {
            throw new Error('Native simulator executable is unavailable. Run `npm run build:simulator` first.');
        }

        const runtimeRoot = resolveRuntimeRoot({
            ...options,
            enginePath: resolvedEnginePath,
        });
        const args = createArgs({
            ...options,
            enginePath: resolvedEnginePath,
            runtimeRoot,
        });
        const child = spawn(executablePath, args, {
            cwd: runtimeRoot,
            windowsHide: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                ...options.env,
            },
        });

        const id = randomUUID();
        const info: ISimulatorSessionInfo = {
            id,
            pid: child.pid,
            status: 'running',
            startedAt: new Date().toISOString(),
            runtimeRoot,
            projectDir: runtimeRoot,
            enginePath: resolvedEnginePath,
            executablePath,
            args,
        };

        child.on('exit', (code, signal) => {
            const record = this._sessions.get(id);
            if (!record) {
                return;
            }
            markSessionStopped(record.info, code, signal);
        });

        child.on('error', (error) => {
            const record = this._sessions.get(id);
            if (!record) {
                return;
            }
            markSessionStopped(record.info, -1, null);
            console.error('[Simulator] failed to start:', error);
        });

        this._sessions.set(id, {
            child,
            startOptions: {
                ...options,
                runtimeRoot,
                writablePath: options.writablePath || getSimulatorWritablePath(resolvedEnginePath),
                enginePath: resolvedEnginePath,
                projectDir: runtimeRoot,
            },
            info,
        });

        return { ...info };
    }

    async stop(id: string): Promise<boolean> {
        const record = this._sessions.get(id);
        if (!record || record.info.status !== 'running') {
            return false;
        }

        const child = record.child;
        const waitForExit = new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) {
                    return;
                }
                settled = true;
                child.off('exit', done);
                child.off('error', done);
                resolve();
            };
            child.once('exit', done);
            child.once('error', done);
            setTimeout(done, 3000);
        });

        if (child.pid) {
            try {
                process.kill(child.pid, 'SIGTERM');
            } catch (error: any) {
                if (error?.code !== 'ESRCH') {
                    throw error;
                }
            }
        }

        await waitForExit;
        if (record.info.status === 'running') {
            markSessionStopped(record.info, null, 'SIGTERM');
        }
        return true;
    }

    async restart(id: string): Promise<ISimulatorSessionInfo> {
        const record = this._sessions.get(id);
        if (!record) {
            throw new Error(`Simulator session not found: ${id}`);
        }

        await this.stop(id);
        return this.start(record.startOptions);
    }

    getStatus(id: string): ISimulatorSessionInfo | null {
        const record = this._sessions.get(id);
        return record ? { ...record.info } : null;
    }

    listSessions(): ISimulatorSessionInfo[] {
        return Array.from(this._sessions.values()).map((record) => ({ ...record.info }));
    }
}

export const simulatorManager = new SimulatorManager();
