import { camelize, NOOP as noop } from '@vue/shared';
import { posix as path } from 'path-browserify';
import type * as ts from 'typescript';
import { generateGlobalTypes, getGlobalTypesFileName } from '../codegen/globalTypes';
import { getAllExtensions } from '../languagePlugin';
import type { RawVueCompilerOptions, VueCompilerOptions, VueLanguagePlugin } from '../types';
import { hyphenateTag } from './shared';

export type ParsedCommandLine = ts.ParsedCommandLine & {
	vueOptions: VueCompilerOptions;
};

export function createParsedCommandLineByJson(
	ts: typeof import('typescript'),
	parseConfigHost: ts.ParseConfigHost & {
		writeFile?(path: string, data: string): void;
	},
	rootDir: string,
	json: any,
	configFileName = rootDir + '/jsconfig.json',
): ParsedCommandLine {
	const proxyHost = proxyParseConfigHostForExtendConfigPaths(parseConfigHost);
	ts.parseJsonConfigFileContent(json, proxyHost.host, rootDir, {}, configFileName);

	const resolver = new CompilerOptionsResolver(parseConfigHost.fileExists);

	for (const extendPath of proxyHost.extendConfigPaths.reverse()) {
		try {
			const configFile = ts.readJsonConfigFile(extendPath, proxyHost.host.readFile);
			const obj = ts.convertToObject(configFile, []);
			const rawOptions: RawVueCompilerOptions = obj?.vueCompilerOptions ?? {};
			resolver.addConfig(rawOptions, path.dirname(configFile.fileName));
		}
		catch {}
	}

	// ensure the rootDir is added to the config roots
	resolver.addConfig({}, rootDir);

	const resolvedVueOptions = resolver.build();
	const parsed = ts.parseJsonConfigFileContent(
		json,
		proxyHost.host,
		rootDir,
		{},
		configFileName,
		undefined,
		getAllExtensions(resolvedVueOptions)
			.map(extension => ({
				extension: extension.slice(1),
				isMixedContent: true,
				scriptKind: ts.ScriptKind.Deferred,
			})),
	);

	// fix https://github.com/vuejs/language-tools/issues/1786
	// https://github.com/microsoft/TypeScript/issues/30457
	// patching ts server broke with outDir + rootDir + composite/incremental
	parsed.options.outDir = undefined;

	return {
		...parsed,
		vueOptions: resolvedVueOptions,
	};
}

export function createParsedCommandLine(
	ts: typeof import('typescript'),
	parseConfigHost: ts.ParseConfigHost,
	tsConfigPath: string,
): ParsedCommandLine {
	try {
		const rootDir = path.dirname(tsConfigPath);
		const proxyHost = proxyParseConfigHostForExtendConfigPaths(parseConfigHost);
		const config = ts.readJsonConfigFile(tsConfigPath, proxyHost.host.readFile);
		ts.parseJsonSourceFileConfigFileContent(config, proxyHost.host, rootDir, {}, tsConfigPath);

		const resolver = new CompilerOptionsResolver(parseConfigHost.fileExists);

		for (const extendPath of proxyHost.extendConfigPaths.reverse()) {
			try {
				const configFile = ts.readJsonConfigFile(extendPath, proxyHost.host.readFile);
				const obj = ts.convertToObject(configFile, []);
				const rawOptions: RawVueCompilerOptions = obj?.vueCompilerOptions ?? {};
				resolver.addConfig(rawOptions, path.dirname(configFile.fileName));
			}
			catch {}
		}

		const resolvedVueOptions = resolver.build();
		const parsed = ts.parseJsonSourceFileConfigFileContent(
			config,
			proxyHost.host,
			path.dirname(tsConfigPath),
			{},
			tsConfigPath,
			undefined,
			getAllExtensions(resolvedVueOptions)
				.map(extension => ({
					extension: extension.slice(1),
					isMixedContent: true,
					scriptKind: ts.ScriptKind.Deferred,
				})),
		);

		// fix https://github.com/vuejs/language-tools/issues/1786
		// https://github.com/microsoft/TypeScript/issues/30457
		// patching ts server broke with outDir + rootDir + composite/incremental
		parsed.options.outDir = undefined;

		return {
			...parsed,
			vueOptions: resolvedVueOptions,
		};
	}
	catch {
		// console.warn('Failed to resolve tsconfig path:', tsConfigPath, err);
		return {
			fileNames: [],
			options: {},
			vueOptions: getDefaultCompilerOptions(),
			errors: [],
		};
	}
}

function proxyParseConfigHostForExtendConfigPaths(parseConfigHost: ts.ParseConfigHost) {
	const extendConfigPaths: string[] = [];
	const host = new Proxy(parseConfigHost, {
		get(target, key) {
			if (key === 'readFile') {
				return (fileName: string) => {
					if (!fileName.endsWith('/package.json') && !extendConfigPaths.includes(fileName)) {
						extendConfigPaths.push(fileName);
					}
					return target.readFile(fileName);
				};
			}
			return target[key as keyof typeof target];
		},
	});
	return {
		host,
		extendConfigPaths,
	};
}

export class CompilerOptionsResolver {
	configRoots = new Set<string>();
	options: Omit<RawVueCompilerOptions, 'target' | 'globalTypesPath' | 'plugins'> = {};
	target: number | undefined;
	globalTypesPath: string | undefined;
	plugins: VueLanguagePlugin[] = [];

	constructor(
		public fileExists?: (path: string) => boolean,
	) {}

	addConfig(options: RawVueCompilerOptions, rootDir: string) {
		this.configRoots.add(rootDir);
		for (const key in options) {
			switch (key) {
				case 'target':
					if (options[key] === 'auto') {
						this.target = findVueVersion(rootDir);
					}
					else {
						this.target = options[key];
					}
					break;
				case 'globalTypesPath':
					if (options[key] !== undefined) {
						this.globalTypesPath = path.join(rootDir, options[key]);
					}
					break;
				case 'plugins':
					this.plugins = (options.plugins ?? [])
						.flatMap<VueLanguagePlugin>((pluginPath: string) => {
							try {
								const resolvedPath = resolvePath(pluginPath, rootDir);
								if (resolvedPath) {
									const plugin = require(resolvedPath);
									plugin.__moduleName = pluginPath;
									return plugin;
								}
								else {
									console.warn('[Vue] Load plugin failed:', pluginPath);
								}
							}
							catch (error) {
								console.warn('[Vue] Resolve plugin path failed:', pluginPath, error);
							}
							return [];
						});
					break;
				default:
					// @ts-expect-error
					this.options[key] = options[key];
					break;
			}
		}
		if (options.target === undefined) {
			this.target ??= findVueVersion(rootDir);
		}
	}

	build(defaults?: VueCompilerOptions) {
		defaults ??= getDefaultCompilerOptions(this.target, this.options.lib, this.options.strictTemplates);

		const resolvedOptions: VueCompilerOptions = {
			...defaults,
			...this.options,
			plugins: this.plugins,
			macros: {
				...defaults.macros,
				...this.options.macros,
			},
			composables: {
				...defaults.composables,
				...this.options.composables,
			},
			fallthroughComponentNames: [
				...defaults.fallthroughComponentNames,
				...this.options.fallthroughComponentNames ?? [],
			].map(hyphenateTag),
			// https://github.com/vuejs/vue-next/blob/master/packages/compiler-dom/src/transforms/vModel.ts#L49-L51
			// https://vuejs.org/guide/essentials/forms.html#form-input-bindings
			experimentalModelPropName: Object.fromEntries(
				Object.entries(
					this.options.experimentalModelPropName ?? defaults.experimentalModelPropName,
				).map(([k, v]) => [camelize(k), v]),
			),
		};

		if (resolvedOptions.globalTypesPath === noop) {
			if (this.fileExists && this.globalTypesPath === undefined) {
				const fileDirToGlobalTypesPath = new Map<string, string | undefined>();
				resolvedOptions.globalTypesPath = fileName => {
					const fileDir = path.dirname(fileName);
					if (fileDirToGlobalTypesPath.has(fileDir)) {
						return fileDirToGlobalTypesPath.get(fileDir);
					}

					const root = this.findNodeModulesRoot(fileDir, resolvedOptions.lib);
					const result = root
						? path.join(
							root,
							'node_modules',
							'.vue-global-types',
							getGlobalTypesFileName(resolvedOptions),
						)
						: undefined;

					fileDirToGlobalTypesPath.set(fileDir, result);
					return result;
				};
			}
			else {
				resolvedOptions.globalTypesPath = () => this.globalTypesPath;
			}
		}

		return resolvedOptions;
	}

	private findNodeModulesRoot(dir: string, lib: string) {
		while (!this.fileExists!(path.join(dir, 'node_modules', lib, 'package.json'))) {
			const parentDir = path.dirname(dir);
			if (dir === parentDir) {
				return;
			}
			dir = parentDir;
		}
		return dir;
	}
}

function findVueVersion(rootDir: string) {
	const resolvedPath = resolvePath('vue/package.json', rootDir);
	if (resolvedPath) {
		const vuePackageJson = require(resolvedPath);
		const versionNumbers = vuePackageJson.version.split('.');
		return Number(versionNumbers[0] + '.' + versionNumbers[1]);
	}
	else {
		// console.warn('Load vue/package.json failed from', folder);
	}
}

function resolvePath(scriptPath: string, root: string) {
	try {
		if (require?.resolve) {
			return require.resolve(scriptPath, { paths: [root] });
		}
		else {
			// console.warn('failed to resolve path:', scriptPath, 'require.resolve is not supported in web');
		}
	}
	catch {
		// console.warn(error);
	}
}

export function getDefaultCompilerOptions(target = 99, lib = 'vue', strictTemplates = false): VueCompilerOptions {
	return {
		target,
		lib,
		globalTypesPath: noop,
		extensions: ['.vue'],
		vitePressExtensions: [],
		petiteVueExtensions: [],
		jsxSlots: false,
		strictVModel: strictTemplates,
		strictCssModules: false,
		checkUnknownProps: strictTemplates,
		checkUnknownEvents: strictTemplates,
		checkUnknownDirectives: strictTemplates,
		checkUnknownComponents: strictTemplates,
		inferComponentDollarEl: false,
		inferComponentDollarRefs: false,
		inferTemplateDollarAttrs: false,
		inferTemplateDollarEl: false,
		inferTemplateDollarRefs: false,
		inferTemplateDollarSlots: false,
		skipTemplateCodegen: false,
		fallthroughAttributes: false,
		resolveStyleImports: false,
		resolveStyleClassNames: 'scoped',
		fallthroughComponentNames: [
			'Transition',
			'KeepAlive',
			'Teleport',
			'Suspense',
		],
		dataAttributes: [],
		htmlAttributes: ['aria-*'],
		optionsWrapper: target >= 2.7
			? [`(await import('${lib}')).defineComponent(`, `)`]
			: [`(await import('${lib}')).default.extend(`, `)`],
		macros: {
			defineProps: ['defineProps'],
			defineSlots: ['defineSlots'],
			defineEmits: ['defineEmits'],
			defineExpose: ['defineExpose'],
			defineModel: ['defineModel'],
			defineOptions: ['defineOptions'],
			withDefaults: ['withDefaults'],
		},
		composables: {
			useAttrs: ['useAttrs'],
			useCssModule: ['useCssModule'],
			useSlots: ['useSlots'],
			useTemplateRef: ['useTemplateRef', 'templateRef'],
		},
		plugins: [],
		experimentalModelPropName: {
			'': {
				input: true,
			},
			value: {
				input: { type: 'text' },
				textarea: true,
				select: true,
			},
		},
	};
}

export function writeGlobalTypes(
	vueOptions: VueCompilerOptions,
	writeFile: (fileName: string, data: string) => void,
) {
	const originalFn = vueOptions.globalTypesPath;
	if (!originalFn) {
		return;
	}
	const writed = new Set<string>();
	vueOptions.globalTypesPath = (fileName: string) => {
		const result = originalFn(fileName);
		if (result && !writed.has(result)) {
			writed.add(result);
			writeFile(result, generateGlobalTypes(vueOptions));
		}
		return result;
	};
}
