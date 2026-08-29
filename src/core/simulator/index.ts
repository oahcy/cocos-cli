import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import ejs from 'ejs';
import { copy, emptyDir, ensureDir, pathExists, readFile, readJSON, stat, writeFile } from 'fs-extra';
import { dirname, isAbsolute, join, resolve } from 'path';
import { GlobalPaths } from '../../global';

type SimulatorStatus = 'running' | 'stopped';
type SimulatorBuildPlatform = 'mac' | 'windows';

enum ResolutionPolicy {
    ResolutionExactFit,
    ResolutionNoBorder,
    ResolutionShowAll,
    ResolutionFixedHeight,
    ResolutionFixedWidth,
}

export interface ISimulatorManifest {
    /**
     * Native simulator executable metadata for the current host platform.
     */
    platform: NodeJS.Platform;
    bundle: string;
    entry: string;
    builtAt?: string;
}

export interface ISimulatorResolution {
    width: number;
    height: number;
}

export interface ISimulatorPrepareOptions {
    enginePath?: string;
    projectPath?: string;
    serverURL?: string;
    /**
     * Override the runtime asset server. When specified, simulator settings will
     * treat project bundles as remote bundles and fetch them over HTTP.
     */
    assetServerURL?: string;
    startScene?: string;
    /**
     * Explicit scene JSON for unsaved/current scene preview.
     */
    previewSceneJson?: string | Record<string, unknown>;
    waitForConnect?: boolean;
    resolution?: ISimulatorResolution;
    landscape?: boolean;
    cleanCaches?: boolean;
}

export interface ISimulatorPreparedResources {
    runtimeRoot: string;
    writablePath: string;
    executablePath: string;
    projectPath: string;
    serverURL: string;
    previewSceneJsonPath: string;
    settingsPath: string;
    mainScriptPath: string;
    applicationScriptPath: string;
    configPath: string;
}

export interface ISimulatorLaunchPreviewOptions extends ISimulatorPrepareOptions, Omit<ISimulatorStartOptions, 'runtimeRoot' | 'projectDir' | 'entryFile' | 'writablePath'> {
    port?: number;
    previewMode?: 'game' | 'scene-editor';
}

export interface ISimulatorLaunchPreviewResult {
    prepared: ISimulatorPreparedResources;
    session: ISimulatorSessionInfo;
}

export interface ISimulatorStartOptions {
    runtimeRoot?: string;
    /**
     * @deprecated Use runtimeRoot instead. Kept temporarily as an alias while Pink
     * migrates to the runtime-root based launch flow.
     */
    projectDir?: string;
    enginePath?: string;
    entryFile?: string;
    writablePath?: string;
    searchPaths?: string[];
    resolution?: ISimulatorResolution;
    scale?: number;
    landscape?: boolean;
    portrait?: boolean;
    showConsole?: boolean;
    debugLogFile?: string;
    position?: { x: number; y: number };
    bindAddress?: string;
    env?: Record<string, string | undefined>;
}

export interface ISimulatorSessionInfo {
    id: string;
    pid?: number;
    status: SimulatorStatus;
    startedAt?: string;
    exitedAt?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    runtimeRoot: string;
    /**
     * @deprecated Use runtimeRoot instead.
     */
    projectDir: string;
    enginePath: string;
    executablePath: string;
    args: string[];
}

interface ISimulatorSessionRecord {
    child: ChildProcess;
    startOptions: ISimulatorStartOptions;
    info: ISimulatorSessionInfo;
}

interface IHostArtifact {
    bundle: string;
    entry: string;
}

interface IPreviewData {
    settings: any;
    bundleConfigs: any[];
    features: string[];
}

function markSessionStopped(
    info: ISimulatorSessionInfo,
    exitCode: number | null,
    signal: NodeJS.Signals | string | null,
): void {
    info.status = 'stopped';
    info.exitCode = exitCode;
    info.signal = signal;
    info.exitedAt = new Date().toISOString();
}

const platformArtifacts: Partial<Record<NodeJS.Platform, IHostArtifact>> = {
    darwin: {
        bundle: 'SimulatorApp-Mac.app',
        entry: 'SimulatorApp-Mac.app/Contents/MacOS/SimulatorApp-Mac',
    },
    win32: {
        bundle: 'SimulatorApp-Win32.exe',
        entry: 'SimulatorApp-Win32.exe',
    },
};

function getHostManifest(): ISimulatorManifest | null {
    const manifest = platformArtifacts[process.platform];
    if (!manifest) {
        return null;
    }

    return {
        platform: process.platform,
        bundle: manifest.bundle,
        entry: manifest.entry,
    };
}

function getSimulatorBuildPlatform(): SimulatorBuildPlatform {
    if (process.platform === 'darwin') {
        return 'mac';
    }
    if (process.platform === 'win32') {
        return 'windows';
    }
    throw new Error(`Simulator is not supported on host platform: ${process.platform}`);
}

function resolveEnginePath(enginePath?: string): string {
    return resolve(enginePath || GlobalPaths.enginePath);
}

function getSimulatorDir(enginePath?: string): string {
    return join(resolveEnginePath(enginePath), 'native', 'simulator', 'Release');
}

function getSimulatorRoot(enginePath?: string): string {
    const manifest = getHostManifest();
    if (!manifest) {
        throw new Error(`Simulator is not supported on host platform: ${process.platform}`);
    }
    const releaseDir = getSimulatorDir(enginePath);
    return process.platform === 'darwin' ? join(releaseDir, manifest.bundle) : releaseDir;
}

function getSimulatorResourcesPath(enginePath?: string): string {
    const simulatorRoot = getSimulatorRoot(enginePath);
    return process.platform === 'darwin'
        ? join(simulatorRoot, 'Contents', 'Resources')
        : simulatorRoot;
}

function getSimulatorWritablePath(enginePath?: string): string {
    if (process.platform === 'darwin') {
        return getSimulatorResourcesPath(enginePath);
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
        return join(localAppData, 'SimulatorApp-Win32', 'debugruntime');
    }
    return getSimulatorResourcesPath(enginePath);
}

function normalizeServerURL(serverURL: string): string {
    return serverURL.replace(/\/+$/, '');
}

function isReadyServerURL(serverURL: string | undefined | null): serverURL is string {
    return typeof serverURL === 'string' && /^https?:\/\//.test(serverURL);
}

function formatPath(pathValue: string): string {
    return pathValue.replace(/\\/g, '/');
}

function parsePreviewServer(serverURL: string) {
    const url = new URL(serverURL);
    return {
        previewIp: url.hostname,
        previewPort: Number(url.port || (url.protocol === 'https:' ? '443' : '80')),
    };
}

function requireFromEngine<T = any>(request: string, enginePath: string): T {
    const resolved = require.resolve(request, {
        paths: [enginePath, GlobalPaths.workspace],
    });
    return require(resolved) as T;
}

function resolveRuntimeRoot(options: ISimulatorStartOptions): string {
    const runtimeRoot = options.runtimeRoot ?? options.projectDir;
    if (runtimeRoot) {
        return resolve(runtimeRoot);
    }
    return getSimulatorResourcesPath(options.enginePath);
}

function resolveOptionPath(runtimeRoot: string, filePath: string): string {
    if (isAbsolute(filePath)) {
        return filePath;
    }
    return resolve(runtimeRoot, filePath);
}

function createArgs(options: ISimulatorStartOptions): string[] {
    const runtimeRoot = resolveRuntimeRoot(options);
    const args = ['-workdir', runtimeRoot];

    if (options.entryFile) {
        args.push('-entry', resolveOptionPath(runtimeRoot, options.entryFile));
    }

    const writablePath = options.writablePath
        ? resolveOptionPath(runtimeRoot, options.writablePath)
        : getSimulatorWritablePath(options.enginePath);
    args.push('-writable-path', writablePath);

    if (options.landscape) {
        args.push('-landscape');
    }
    if (options.portrait) {
        args.push('-portrait');
    }
    if (options.resolution) {
        args.push('-resolution', `${options.resolution.width}x${options.resolution.height}`);
    }
    if (typeof options.scale === 'number') {
        args.push('-scale', `${options.scale}`);
    }
    if (typeof options.showConsole === 'boolean') {
        args.push('-console', options.showConsole ? 'true' : 'false');
    }
    if (options.debugLogFile) {
        args.push('-write-debug-log', resolveOptionPath(runtimeRoot, options.debugLogFile));
    }
    if (options.position) {
        args.push('-position', `${options.position.x},${options.position.y}`);
    }
    if (options.bindAddress) {
        args.push('-listen', options.bindAddress);
    }
    if (options.searchPaths?.length) {
        const searchPaths = options.searchPaths.map((searchPath) => resolveOptionPath(runtimeRoot, searchPath));
        args.push('-search-path', searchPaths.join(';'));
    }

    return args;
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

async function resolvePreviewData(startScene?: string, assetServerURL?: string): Promise<IPreviewData> {
    const builder = await import('../builder');
    const { fillIncludeModulesFromProjectConfig } = await import('../builder/share/common-options-validator');
    const { assetManager } = await import('../assets');
    const { Engine } = await import('../engine');
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
    const configuredFeatures = Array.isArray(Engine.getConfig().includeModules) ? Engine.getConfig().includeModules : [];
    const previewFeatures = Array.isArray(settings.engine?.engineModules) ? settings.engine.engineModules : [];
    const features = Array.from(new Set([
        ...configuredFeatures,
        ...previewFeatures,
    ]));

    if (settings.splashScreen) {
        settings.splashScreen.totalTime = 0;
    }
    if (settings.engine) {
        settings.engine.engineModules = features;
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

async function generateBundleIndex(bundleName: string): Promise<string> {
    const bundleEntry = bundleName === 'main' ? ['cce:/internal/x/prerequisite-imports'] : [];
    return await ejs.renderFile(join(GlobalPaths.workspace, 'static', 'simulator', 'bundleIndex.ejs'), {
        bundleName,
        bundleEntry,
    });
}

async function writeSettingsFiles(resourcesPath: string, previewData: IPreviewData): Promise<void> {
    await ensureDir(join(resourcesPath, 'src'));
    await writeFile(join(resourcesPath, 'src', 'settings.json'), `${JSON.stringify(previewData.settings, null, 2)}\n`, 'utf8');

    for (const config of previewData.bundleConfigs) {
        const outputConfig = JSON.parse(JSON.stringify(config));
        delete outputConfig.importBase;
        delete outputConfig.nativeBase;

        const bundleDir = join(resourcesPath, 'assets', outputConfig.name);
        await ensureDir(bundleDir);
        await writeFile(join(bundleDir, 'cc.config.json'), `${JSON.stringify(outputConfig, null, 2)}\n`, 'utf8');
        await writeFile(join(bundleDir, 'index.js'), await generateBundleIndex(outputConfig.name), 'utf8');
    }
}

async function resolveBuiltRuntimeFeatureUnits(enginePath: string): Promise<string[]> {
    const runtimeImportMapPath = join(GlobalPaths.workspace, 'static', 'simulator', 'import-map.json');
    const runtimeImportMap = await readJSON(runtimeImportMapPath).catch(() => null) as {
        imports?: Record<string, string>;
    } | null;
    if (!runtimeImportMap?.imports) {
        return [];
    }

    const featureUnits: string[] = [];
    for (const [specifier, target] of Object.entries(runtimeImportMap.imports)) {
        if (specifier.includes('/') || specifier === 'cc/env' || specifier === 'cce.env') {
            continue;
        }
        if (target !== `./cocos-js/${specifier}.js`) {
            continue;
        }
        if (await pathExists(join(enginePath, 'bin', 'native-preview', `${specifier}.js`))) {
            featureUnits.push(specifier);
        }
    }
    return featureUnits;
}

async function writeRuntimeEngineBootstrap(resourcesPath: string, enginePath: string, features: string[]): Promise<void> {
    const ccbuild = requireFromEngine<any>('@cocos/ccbuild', enginePath);
    const { BuiltinModuleProvider } = requireFromEngine<any>('@cocos/lib-programming/dist/builtin-module-provider', enginePath);

    const ccModuleFile = join(resourcesPath, 'src', 'cocos-js', 'cc.js');
    const cceEnvFile = join(resourcesPath, 'src', 'builtin', 'cce.env.js');
    await ensureDir(dirname(ccModuleFile));
    await ensureDir(dirname(cceEnvFile));

    const statsQuery = await ccbuild.StatsQuery.create(enginePath);
    const ccEnvConstants = statsQuery.constantManager.genCCEnvConstants({
        mode: 'PREVIEW',
        platform: 'NATIVE',
        flags: {
            DEBUG: true,
        },
    });
    const builtFeatureUnits = await resolveBuiltRuntimeFeatureUnits(enginePath);
    const featureUnits = builtFeatureUnits.length > 0
        ? builtFeatureUnits
        : statsQuery.getUnitsOfFeatures(features);
    const { code: indexMod } = await ccbuild.buildEngine.transform(
        statsQuery.evaluateIndexModuleSource(featureUnits, (moduleName: string) => moduleName),
        'system',
    );
    const builtinModuleProvider = await BuiltinModuleProvider.create({ format: 'systemjs' });
    await builtinModuleProvider.addBuildTimeConstantsMod(ccEnvConstants);

    await writeFile(ccModuleFile, indexMod, 'utf8');
    await writeFile(cceEnvFile, builtinModuleProvider.modules['cc/env'], 'utf8');
}

async function writeSimulatorConfig(
    writablePath: string,
    options: Pick<ISimulatorPrepareOptions, 'waitForConnect' | 'landscape' | 'resolution'>,
): Promise<string> {
    await ensureDir(writablePath);
    const configPath = join(writablePath, 'config.json');
    const resolution = options.resolution || { width: 960, height: 640 };
    await writeFile(configPath, `${JSON.stringify({
        name: 'Simulator',
        entry: 'main.js',
        isLandscape: !!options.landscape,
        isWindowTop: false,
        waitForConnect: !!options.waitForConnect,
        width: resolution.width,
        height: resolution.height,
        consolePort: 6050,
        uploadPort: 6060,
        debugPort: 5086,
    }, null, 2)}\n`, 'utf8');
    return configPath;
}

async function copyIfExists(src: string, dest: string): Promise<void> {
    if (!(await pathExists(src))) {
        return;
    }
    await ensureDir(dirname(dest));
    await copy(src, dest, { overwrite: true });
}

async function assertRequiredSimulatorArtifacts(enginePath: string): Promise<void> {
    const requiredPaths = [
        join(enginePath, 'bin', 'native-preview'),
        join(enginePath, 'bin', 'adapter', 'native', 'web-adapter.js'),
        join(enginePath, 'bin', 'adapter', 'native', 'engine-adapter.js'),
        join(GlobalPaths.workspace, 'static', 'simulator', 'import-map.json'),
        join(GlobalPaths.workspace, 'static', 'simulator', 'system.bundle.js'),
        join(GlobalPaths.workspace, 'static', 'simulator', 'polyfills.bundle.js'),
    ];

    for (const filePath of requiredPaths) {
        if (!(await pathExists(filePath))) {
            throw new Error(`Required simulator artifact is missing: ${filePath}. Run \`npm run build:simulator\` first.`);
        }
    }
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

        const resourcesPath = getSimulatorResourcesPath(resolvedEnginePath);
        const writablePath = getSimulatorWritablePath(resolvedEnginePath);
        const projectPath = await resolveProjectPath(options.projectPath);
        const serverURL = await resolveServerURL(options.serverURL);
        const resolvedStartScene = options.startScene || await resolveDefaultStartScene();
        const previewData = await resolvePreviewData(resolvedStartScene, options.assetServerURL);
        const previewSceneJson = await resolvePreviewSceneJson(
            options.previewSceneJson,
            resolvedStartScene || previewData.settings?.launch?.launchScene || '',
        );

        await ensureDir(join(resourcesPath, 'jsb-adapter'));
        await ensureDir(join(resourcesPath, 'src', 'cocos-js'));
        await emptyDir(join(resourcesPath, 'assets'));
        if (options.cleanCaches) {
            await emptyDir(join(resourcesPath, 'gamecaches'));
        }

        await writeRuntimeEngineBootstrap(resourcesPath, resolvedEnginePath, previewData.features);

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

        const { previewIp, previewPort } = parsePreviewServer(serverURL);
        const libraryPath = formatPath(join(projectPath, 'library'));
        const mainScriptPath = join(resourcesPath, 'main.js');
        const settingsPath = join(resourcesPath, 'src', 'settings.json');
        const applicationScriptPath = join(resourcesPath, 'src', 'application.js');
        const designResolution = previewData.settings?.screen?.designResolution || {
            width: options.resolution?.width || 960,
            height: options.resolution?.height || 640,
            policy: ResolutionPolicy.ResolutionShowAll,
        };
        const mainJsSource = await ejs.renderFile(join(GlobalPaths.workspace, 'static', 'simulator', 'main.ejs'), {
            libraryPath,
            waitForConnect: !!options.waitForConnect,
            projectPath: formatPath(projectPath),
            previewIp,
            previewPort,
            packImportMapURL: '/scripting/x/pack-import-map-url',
            packResolutionDetailMapURL: '/scripting/x/resolution-detail-map.json',
        });
        await writeFile(mainScriptPath, mainJsSource, 'utf8');

        const appJsSource = await ejs.renderFile(join(GlobalPaths.workspace, 'static', 'simulator', 'application.ejs'), {
            hasPhysicsAmmo: previewData.features.includes('physics-ammo'),
            previewSceneJsonPath: formatPath(previewSceneJsonPath),
            libraryPath,
            projectPath: formatPath(projectPath),
            designResolution: {
                width: designResolution.width,
                height: designResolution.height,
                resolutionPolicy: designResolution.policy,
            },
            previewIp,
            previewPort,
        });
        await writeFile(applicationScriptPath, appJsSource, 'utf8');

        const configPath = await writeSimulatorConfig(writablePath, {
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
            configPath,
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
