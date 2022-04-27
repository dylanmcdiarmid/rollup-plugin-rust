const $path = require("path");
const $toml = require("toml");
const { createFilter } = require("rollup-pluginutils");
const { glob, rm, mv, read, readString, exec, spawn, lock, debug } = require("./utils");
const { run_wasm_bindgen } = require("./wasm-bindgen");


async function get_target_dir(dir) {
    // TODO make this faster somehow ?
    const metadata = await exec("cargo metadata --format-version 1 --no-deps --color never", { cwd: dir });
    return JSON.parse(metadata).target_directory;
}


async function get_out_dir(dir, name, options) {
    const target_dir = await get_target_dir(dir);

    if (options.verbose) {
        debug(`Using target directory ${target_dir}`);
    }

    const out_dir = $path.resolve($path.join(target_dir, "rollup-plugin-rust", name));

    const wasm_path = $path.resolve($path.join(
        target_dir,
        "wasm32-unknown-unknown",
        (options.debug ? "debug" : "release"),
        name + ".wasm"
    ));

    if (options.verbose) {
        debug(`Using rustc output ${wasm_path}`);
        debug(`Using output directory ${out_dir}`);
    }

    await rm(out_dir);

    return { out_dir, wasm_path };
}


function validate_toml(toml) {
    if (toml.lib && Array.isArray(toml.lib["crate-type"]) && toml.lib["crate-type"].indexOf("cdylib") !== -1) {
        return;
    }

    throw new Error("Cargo.toml must use `crate-type = [\"cdylib\"]`");
}


async function run_cargo(dir, options) {
    let cargo_args = [
        "build",
        "--lib",
        "--target", "wasm32-unknown-unknown",
    ];

    if (!options.debug) {
        cargo_args.push("--release");
    }

    if (options.cargoArgs) {
        cargo_args = cargo_args.concat(options.cargoArgs);
    }

    if (options.verbose) {
        debug(`Running cargo ${cargo_args.join(" ")}`);
    }

    await spawn("cargo", cargo_args, { cwd: dir, stdio: "inherit" });
}


// Replace with @webassemblyjs/wasm-opt ?
async function run_wasm_opt(cx, out_dir, options) {
    const path = "index_bg.wasm";
    const tmp = "wasm_opt.wasm";

    // Needed to make wasm-opt work on Windows
    const wasm_opt_command = (process.platform === "win32" ? "wasm-opt.cmd" : "wasm-opt");

    const wasm_opt_args = [path, "--output", tmp].concat(options.wasmOptArgs);

    if (options.verbose) {
        debug(`Running ${wasm_opt_command} ${wasm_opt_args.join(" ")}`);
    }

    try {
        await spawn(wasm_opt_command, wasm_opt_args, { cwd: out_dir, stdio: "inherit" });

    } catch (e) {
        cx.warn("wasm-opt failed: " + e.message);
        return;
    }

    await mv($path.join(out_dir, tmp), $path.join(out_dir, path));
}


async function compile_js(cx, state, name, dir, out_dir, id, options) {
    // TODO use a randomly generated name ?
    const fake_dir = $path.resolve($path.join(dir, ".__rollup-plugin-rust__" + name));

    const import_path = `"./.__rollup-plugin-rust__${name}/index.js"`;

    const wasm_path = $path.join(out_dir, "index_bg.wasm");

    if (options.verbose) {
        debug(`Looking for wasm at ${wasm_path}`);
    }

    const wasm = await read(wasm_path);

    const is_entry = cx.getModuleInfo(id).isEntry;

    // This creates a mapping from the fake directory to the real directory
    state.fake_dirs.push({
        from: fake_dir,
        to: out_dir,
    });

    if (options.inlineWasm) {
        const base64_decode = `
            const base64codes = [62,0,0,0,63,52,53,54,55,56,57,58,59,60,61,0,0,0,0,0,0,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,0,0,0,0,0,0,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51];

            function getBase64Code(charCode) {
                return base64codes[charCode - 43];
            }

            function base64_decode(str) {
                let missingOctets = str.endsWith("==") ? 2 : str.endsWith("=") ? 1 : 0;
                let n = str.length;
                let result = new Uint8Array(3 * (n / 4));
                let buffer;

                for (let i = 0, j = 0; i < n; i += 4, j += 3) {
                    buffer =
                        getBase64Code(str.charCodeAt(i)) << 18 |
                        getBase64Code(str.charCodeAt(i + 1)) << 12 |
                        getBase64Code(str.charCodeAt(i + 2)) << 6 |
                        getBase64Code(str.charCodeAt(i + 3));
                    result[j] = buffer >> 16;
                    result[j + 1] = (buffer >> 8) & 0xFF;
                    result[j + 2] = buffer & 0xFF;
                }

                return result.subarray(0, result.length - missingOctets);
            }
        `;

        const wasm_string = JSON.stringify(wasm.toString("base64"));

        if (is_entry) {
            return {
                code: `
                    import init from ${import_path};

                    ${base64_decode}

                    const wasm_code = base64_decode(${wasm_string});

                    init(wasm_code).catch(console.error);
                `,
                map: { mappings: '' },
            };

        } else {
            return {
                code: `
                    import * as exports from ${import_path};

                    ${base64_decode}

                    const wasm_code = base64_decode(${wasm_string});

                    export default async () => {
                        await exports.default(wasm_code);
                        return exports;
                    };
                `,
                map: { mappings: '' },
                moduleSideEffects: false,
            };
        }

    } else {
        let fileId;

        if (options.outDir == null) {
            fileId = cx.emitFile({
                type: "asset",
                source: wasm,
                name: name + ".wasm"
            });

        } else {
            cx.warn("The outDir option is deprecated, use output.assetFileNames instead");

            const wasm_name = $path.posix.join(options.outDir, name + ".wasm");

            fileId = cx.emitFile({
                type: "asset",
                source: wasm,
                fileName: wasm_name
            });
        }

        state.file_ids.add(fileId);

        let import_wasm = `import.meta.ROLLUP_FILE_URL_${fileId}`;

        let prelude = "";

        if (options.nodejs) {
            prelude = `
            function loadFile(url) {
                return new Promise((resolve, reject) => {
                    require("fs").readFile(url, (err, data) => {
                        if (err) {
                            reject(err);

                        } else {
                            resolve(data);
                        }
                    });
                });
            }`;

            import_wasm = `loadFile(${import_wasm})`;
        }

        if (is_entry) {
            return {
                code: `
                    import init from ${import_path};
                    ${prelude}

                    init(${import_wasm}).catch(console.error);
                `,
                map: { mappings: '' },
            };

        } else {
            return {
                code: `
                    import * as exports from ${import_path};
                    ${prelude}

                    export default async (opt = {}) => {
                        let {importHook, serverPath} = opt;

                        let path = ${import_wasm};

                        if (serverPath != null) {
                            path = serverPath + /[^\\/\\\\]*$/.exec(path)[0];
                        }

                        if (importHook != null) {
                            path = importHook(path);
                        }

                        await exports.default(path);
                        return exports;
                    };
                `,
                map: { mappings: '' },
                moduleSideEffects: false,
            };
        }
    }
}


async function compile_rust(cx, state, dir, source, id, options) {
    const toml = $toml.parse(source);

    validate_toml(toml);

    // TODO does it need to do more transformations on the name ?
    const name = toml.package.name.replace(/\-/g, "_");

    try {
        // TODO what if it tries to build the same crate multiple times ?
        // TODO maybe it can run `cargo fetch` without locking ?
        return await lock(async function () {
            await run_cargo(dir, options);

            const { wasm_path, out_dir } = await get_out_dir(dir, name, options);

            await run_wasm_bindgen(dir, wasm_path, out_dir, options);

            if (!options.debug) {
                await run_wasm_opt(cx, out_dir, options);
            }

            return compile_js(cx, state, name, dir, out_dir, id, options);
        });

    } catch (e) {
        if (options.verbose) {
            throw e;

        } else {
            const e = new Error("Rust compilation failed");
            e.stack = null;
            throw e;
        }
    }
}


async function watch_files(cx, dir, options) {
    if (options.watch) {
        const matches = await Promise.all(options.watchPatterns.map(function (pattern) {
            return glob(pattern, dir);
        }));

        // TODO deduplicate matches ?
        matches.forEach(function (files) {
            files.forEach(function (file) {
                cx.addWatchFile(file);
            });
        });
    }
}


async function build(cx, state, source, id, options) {
    const dir = $path.dirname(id);

    const [output] = await Promise.all([
        compile_rust(cx, state, dir, source, id, options),
        watch_files(cx, dir, options),
    ]);

    return output;
}


// This checks if the file is fake or not
function is_fake_id(id, importer) {
    if (importer) {
        if (id.startsWith("./.__rollup-plugin-rust__")) {
            return true;

        // TODO make this faster somehow ?
        } else if (id[0] === "." && importer.includes($path.sep + ".__rollup-plugin-rust__")) {
            return true;
        }
    }

    return false;
}


module.exports = function rust(options = {}) {
    // TODO should the filter affect the watching ?
    // TODO should the filter affect the Rust compilation ?
    const filter = createFilter(options.include, options.exclude);

    const state = {
        file_ids: new Set(),
        fake_dirs: [],
    };

    if (options.watchPatterns == null) {
        options.watchPatterns = [
            "src/**"
        ];
    }

    if (options.importHook == null) {
        options.importHook = function (path) { return JSON.stringify(path); };
    }

    if (options.serverPath == null) {
        options.serverPath = "";
    }

    if (options.wasmOptArgs == null) {
        // TODO figure out better optimization options ?
        options.wasmOptArgs = ["-O"];
    }

    if (options.inlineWasm == null) {
        options.inlineWasm = false;
    }

    if (options.verbose == null) {
        options.verbose = false;
    }

    if (options.nodejs == null) {
        options.nodejs = false;
    }

    return {
        name: "rust",

        buildStart(rollup) {
            state.file_ids.clear();
            state.fake_dirs.length = 0;

            if (options.wasmPackPath !== undefined) {
                this.warn("The wasmPackPath option is deprecated and no longer works");
            }

            if (this.meta.watchMode || rollup.watch) {
                if (options.watch == null) {
                    options.watch = true;
                }

                if (options.debug == null) {
                    options.debug = true;
                }
            }
        },

        // This allows Rollup to resolve fake paths
        resolveId(id, importer) {
            if (is_fake_id(id, importer)) {
                const path = $path.join($path.dirname(importer), id);

                if (options.verbose) {
                    debug(`Resolving path ${path}`);
                }

                return {
                    id: path,
                    moduleSideEffects: false,
                };
            }

            return null;
        },

        // This maps the fake paths to real paths on disk and loads them
        load(id) {
            const len = state.fake_dirs.length;

            for (let i = 0; i < len; ++i) {
                const dir = state.fake_dirs[i];

                // If the path is fake...
                if (id.startsWith(dir.from)) {
                    const path = dir.to + id.slice(dir.from.length);

                    if (options.verbose) {
                        debug(`Loading file ${path}`);
                    }

                    return readString(path);
                }
            }

            return null;
        },

        transform(source, id) {
            if ($path.basename(id) === "Cargo.toml" && filter(id)) {
                return build(this, state, source, id, options);

            } else {
                return null;
            }
        },

        resolveFileUrl(info) {
            if (state.file_ids.has(info.referenceId)) {
                return options.importHook(options.serverPath + info.fileName);

            } else {
                return null;
            }
        },
    };
};
