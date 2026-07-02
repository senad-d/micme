import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const nodeGlobals = {
	...globals.node,
	...globals.nodeBuiltin,
};

export default tseslint.config(
	{
		ignores: [
			".local/**",
			".micme/**",
			".pi/**",
			".trivycache/**",
			"build/**",
			"coverage/**",
			"dist/**",
			"micme-rec/**",
			"models/**",
			"node_modules/**",
			"odc-reports/**",
			"trivy-reports/**",
		],
	},
	{
		linterOptions: {
			reportUnusedDisableDirectives: "error",
		},
	},
	{
		files: ["**/*.{js,mjs,cjs,ts}"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: nodeGlobals,
		},
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"no-control-regex": "off",
		},
	},
	{
		files: ["**/*.ts"],
		rules: {
			"no-undef": "off",
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
		},
	},
);
