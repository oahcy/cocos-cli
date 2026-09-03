/**
 * `simulatorManager` 的进程编排、事件与去重测试。
 *
 * 这一层没法用真实 simulator：起窗口需要 native 产物、退出时机不可控。所以把
 * `child_process.spawn` 换成假的 `ChildProcess`（EventEmitter + 两条 PassThrough），
 * 由测试自己决定什么时候出输出、什么时候退出。
 *
 * 唯一被 stub 的实例方法是 `getExecutablePath`（`start()` 的前置校验），因为它需要
 * 真实构建产物，与本文件要验的行为无关。其余全走真实实现。
 */

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const mockSpawn = jest.fn();
const mockTreeKill = jest.fn();

jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('tree-kill', () => ({
    __esModule: true,
    default: (pid: number, signal: string, callback?: (error?: Error) => void) => mockTreeKill(pid, signal, callback),
}));

// `launchPreview` 会 `import('../../server')` 拿 preview server 地址。测试传了现成的
// `serverURL`，走的是 early return，但那个 import 本身会拖起整个 server 模块，直接替掉。
jest.mock('../src/server', () => ({
    getServerUrl: () => 'http://127.0.0.1:7509',
}));

import { simulatorManager, type ISimulatorBuildState, type ISimulatorLogEntry, type ISimulatorSessionInfo } from '../src/core/simulator';

const EXECUTABLE = '/fake/SimulatorApp-Mac.app/Contents/MacOS/SimulatorApp-Mac';

/** 假的 `ChildProcess`：只实现本文件用到的那几个成员。 */
class FakeChild extends EventEmitter {
    static nextPid = 4242;

    /** 每个实例一个不同的 pid —— stopAll 要能按 pid 分别命中。 */
    pid = FakeChild.nextPid++;
    stdout = new PassThrough();
    stderr = new PassThrough();

    /** 模拟进程退出：先冲掉未读的输出，再按真实 ChildProcess 的顺序发 `exit` 然后 `close`。 */
    exit(code: number | null, signal: NodeJS.Signals | null = null): void {
        this.stdout.end();
        this.stderr.end();
        this.emit('exit', code, signal);
        this.emit('close', code, signal);
    }
}

/** 等一个 macrotask，让 stream 的 `data` 事件派发完。 */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('simulatorManager 进程编排', () => {
    let children: FakeChild[] = [];
    const disposers: Array<() => void> = [];
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        children = [];
        mockSpawn.mockReset();
        mockSpawn.mockImplementation(() => {
            const child = new FakeChild();
            children.push(child);
            return child;
        });
        mockTreeKill.mockReset();
        // 默认「杀成功」：立刻回调，并让 child 走一次 exit。
        mockTreeKill.mockImplementation((pid: number, signal: string, callback?: () => void) => {
            const target = children.find((child) => child.pid === pid);
            target?.exit(null, signal as NodeJS.Signals);
            callback?.();
        });

        jest.spyOn(simulatorManager, 'getExecutablePath').mockResolvedValue(EXECUTABLE);
        // 逐行输出会真的打到 console（刻意保留的行为，见 3.4），测试里静音掉。
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* 静音 */ });
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* 静音 */ });
    });

    afterEach(async () => {
        while (disposers.length) {
            disposers.pop()!();
        }
        await simulatorManager.stopAll();
        logSpy.mockRestore();
        errorSpy.mockRestore();
        jest.restoreAllMocks();
    });

    /** 订阅并登记反订阅，afterEach 统一清掉。 */
    function collectSessions(): ISimulatorSessionInfo[] {
        const events: ISimulatorSessionInfo[] = [];
        disposers.push(simulatorManager.onDidChangeSession((session) => events.push(session)));
        return events;
    }

    function collectLogs(): ISimulatorLogEntry[] {
        const entries: ISimulatorLogEntry[] = [];
        disposers.push(simulatorManager.onLog((entry) => entries.push(entry)));
        return entries;
    }

    describe('stdio', () => {
        it('pipes stdout/stderr instead of ignoring them', async () => {
            await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            // 'ignore' 会把 simulator 的 JS 报错和 cc.log 全丢掉，这是 3.4 的核心修复。
            expect(mockSpawn.mock.calls[0][2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
        });

        it('emits one onLog entry per line, splitting chunks on newlines', async () => {
            const logs = collectLogs();
            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            // 一个 chunk 里两行半，最后半行要留在缓冲里。
            children[0].stdout.write('first\nsecond\npart');
            await flush();

            expect(logs.map((entry) => entry.message)).toEqual(['first', 'second']);
            expect(logs.every((entry) => entry.source === 'simulator' && entry.level === 'log')).toBe(true);
            expect(logs.every((entry) => entry.sessionId === session.id)).toBe(true);
        });

        it('flushes the trailing partial line on exit', async () => {
            const logs = collectLogs();
            await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            children[0].stdout.write('no trailing newline');
            await flush();
            expect(logs).toHaveLength(0);

            children[0].exit(0);
            await flush();
            expect(logs.map((entry) => entry.message)).toEqual(['no trailing newline']);
        });

        it('tags stderr lines as level error', async () => {
            const logs = collectLogs();
            await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            children[0].stderr.write('boom\n');
            await flush();

            expect(logs).toEqual([expect.objectContaining({ source: 'simulator', level: 'error', message: 'boom' })]);
        });
    });

    describe('onDidChangeSession', () => {
        it('fires on start with status running', async () => {
            const events = collectSessions();
            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ id: session.id, status: 'running', pid: session.pid });
            expect(events[0].readyAt).toBeUndefined();
        });

        it('fires again with readyAt on the first stdout chunk — editor 的 onCompleted 时机', async () => {
            const events = collectSessions();
            await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            children[0].stdout.write('booting\n');
            await flush();

            const ready = events.filter((event) => event.readyAt);
            expect(ready).toHaveLength(1);
            expect(ready[0].status).toBe('running');

            // 后续输出不再重复 fire。
            children[0].stdout.write('more\n');
            await flush();
            expect(events.filter((event) => event.readyAt)).toHaveLength(1);
        });

        it('fires on exit with the exit code', async () => {
            const events = collectSessions();
            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            children[0].exit(3);
            await flush();

            const last = events[events.length - 1];
            expect(last).toMatchObject({ id: session.id, status: 'stopped', exitCode: 3 });
            expect(last.exitedAt).toBeTruthy();
        });

        it('fires on spawn error with exitCode -1', async () => {
            const events = collectSessions();
            const logs = collectLogs();
            await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            children[0].emit('error', new Error('ENOENT'));
            await flush();

            expect(events[events.length - 1]).toMatchObject({ status: 'stopped', exitCode: -1 });
            expect(logs).toContainEqual(expect.objectContaining({ level: 'error', message: 'failed to start: ENOENT' }));
        });

        it('fires on stop', async () => {
            const events = collectSessions();
            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });

            expect(await simulatorManager.stop(session.id)).toBe(true);
            expect(events[events.length - 1]).toMatchObject({ id: session.id, status: 'stopped' });
        });
    });

    describe('stop / stopAll', () => {
        it('uses treeKill so simulator 的子进程一起走', async () => {
            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });
            await simulatorManager.stop(session.id);

            expect(mockTreeKill).toHaveBeenCalledTimes(1);
            expect(mockTreeKill.mock.calls[0][0]).toBe(session.pid);
            expect(mockTreeKill.mock.calls[0][1]).toBe('SIGTERM');
        });

        it('returns false for unknown or already stopped sessions', async () => {
            expect(await simulatorManager.stop('nope')).toBe(false);

            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });
            expect(await simulatorManager.stop(session.id)).toBe(true);
            expect(await simulatorManager.stop(session.id)).toBe(false);
        });

        it('still resolves when treeKill reports a failure（进程已经自己退了）', async () => {
            mockTreeKill.mockImplementation((_pid: number, _signal: string, callback?: (error?: Error) => void) => {
                callback?.(new Error('No matching processes'));
            });

            const session = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });
            children[0].exit(0);
            await flush();

            // exit 已经把状态改成 stopped，stop 直接返回 false 而不是抛。
            expect(await simulatorManager.stop(session.id)).toBe(false);
        });

        it('stops every running session and returns the count', async () => {
            await simulatorManager.start({ runtimeRoot: '/tmp/a' });
            await simulatorManager.start({ runtimeRoot: '/tmp/b' });
            const done = await simulatorManager.start({ runtimeRoot: '/tmp/c' });
            children[2].exit(0);
            await flush();

            expect(await simulatorManager.stopAll()).toBe(2);
            expect(simulatorManager.listSessions().filter((session) => session.status === 'running')).toHaveLength(0);
            expect(simulatorManager.getStatus(done.id)?.status).toBe('stopped');
            expect(await simulatorManager.stopAll()).toBe(0);
        });
    });

    describe('构建事件与去重', () => {
        /** 让 spawn 出来的构建子进程立刻以 `code` 退出。 */
        function autoExit(code: number, stdout?: string): void {
            mockSpawn.mockImplementation(() => {
                const child = new FakeChild();
                children.push(child);
                setImmediate(() => {
                    if (stdout) {
                        child.stdout.write(stdout);
                    }
                    child.exit(code);
                });
                return child;
            });
        }

        function collectBuildStates(): ISimulatorBuildState[] {
            const states: ISimulatorBuildState[] = [];
            disposers.push(simulatorManager.onDidChangeBuildState((state) => states.push(state)));
            return states;
        }

        it('broadcasts start then success — 对齐 editor 的两点广播', async () => {
            autoExit(0);
            const states = collectBuildStates();

            await simulatorManager.buildRuntime('/fake/engine');

            expect(states).toEqual([
                { step: 'runtime', state: 'start' },
                { step: 'runtime', state: 'success' },
            ]);
        });

        it('broadcasts failed with the error message', async () => {
            autoExit(1);
            const states = collectBuildStates();

            await expect(simulatorManager.buildNative('/fake/engine')).rejects.toThrow('Simulator build failed with exit code 1');

            expect(states).toEqual([
                { step: 'native', state: 'start' },
                { step: 'native', state: 'failed', error: 'Simulator build failed with exit code 1' },
            ]);
        });

        it('emits build output under source build and keeps the console passthrough', async () => {
            autoExit(0, 'compiling\n');
            const logs = collectLogs();

            await simulatorManager.buildRuntime('/fake/engine');

            expect(logs).toEqual([{ source: 'build', level: 'log', message: 'compiling' }]);
            // pipe 之后原来 stdio:'inherit' 那条路要靠 console.log 顶上，不能丢。
            expect(logSpy).toHaveBeenCalledWith('compiling');
        });

        it('collapses concurrent builds of the same engine into one child process', async () => {
            autoExit(0);

            await Promise.all([
                simulatorManager.buildRuntime('/fake/engine'),
                simulatorManager.buildRuntime('/fake/engine'),
                simulatorManager.buildRuntime('/fake/engine'),
            ]);

            expect(mockSpawn).toHaveBeenCalledTimes(1);
        });

        it('does not collapse different engines, nor后续的重新构建', async () => {
            autoExit(0);

            await Promise.all([
                simulatorManager.buildRuntime('/fake/engine-a'),
                simulatorManager.buildRuntime('/fake/engine-b'),
            ]);
            expect(mockSpawn).toHaveBeenCalledTimes(2);

            await simulatorManager.buildRuntime('/fake/engine-a');
            expect(mockSpawn).toHaveBeenCalledTimes(3);
        });

        it('collapses concurrent prepareResources targeting the same runtime root', async () => {
            const prepare = jest.spyOn(simulatorManager as unknown as { _prepareResources: () => Promise<unknown> }, '_prepareResources')
                .mockImplementation(() => new Promise((resolve) => setImmediate(() => resolve({}))));

            await Promise.all([
                simulatorManager.prepareResources({ runtimeRoot: '/tmp/shared' }),
                simulatorManager.prepareResources({ runtimeRoot: '/tmp/shared' }),
            ]);
            expect(prepare).toHaveBeenCalledTimes(1);

            await Promise.all([
                simulatorManager.prepareResources({ runtimeRoot: '/tmp/one' }),
                simulatorManager.prepareResources({ runtimeRoot: '/tmp/two' }),
            ]);
            expect(prepare).toHaveBeenCalledTimes(3);
        });
    });

    describe('launchPreview 先停后起', () => {
        it('stops the previous session before preparing, leaving a single running one', async () => {
            const order: string[] = [];
            jest.spyOn(simulatorManager as unknown as { _prepareResources: () => Promise<unknown> }, '_prepareResources')
                .mockImplementation(() => {
                    order.push('prepare');
                    return Promise.resolve({ runtimeRoot: '/tmp/runtime', writablePath: '/tmp/runtime' });
                });

            const stopAll = jest.spyOn(simulatorManager, 'stopAll');
            const first = await simulatorManager.start({ runtimeRoot: '/tmp/runtime' });
            order.push('first-started');

            const result = await simulatorManager.launchPreview({ projectPath: '/fake/project', serverURL: 'http://127.0.0.1:7509' });

            expect(stopAll).toHaveBeenCalledTimes(1);
            expect(simulatorManager.getStatus(first.id)?.status).toBe('stopped');
            expect(simulatorManager.getStatus(result.session.id)?.status).toBe('running');
            expect(simulatorManager.listSessions().filter((session) => session.status === 'running')).toHaveLength(1);
            // 停要发生在 prepare 之前：prepare 会清空并重写正在被打开的 runtime 目录。
            expect(order).toEqual(['first-started', 'prepare']);
        });
    });
});
