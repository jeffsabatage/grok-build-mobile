import fs from "node:fs";
import path from "node:path";

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".gradle", "__pycache__",
  ".next", "coverage", ".cache", "out", "target",
]);

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function listWorkspace(cwd, rel = "") {
  const root = path.resolve(String(cwd || ""));
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: "cwd not found" };
  }
  const target = path.resolve(root, String(rel || ".").replace(/^[/\\]+/, ""));
  if (!inside(root, target) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return { ok: false, error: "path not allowed" };
  }
  const relPosix = path.relative(root, target).split(path.sep).join("/");
  let names = [];
  try {
    names = fs.readdirSync(target);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const entries = [];
  for (const name of names) {
    if (SKIP.has(name)) continue;
    if (name === "." || name === "..") continue;
    const full = path.join(target, name);
    let dir = false;
    try {
      dir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    const childRel = path.relative(root, full).split(path.sep).join("/");
    entries.push({ name, dir, path: childRel });
    if (entries.length >= 150) break;
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const parent = relPosix ? relPosix.split("/").slice(0, -1).join("/") : null;
  return {
    ok: true,
    cwd: root,
    rel: relPosix,
    parent: relPosix ? parent : null,
    entries,
  };
}

export function searchWorkspace(cwd, query, limit = 40) {
  const needle = String(query || "").trim().toLowerCase();
  if (needle.length < 2) return { ok: true, q: needle, entries: [] };
  const root = path.resolve(String(cwd || ""));
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: "cwd not found" };
  }
  const hits = [];
  const stack = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (stack.length && hits.length < limit && seen < 800) {
    const { dir, depth } = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      seen++;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      const match = name.toLowerCase().includes(needle) || rel.toLowerCase().includes(needle);
      if (st.isDirectory()) {
        if (match) hits.push({ name, dir: true, path: rel });
        if (depth < 5) stack.push({ dir: full, depth: depth + 1 });
      } else if (match) {
        hits.push({ name, dir: false, path: rel });
      }
      if (hits.length >= limit || seen >= 800) break;
    }
  }
  hits.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.length - b.path.length || a.name.localeCompare(b.name));
  return { ok: true, q: needle, entries: hits };
}
