import type { VueVirtualCode } from '@vue/language-core';
import { camelize, capitalize } from '@vue/shared';
import * as path from 'path-browserify';
import type * as ts from 'typescript';

export function getComponentType(
	ts: typeof import('typescript'),
	languageService: ts.LanguageService,
	vueCode: VueVirtualCode,
	components: NonNullable<ReturnType<typeof getVariableType>>,
	fileName: string,
	tag: string,
) {
	const program = languageService.getProgram()!;
	const checker = program.getTypeChecker();
	const name = tag.split('.');

	let componentSymbol = components.type.getProperty(name[0])
		?? components.type.getProperty(camelize(name[0]))
		?? components.type.getProperty(capitalize(camelize(name[0])));
	let componentType: ts.Type | undefined;

	if (!componentSymbol) {
		const name = getSelfComponentName(fileName);
		if (name === capitalize(camelize(tag))) {
			componentType = getVariableType(ts, languageService, vueCode, '__VLS_self')?.type;
		}
	} else {
		componentType = checker.getTypeOfSymbolAtLocation(componentSymbol, components.node);
		for (let i = 1; i < name.length; i++) {
			componentSymbol = componentType.getProperty(name[i]);
			if (componentSymbol) {
				componentType = checker.getTypeOfSymbolAtLocation(componentSymbol, components.node);
			}
		}
	}

	return componentType;
}

export function getSelfComponentName(fileName: string) {
	const baseName = path.basename(fileName);
	return capitalize(camelize(baseName.slice(0, baseName.lastIndexOf('.'))));
}

export function getVariableType(
	ts: typeof import('typescript'),
	languageService: ts.LanguageService,
	vueCode: VueVirtualCode,
	name: string,
) {
	const program = languageService.getProgram()!;

	const tsSourceFile = program.getSourceFile(vueCode.fileName);
	if (tsSourceFile) {
		const checker = program.getTypeChecker();
		const node = searchVariableDeclarationNode(ts, tsSourceFile, name);
		if (node) {
			return {
				node: node,
				type: checker.getTypeAtLocation(node),
			};
		}
	}
}

function searchVariableDeclarationNode(
	ts: typeof import('typescript'),
	sourceFile: ts.SourceFile,
	name: string,
) {
	let result: ts.Node | undefined;
	walk(sourceFile);
	return result;

	function walk(node: ts.Node) {
		if (result) {
			return;
		} else if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
			result = node;
		} else {
			node.forEachChild(walk);
		}
	}
}
