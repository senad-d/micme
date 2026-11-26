import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = new URL("../", import.meta.url);
const sourceRoot = new URL("src/", packageRoot);
const legacyTui = /^@(?:earendil-works|mariozechner)\/pi-tui(?:\/|$)/;
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));

function collectLiteralSpecifiers(node, specifiers) {
	let specifier;
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		specifier = node.moduleSpecifier;
	} else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
		(ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
		specifier = node.arguments[0];
	}
	if (specifier && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
	ts.forEachChild(node, (child) => collectLiteralSpecifiers(child, specifiers));
}

// A loader that scans runtime imports can follow literal specifiers even in
// inactive branches. This checks the source boundary, not a host's execution.
test("the declared extension has no legacy Pi TUI imports in its literal runtime graph", () => {
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

test("the extension registers /micme without resolving its legacy Pi TUI peer", async (t) => {
	const requests = [];
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (legacyTui.test(specifier) && context.parentURL?.startsWith(sourceRoot.href)) {
				requests.push(context.parentURL);
				throw new Error(`Legacy Pi TUI is unavailable to Micme: ${context.parentURL}`);
			}
			return nextResolve(specifier, context);
		},
	});
	t.after(() => hooks.deregister());
	const commands = new Map();
	const events = new Map();
	const renderers = new Map();
	const { default: factory } = await import(new URL(manifest.pi.extensions[0], packageRoot));
	await factory({
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut() {},
		on: (name, handler) => events.set(name, handler),
		registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
	});
	assert.ok(commands.get("micme"), "Micme command was not registered");
	assert.ok(renderers.has("micme-devices"), "device renderer was not registered");

	const notifications = [];
	const ctx = { mode: "rpc", ui: { notify: (...args) => notifications.push(args) } };
	await events.get("session_start")({}, ctx);
	await commands.get("micme").handler("conf", ctx);
	assert.deepEqual(notifications, [["/micme conf requires interactive TUI mode.", "warning"]]);
	assert.deepEqual(requests, []);
});
