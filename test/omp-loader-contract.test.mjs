import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = new URL("../", import.meta.url);
const legacyTui = /^@(?:earendil-works|mariozechner)\/pi-tui(?:\/|$)/;

function collectLiteralSpecifiers(node, specifiers) {
	let specifier;
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		specifier = node.moduleSpecifier;
	} else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
		(ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
		specifier = node.arguments[0];
	}
	if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
	ts.forEachChild(node, (child) => collectLiteralSpecifiers(child, specifiers));
}

// Regression for OMP 19.2's source scan. It follows literal imports even in an
// inactive branch, so a Pi-only dependency must not be reachable on that graph.
// This is a source contract, not a real OMP load or UI test.
test("the declared extension has no legacy Pi TUI imports in OMP's literal module graph", () => {
	const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
	assert.ok(manifest.pi.extensions.length > 0);
	const pending = manifest.pi.extensions.map((entrypoint) => new URL(entrypoint, packageRoot));
	const seen = new Set();
	const legacyImports = [];

	while (pending.length) {
		const url = pending.pop();
		if (seen.has(url.href)) continue;
		seen.add(url.href);
		const path = fileURLToPath(url);
		const source = ts.createSourceFile(path, readFileSync(url, "utf8"), ts.ScriptTarget.Latest);
		const specifiers = [];
		collectLiteralSpecifiers(source, specifiers);
		for (const specifier of specifiers) {
			if (legacyTui.test(specifier)) legacyImports.push(`${relative(fileURLToPath(packageRoot), path)} imports ${specifier}`);
			if (specifier.startsWith("./") || specifier.startsWith("../")) pending.push(new URL(specifier, url));
		}
	}

	assert.deepEqual(legacyImports, []);
});
