import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(root, "src");
const dist = path.join(root, "dist");

const COPY = ["manifest.json", "rules.json", "content.js", "options.html", "options.js", "INSTALL.txt"];

function copyStatic() {
  fs.mkdirSync(dist, { recursive: true });
  for (const file of COPY) {
    fs.copyFileSync(path.join(src, file), path.join(dist, file));
  }
}

/**
 * The SDK's credential chain reaches for node:fs / node:path to load `ant auth`
 * profiles from disk. Those paths are guarded at runtime and never taken in a
 * browser — we pass an explicit apiKey — but esbuild still has to resolve the
 * imports, so hand it an empty module for anything Node-only.
 */
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

/**
 * The service worker is the only file that needs bundling — it imports the SDK.
 * Minified because Chrome re-parses this file on every extension reload and every
 * cold start of the worker; keepNames preserves error-class names for instanceof
 * checks and readable stack traces.
 */
const bundleOptions = {
  entryPoints: [path.join(src, "background.js")],
  outfile: path.join(dist, "background.js"),
  bundle: true,
  minify: true,
  keepNames: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  plugins: [stubNodeBuiltins],
  logLevel: "info",
};

const watch = process.argv.includes("--watch");

copyStatic();

if (watch) {
  const ctx = await esbuild.context(bundleOptions);
  await ctx.watch();
  fs.watch(src, (_event, filename) => {
    if (COPY.includes(filename)) {
      copyStatic();
      console.log(`copied ${filename}`);
    }
  });
  console.log("watching… load dist/ as an unpacked extension");
} else {
  await esbuild.build(bundleOptions);
  console.log("built dist/ — load it at chrome://extensions (Developer mode → Load unpacked)");
}
