/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

process.env.MOCHA_COLORS = '1'; // Force colors (note that this must come before any mocha imports)

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import glob from 'glob';
import minimatch from 'minimatch';
import * as module from 'module';
import Mocha from 'mocha';
// const coverage = require('../coverage');
import _optimist from 'optimist';
import { fileURLToPath, pathToFileURL } from 'url';

const optimist = _optimist
	.usage('Run the Code tests. All mocha options apply.')
	.describe('build', 'Run from out-build').boolean('build')
	.describe('run', 'Run a single file').string('run')
	.describe('coverage', 'Generate a coverage report').boolean('coverage')
	.describe('esm', 'Assume ESM output').boolean('esm')
	.alias('h', 'help').boolean('h')
	.describe('h', 'Show help');


const TEST_GLOB = '**/test/**/*.test.js';

const excludeGlobs = [
	'**/{browser,electron-sandbox,electron-main}/**/*.test.js',
	'**/vs/platform/environment/test/node/nativeModules.test.js', // native modules are compiled against Electron and this test would fail with node.js
	'**/vs/base/parts/storage/test/node/storage.test.js', // same as above, due to direct dependency to sqlite native module
	'**/vs/workbench/contrib/testing/test/**' // flaky (https://github.com/microsoft/vscode/issues/137853)
];

/**
 * @type {{ build: boolean; run: string; runGlob: string; coverage: boolean; help: boolean; esm: boolean; }}
 */
const argv = optimist.argv;

if (argv.help) {
	optimist.showHelp();
	process.exit(1);
}

// const REPO_ROOT = path.join(__dirname, '../../../');
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const out = argv.build ? 'out-build' : 'out';
const src = path.join(REPO_ROOT, out);
const baseUrl = pathToFileURL(src);


const majorRequiredNodeVersion = `v${/^target\s+"([^"]+)"$/m.exec(fs.readFileSync(path.join(REPO_ROOT, 'remote', '.yarnrc'), 'utf8'))[1]}`.substring(0, 3);
const currentMajorNodeVersion = process.version.substring(0, 3);
if (majorRequiredNodeVersion !== currentMajorNodeVersion) {
	console.error(`node.js unit tests require a major node.js version of ${majorRequiredNodeVersion} (your version is: ${currentMajorNodeVersion})`);
	process.exit(1);
}

function main() {

	// VSCODE_GLOBALS: node_modules
	const _require = module.createRequire(import.meta.url);
	globalThis._VSCODE_NODE_MODULES = new Proxy(Object.create(null), { get: (_target, mod) => _require(String(mod)) });

	// VSCODE_GLOBALS: package/product.json
	globalThis._VSCODE_PRODUCT_JSON = _require(`${REPO_ROOT}/product.json`);
	globalThis._VSCODE_PACKAGE_JSON = _require(`${REPO_ROOT}/package.json`);

	// VSCODE_GLOBALS: file root
	globalThis._VSCODE_FILE_ROOT = baseUrl.href;

	// Test file operations that are common across platforms. Used for test infra, namely snapshot tests
	Object.assign(globalThis, {
		__readFileInTests: (/** @type {string} */ path) => fs.promises.readFile(path, 'utf-8'),
		__writeFileInTests: (/** @type {string} */ path, /** @type {BufferEncoding} */ contents) => fs.promises.writeFile(path, contents),
		__readDirInTests: (/** @type {string} */ path) => fs.promises.readdir(path),
		__unlinkInTests: (/** @type {string} */ path) => fs.promises.unlink(path),
		__mkdirPInTests: (/** @type {string} */ path) => fs.promises.mkdir(path, { recursive: true }),
	});

	process.on('uncaughtException', function (e) {
		console.error(e.stack || e);
	});

	/**
	 * @param modules
	 * @param onLoad
	 * @param onError
	 */
	const loader = function (modules, onLoad, onError) {

		modules = modules.filter(mod => {
			if (mod.endsWith('css.build.test')) {
				// AMD ONLY, ignore for ESM
				return false;
			}
			return true;
		});

		const loads = modules.map(mod => import(`${baseUrl}/${mod}.js`).catch(err => {
			console.error(`FAILED to load ${mod} as ${baseUrl}/${mod}.js`);
			throw err;
		}));
		Promise.all(loads).then(onLoad, onError);
	};


	let didErr = false;
	const write = process.stderr.write;
	process.stderr.write = function (...args) {
		didErr = didErr || !!args[0];
		return write.apply(process.stderr, args);
	};


	const runner = new Mocha({
		ui: 'tdd'
	});

	/**
	 * @param modules
	 */
	async function loadModules(modules) {
		for (const file of modules) {
			runner.suite.emit(Mocha.Suite.constants.EVENT_FILE_PRE_REQUIRE, globalThis, file, runner);
			const m = await new Promise((resolve, reject) => loader([file], resolve, reject));
			runner.suite.emit(Mocha.Suite.constants.EVENT_FILE_REQUIRE, m, file, runner);
			runner.suite.emit(Mocha.Suite.constants.EVENT_FILE_POST_REQUIRE, globalThis, file, runner);
		}
	}

	/** @type { null|((callback:(err:any)=>void)=>void) } */
	let loadFunc = null;

	if (argv.runGlob) {
		loadFunc = (cb) => {
			const doRun = /** @param tests */(tests) => {
				const modulesToLoad = tests.map(test => {
					if (path.isAbsolute(test)) {
						test = path.relative(src, path.resolve(test));
					}

					return test.replace(/(\.js)|(\.d\.ts)|(\.js\.map)$/, '');
				});
				loadModules(modulesToLoad).then(() => cb(null), cb);
			};

			glob(argv.runGlob, { cwd: src }, function (err, files) { doRun(files); });
		};
	} else if (argv.run) {
		const tests = (typeof argv.run === 'string') ? [argv.run] : argv.run;
		const modulesToLoad = tests.map(function (test) {
			test = test.replace(/^src/, 'out');
			test = test.replace(/\.ts$/, '.js');
			return path.relative(src, path.resolve(test)).replace(/(\.js)|(\.js\.map)$/, '').replace(/\\/g, '/');
		});
		loadFunc = (cb) => {
			loadModules(modulesToLoad).then(() => cb(null), cb);
		};
	} else {
		loadFunc = (cb) => {
			glob(TEST_GLOB, { cwd: src }, function (err, files) {
				/** @type {string[]} */
				const modules = [];
				for (const file of files) {
					if (!excludeGlobs.some(excludeGlob => minimatch(file, excludeGlob))) {
						modules.push(file.replace(/\.js$/, ''));
					}
				}
				loadModules(modules).then(() => cb(null), cb);
			});
		};
	}

	loadFunc(function (err) {
		if (err) {
			console.error(err);
			return process.exit(1);
		}

		process.stderr.write = write;

		if (!argv.run && !argv.runGlob) {
			// set up last test
			Mocha.suite('Loader', function () {
				test('should not explode while loading', function () {
					assert.ok(!didErr, 'should not explode while loading');
				});
			});
		}

		// report failing test for every unexpected error during any of the tests
		const unexpectedErrors = [];
		Mocha.suite('Errors', function () {
			test('should not have unexpected errors in tests', function () {
				if (unexpectedErrors.length) {
					unexpectedErrors.forEach(function (stack) {
						console.error('');
						console.error(stack);
					});

					assert.ok(false);
				}
			});
		});

		// replace the default unexpected error handler to be useful during tests
		import(`${baseUrl}/vs/base/common/errors.js`).then(errors => {
			errors.setUnexpectedErrorHandler(function (err) {
				const stack = (err && err.stack) || (new Error().stack);
				unexpectedErrors.push((err && err.message ? err.message : err) + '\n' + stack);
			});

			// fire up mocha
			runner.run(failures => process.exit(failures ? 1 : 0));
		});
	});
}

main();