/**
 * Simulator 构建产物的一致性测试。
 *
 * 这里断言的都是「两个地方必须说同一件事」的关系，一旦有人只改了一边就会红：
 * - `workflow/build-simulator.js` 与 `src/core/simulator/internal.ts` 的平台产物表；
 * - `static/simulator/import-map.json` 与 `buildImportMap()` 的结构；
 * - `static/simulator/main.ejs` 的 bootstrap 约定（不再手写 `cc` / `cce:/internal/x/cc`）。
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve as resolvePath } from 'path';

import { platformArtifacts } from '../src/core/simulator/internal';

const buildSimulator = require('../workflow/build-simulator.js');
const buildSimulatorRuntime = require('../workflow/build-simulator-runtime.js');

const workspace = resolvePath(__dirname, '..');
const simulatorStaticDir = join(workspace, 'static', 'simulator');

interface IImportMap {
    imports: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
}

function readImportMap(): IImportMap {
    // import-map.json 是 build 产物、不进版本库（见 .gitignore），新克隆的仓库里不存在。
    // 这里给一句明确的提示，否则会在 collection 阶段抛裸 ENOENT，看不出该跑什么。
    const filePath = join(simulatorStaticDir, 'import-map.json');
    if (!existsSync(filePath)) {
        throw new Error(`${filePath} is missing. Run \`npm run build:simulator:runtime\` first.`);
    }
    return JSON.parse(readFileSync(filePath, 'utf8')) as IImportMap;
}

function readMainEjs(): string {
    return readFileSync(join(simulatorStaticDir, 'main.ejs'), 'utf8');
}

describe('simulator platform artifacts', () => {
    it('keeps workflow/build-simulator.js and core/simulator in sync', () => {
        // 构建脚本决定「产出哪个可执行文件」，core/simulator 决定「运行时去哪里找」。
        // 两张表必须逐字段相同，否则 launchPreview 会报 executable is unavailable。
        expect(buildSimulator.platformArtifacts).toEqual(platformArtifacts);
    });

    it('only declares the two supported desktop hosts', () => {
        expect(Object.keys(platformArtifacts).sort()).toEqual(['darwin', 'win32']);
    });

    it('derives the win32 writable-path app name from the executable name', () => {
        // getSimulatorWritablePath 会用 entry 的 basename 去掉 .exe 当作
        // %LOCALAPPDATA% 下的目录名，这里锁死这个假设。
        expect(platformArtifacts.win32!.entry).toBe('SimulatorApp-Win32.exe');
        expect(platformArtifacts.win32!.bundle).toBe('SimulatorApp-Win32.exe');
    });

    it('points the darwin entry inside the declared app bundle', () => {
        const darwin = platformArtifacts.darwin!;
        expect(darwin.entry.startsWith(`${darwin.bundle}/`)).toBe(true);
    });
});

describe('buildImportMap', () => {
    const { buildImportMap } = buildSimulatorRuntime as {
        buildImportMap: (featureUnits: string[]) => IImportMap;
    };

    it('maps every feature unit to its local systemjs chunk', () => {
        const map = buildImportMap(['base', 'physics-framework', 'spine-3.8']);
        expect(map.imports['cce:/internal/x/cc-fu/base']).toBe('./cocos-js/base.js');
        expect(map.imports['cce:/internal/x/cc-fu/physics-framework']).toBe('./cocos-js/physics-framework.js');
        expect(map.imports['cce:/internal/x/cc-fu/spine-3.8']).toBe('./cocos-js/spine-3.8.js');
    });

    it('provides the cc/env builtin under both ids', () => {
        const map = buildImportMap([]);
        expect(map.imports['cc/env']).toBe('./builtin/cce.env.js');
        expect(map.imports['cce.env']).toBe('./builtin/cce.env.js');
        expect(Object.keys(map.imports)).toHaveLength(2);
    });

    it('never declares bare aliases or the cc index module', () => {
        // `cc` 和 `cce:/internal/x/cc` 必须来自 preview server 的 quick-pack import-map，
        // 否则 simulator 会加载一份 feature 集合与项目配置不一致的 cc 索引。
        const map = buildImportMap(['base', 'physics-framework']);
        expect(map.imports).not.toHaveProperty('cc');
        expect(map.imports).not.toHaveProperty('cce:/internal/x/cc');
        expect(map.scopes).toBeUndefined();
    });
});

describe('static/simulator/import-map.json', () => {
    const map = readImportMap();

    it('is a round-trip of buildImportMap over its own feature units', () => {
        const { buildImportMap } = buildSimulatorRuntime as {
            buildImportMap: (featureUnits: string[]) => IImportMap;
        };
        const prefix = 'cce:/internal/x/cc-fu/';
        const featureUnits = Object.keys(map.imports)
            .filter((id) => id.startsWith(prefix))
            .map((id) => id.slice(prefix.length));

        expect(featureUnits.length).toBeGreaterThan(0);
        expect(buildImportMap(featureUnits)).toEqual(map);
    });

    it('ships the cc/env builtin', () => {
        expect(map.imports['cc/env']).toBe('./builtin/cce.env.js');
        expect(map.imports['cce.env']).toBe('./builtin/cce.env.js');
    });

    it('does not shadow the quick-pack cc index', () => {
        expect(map.imports).not.toHaveProperty('cc');
        expect(map.imports).not.toHaveProperty('cce:/internal/x/cc');
        expect(map.imports).not.toHaveProperty('cce:/internal/x/prerequisite-imports');
    });

    it('resolves every entry to a relative path under src/', () => {
        for (const [id, target] of Object.entries(map.imports)) {
            expect(target.startsWith('./')).toBe(true);
            expect(target.endsWith('.js')).toBe(true);
            expect(id).not.toContain('\\');
            expect(target).not.toContain('\\');
        }
    });
});

describe('static/simulator/main.ejs', () => {
    const source = readMainEjs();

    it('takes the pack import-map from the preview server', () => {
        expect(source).toContain('<%=packImportMapURL%>');
    });

    it('does not hard-wire the cc index module to a local chunk', () => {
        // 这行是移植初期的兜底，会盖掉 quick-pack 的 `cce:/internal/x/cc`。
        expect(source).not.toContain("'cce:/internal/x/cc':");
    });

    it('keeps only the bare cc alias plus the userland macro alias locally', () => {
        const localMapBlock = source.slice(
            source.indexOf("importMapList.push({ location: './'"),
            source.indexOf('System.warmup('),
        );
        expect(localMapBlock).toContain("'cc': 'cce:/internal/x/cc',");
        expect(localMapBlock).toContain("'cc/userland/macro':");
        const aliases = localMapBlock
            .split('\n')
            .map((line) => /^\s*'([^']+)':/.exec(line))
            .filter((match): match is RegExpExecArray => !!match)
            .map((match) => match[1]);
        expect(aliases).toEqual(['cc', 'cc/userland/macro']);
    });

    it('references the virtual cc index exactly once', () => {
        // 只有 `'cc' -> 'cce:/internal/x/cc'` 这一处；真正的实现由 quick-pack import-map 提供。
        expect(source.match(/cce:\/internal\/x\//g)).toHaveLength(1);
    });

    it('does not eagerly import engine feature units', () => {
        // 曾经用 eager import physics-framework 来绕过 cc.PhysicMaterial 反序列化失败，
        // 真实原因是 builtinAssets 没按项目模块裁剪，修好后这个 hack 必须保持删除状态。
        expect(source).not.toContain('cce:/internal/x/cc-fu/');
        expect(source).not.toContain('eagerModules');
    });

    it('boots through System.warmup and then the application module', () => {
        expect(source).toContain('System.warmup(');
        expect(source).toContain("System.import('./src/application.js')");
        expect(source).toContain("System.import('cc')");
    });
});

describe('simulator runtime build helpers', () => {
    const { selectSpineFeature, parseSimulatorSpineFeature, getSimulatorRuntimeBuildPlatform } = buildSimulatorRuntime as {
        selectSpineFeature: (features: string[], preferred?: string) => { selected?: string; features: string[] };
        parseSimulatorSpineFeature: (argv?: string[]) => string | undefined;
        getSimulatorRuntimeBuildPlatform: () => string;
    };

    it('keeps exactly one spine feature', () => {
        const result = selectSpineFeature(['base', 'spine-3.8', 'spine-4.2'], 'spine-4.2');
        expect(result.selected).toBe('spine-4.2');
        expect(result.features).toEqual(['base', 'spine-4.2']);
    });

    it('throws when the requested spine feature is unavailable', () => {
        expect(() => selectSpineFeature(['base', 'spine-3.8'], 'spine-9.9'))
            .toThrow(/spine-9\.9/);
    });

    it('is a no-op when the engine has no spine feature at all', () => {
        const result = selectSpineFeature(['base', '2d'], 'spine-3.8');
        expect(result.selected).toBeUndefined();
        expect(result.features).toEqual(['base', '2d']);
    });

    it('parses --spineFeature in both argv styles', () => {
        expect(parseSimulatorSpineFeature(['--spineFeature', 'spine-4.2'])).toBe('spine-4.2');
        expect(parseSimulatorSpineFeature(['--spineFeature=spine-4.2'])).toBe('spine-4.2');
        expect(parseSimulatorSpineFeature([])).toBeUndefined();
    });

    it('maps the host platform to an engine build platform', () => {
        expect(['WINDOWS', 'MAC', 'NATIVE']).toContain(getSimulatorRuntimeBuildPlatform());
    });
});
