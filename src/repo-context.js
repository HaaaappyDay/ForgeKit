import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { runProcess } from "./process-runner.js";

const MAX_README_BYTES = 20_000;
const MAX_TREE_ENTRIES = 200;
const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt"
]);
const SKIP_DIRS = new Set([".git", ".forgekit", "node_modules", "coverage", "dist", "build"]);

async function readTextIfExists(path, maxBytes) {
  try {
    const buffer = await readFile(path);
    return buffer.toString("utf8", 0, Math.min(buffer.length, maxBytes));
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function findReadme(projectRoot) {
  const entries = await readdir(projectRoot);
  const name = entries.find((entry) => /^readme(\.|$)/i.test(entry));
  if (!name) return null;
  return {
    path: name,
    excerpt: await readTextIfExists(join(projectRoot, name), MAX_README_BYTES)
  };
}

async function collectTree(projectRoot, dir = projectRoot, output = []) {
  if (output.length >= MAX_TREE_ENTRIES) return output;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_TREE_ENTRIES) break;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const rel = relative(projectRoot, path);
    output.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) {
      await collectTree(projectRoot, path, output);
    }
  }
  return output;
}

async function collectConfigSummary(projectRoot) {
  const entries = await readdir(projectRoot);
  const configs = [];
  for (const name of entries) {
    if (!CONFIG_FILE_NAMES.has(name)) continue;
    const path = join(projectRoot, name);
    const info = await stat(path);
    configs.push({
      path: name,
      bytes: info.size
    });
  }
  return configs;
}

async function gitStatus(projectRoot) {
  const result = await runProcess("git", ["status", "--short"], {
    cwd: projectRoot,
    env: process.env,
    timeoutMs: 5000
  });
  if (result.exitCode !== 0) {
    return {
      available: false,
      output: result.stderr.trim()
    };
  }
  return {
    available: true,
    output: result.stdout.trim()
  };
}

export async function collectRepoContext(projectRoot) {
  const [readme, tree, configs, git] = await Promise.all([
    findReadme(projectRoot),
    collectTree(projectRoot),
    collectConfigSummary(projectRoot),
    gitStatus(projectRoot)
  ]);

  return {
    schema_version: "repo-summary.v1",
    generated_at: new Date().toISOString(),
    readme,
    tree,
    tree_truncated: tree.length >= MAX_TREE_ENTRIES,
    config_files: configs,
    git_status: git
  };
}

