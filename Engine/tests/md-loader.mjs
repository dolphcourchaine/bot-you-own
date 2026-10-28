// Lets plain Node import *.md and *.json the way the Worker bundler does, so
// tests can assemble the prompt without wrangler. Usage: node --import ./Engine/tests/md-loader.mjs …
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, context, next) {
    if (/\.(md|txt|csv)$/.test(url)) { const { readFileSync } = await import("node:fs"); const { fileURLToPath } = await import("node:url");
      return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(readFileSync(fileURLToPath(url), "utf8")) + ";" }; }
    if (url.endsWith(".json")) return next(url, { ...context, importAttributes: { type: "json" } });
    return next(url, context);
  }`), pathToFileURL("./"));
