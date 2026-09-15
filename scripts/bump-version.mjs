import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.GR_VER || process.argv[2];
const title = process.env.GR_TITLE || process.argv[3];
let notes = JSON.parse(process.env.GR_NOTES || "[]");
if (!Array.isArray(notes)) notes = [notes];
const force = (process.env.GR_FORCE || "false") === "true";
if (!version || !title) {
  console.error("usage: set GR_VER GR_TITLE GR_NOTES GR_FORCE, then bump-version.mjs");
  process.exit(1);
}

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}
function save(rel, obj) {
  fs.writeFileSync(path.join(root, rel), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

for (const rel of ["package.json", "android-app/package.json"]) {
  const j = load(rel);
  j.version = version;
  save(rel, j);
}

const manifest = load("app-manifest.json");
manifest.latestVersion = version;
manifest.releaseNotes = `v${version}: ${title}`;
manifest.publishedAt = new Date().toISOString();
manifest.forceUpdate = force;
save("app-manifest.json", manifest);

const cl = load("changelog.json");
save("changelog.json", [
  { version, date: new Date().toISOString().slice(0, 10), title, notes },
  ...cl,
]);
console.log("bumped json to", version);
