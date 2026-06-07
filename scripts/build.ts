/**
 * build — produce a self-contained, publishable `dist/`:
 *   dist/cli.js      bundled bridge CLI (Bun target; protocol inlined), executable
 *   dist/web/        prebuilt app.js + index.html/sw.js/manifest/icons
 *   dist/package.json  generated publish manifest (name: cmux-mobile, bin, MIT)
 *   dist/{README.md,LICENSE}
 *
 *   bun run scripts/build.ts        (or: bun run build)
 *
 * The root stays `private`; `dist/` is the only publishable artifact and is the
 * code-only payload for a future public release. Publish later with `npm publish dist/`.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.1.0";
const repo = join(import.meta.dir, "..");
const dist = join(repo, "dist");
const distWeb = join(dist, "web");

rmSync(dist, { recursive: true, force: true });
mkdirSync(distWeb, { recursive: true });

// 1) Bundle the CLI for Bun (inlines @cmux-mobile/protocol).
const cli = await Bun.build({
  entrypoints: [join(repo, "packages/bridge/src/cli.ts")],
  outdir: dist,
  target: "bun",
  naming: "[name].[ext]",
});
if (!cli.success) throw new Error("CLI build failed:\n" + cli.logs.map(String).join("\n"));

// Ensure the bin is a runnable executable with a Bun shebang.
const cliPath = join(dist, "cli.js");
let cliText = readFileSync(cliPath, "utf8");
if (!cliText.startsWith("#!")) {
  cliText = "#!/usr/bin/env bun\n" + cliText;
  writeFileSync(cliPath, cliText);
}
chmodSync(cliPath, 0o755);

// 2) Prebuild the web bundle, then copy the static public assets alongside it.
cpSync(join(repo, "packages/web/public"), distWeb, { recursive: true });
const web = await Bun.build({
  entrypoints: [join(repo, "packages/web/src/app.ts")],
  outdir: distWeb,
  target: "browser",
  naming: "[name].[ext]",
  minify: true,
});
if (!web.success) throw new Error("web build failed:\n" + web.logs.map(String).join("\n"));

// 3) Generate the publish manifest + carry README/LICENSE.
const pkg = {
  name: "cmux-mobile",
  version: VERSION,
  description: "Drive your local cmux terminal/agent sessions from an iPhone/iPad over your own Tailscale.",
  type: "module",
  bin: { "cmux-mobile": "cli.js" },
  files: ["cli.js", "web", "README.md", "LICENSE"],
  engines: { bun: ">=1.0" },
  license: "MIT",
  keywords: ["cmux", "terminal", "mobile", "tailscale", "pwa", "bun"],
};
writeFileSync(join(dist, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
for (const f of ["README.md", "LICENSE"]) {
  try {
    cpSync(join(repo, f), join(dist, f));
  } catch {
    console.warn(`note: ${f} not found — skipped`);
  }
}

console.log(`built dist/ → cli.js + web/ + package.json (cmux-mobile@${VERSION})`);
