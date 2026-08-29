export type {
    ISimulatorLaunchPreviewOptions,
    ISimulatorLaunchPreviewResult,
    ISimulatorManifest,
    ISimulatorPreparedResources,
    ISimulatorPrepareOptions,
    ISimulatorResolution,
    ISimulatorSessionInfo,
    ISimulatorStartOptions,
} from '../../core/simulator';

export async function buildNative(enginePath?: string): Promise<void> {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.buildNative(enginePath);
}

export async function buildRuntime(enginePath?: string): Promise<void> {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.buildRuntime(enginePath);
}

export async function prepareResources(options: import('../../core/simulator').ISimulatorPrepareOptions = {}) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.prepareResources(options);
}

export async function launchPreview(options: import('../../core/simulator').ISimulatorLaunchPreviewOptions = {}) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.launchPreview(options);
}

export async function build(enginePath?: string): Promise<void> {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.build(enginePath);
}

export async function isBuilt(enginePath?: string): Promise<boolean> {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.isBuilt(enginePath);
}

export async function isAvailable(enginePath?: string): Promise<boolean> {
    return isBuilt(enginePath);
}

export async function getManifest(enginePath?: string) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.getManifest(enginePath);
}

export async function getExecutablePath(enginePath?: string) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.getExecutablePath(enginePath);
}

export async function getResourcesPath(enginePath?: string) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.getResourcesPath(enginePath);
}

export async function getWritablePath(enginePath?: string) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.getWritablePath(enginePath);
}

export async function start(options: import('../../core/simulator').ISimulatorStartOptions) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.start(options);
}

export async function stop(id: string): Promise<boolean> {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.stop(id);
}

export async function restart(id: string) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.restart(id);
}

export async function getStatus(id: string) {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.getStatus(id);
}

export async function listSessions() {
    const { simulatorManager } = await import('../../core/simulator');
    return simulatorManager.listSessions();
}
