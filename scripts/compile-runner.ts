/**
 * Bun build script for the socverify-runner binary.
 *
 * Uses `Bun.build()` with the engine's `createLegacyPiVirtualModulePlugin()`
 * so that the virtual `omp-legacy-pi-modules` specifier (referenced by
 * `legacy-pi-compat.ts` when `IS_COMPILED_BINARY` is true) is resolved at
 * compile time.
 *
 * Invoked by `scripts/build-runner.mjs` after Bun is discovered / downloaded.
 *
 * Usage:  bun scripts/compile-runner.ts [--outfile <path>]
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

// Bun provides `import.meta.dir` — the absolute directory of the current module.
const SCRIPT_DIR = import.meta.dir;
const ROOT = resolve(SCRIPT_DIR, "..");

const entrypoint = join(ROOT, "runner", "index.ts");
const defaultOutfile = join(
	ROOT,
	"resources",
	"binaries",
	process.platform === "win32" ? "socverify-runner.exe" : "socverify-runner",
);

// Parse --outfile argument (override default)
const outfileArgIdx = process.argv.indexOf("--outfile");
const outfile =
	outfileArgIdx !== -1 && process.argv[outfileArgIdx + 1]
		? resolve(process.argv[outfileArgIdx + 1]!)
		: defaultOutfile;

const ENGINE_CODING_AGENT = join(ROOT, "engine", "oh-my-pi", "packages", "coding-agent");
const REPO_ROOT = join(ROOT, "engine", "oh-my-pi");

// External deps that should not be bundled (same as engine's compile-binary.ts)
const COMPILED_EXTERNAL_DEPENDENCIES = ["fastembed", "onnxruntime-node"];

async function main(): Promise<void> {
	console.log(`[compile-runner] Entrypoint: ${entrypoint}`);
	console.log(`[compile-runner] Outfile: ${outfile}`);
	console.log(`[compile-runner] CWD: ${ENGINE_CODING_AGENT}`);

	// Dynamically import the engine's virtual module plugin.
	// This resolves the `omp-legacy-pi-modules` specifier at compile time.
	const pluginPath = join(ENGINE_CODING_AGENT, "scripts", "legacy-pi-virtual-module.ts");
	const { createLegacyPiVirtualModulePlugin } = await import(pluginPath);
	const plugin = await createLegacyPiVirtualModulePlugin();
	console.log("[compile-runner] Loaded legacy-pi virtual module plugin");

	// Ensure output directory exists
	const outDir = dirname(outfile);
	if (!existsSync(outDir)) {
		mkdirSync(outDir, { recursive: true });
	}

	const output = await Bun.build({
		entrypoints: [entrypoint],
		root: REPO_ROOT,
		external: [...COMPILED_EXTERNAL_DEPENDENCIES],
		define: {
			"process.env.PI_COMPILED": JSON.stringify("true"),
		},
		minify: {
			identifiers: false,
			keepNames: true,
		},
		plugins: [plugin],
		compile: {
			outfile,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
		throw: false,
	});

	if (!output.success) {
		const logs = output.logs.map((log) => log.message ?? String(log)).join("\n");
		console.error(`[compile-runner] Build failed:\n${logs}`);
		process.exit(1);
	}

	if (!existsSync(outfile)) {
		console.error(`[compile-runner] ERROR: Output binary not found at ${outfile}`);
		process.exit(1);
	}

	console.log(`[compile-runner] Built successfully: ${outfile}`);
}

await main();
