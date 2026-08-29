/**
 * Role prompt discovery (PLAN §4, §6).
 *
 * Role prompts live as markdown files with YAML-lite frontmatter in the
 * package agents directory: researcher.md, planner.md, developer.md,
 * test-writer.md, test-runner.md, reviewer.md, committer.md. Frontmatter is
 * limited to `key: value` lines; role ids map to file names kebab-case
 * (testWriter -> test-writer.md).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RolePrompt {
  role: string;
  prompt: string;
  model?: string;
  tools?: string[];
}

/** Maps a role id (testWriter) to its file name (test-writer.md). */
function roleFileName(role: string): string {
  const kebab = role
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  return `${kebab}.md`;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses YAML-lite frontmatter: `---` delimited `key: value` lines only.
 * Values are plain strings (quotes stripped); no nesting, lists, or typing.
 * Without valid frontmatter the whole input is the body and data is empty.
 */
export function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: md };
  const data: Record<string, string> = {};
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") {
      close = i;
      break;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    data[key] = stripQuotes(line.slice(idx + 1).trim());
  }
  if (close === -1) return { data: {}, body: md };
  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n/, "");
  return { data, body };
}

/** Loads `<agentsDir>/<role>.md`; returns null when missing or empty-bodied. */
export function loadRolePrompt(agentsDir: string, role: string): RolePrompt | null {
  let md: string;
  try {
    md = readFileSync(join(agentsDir, roleFileName(role)), "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(md);
  const prompt = body.trim();
  if (prompt.length === 0) return null;
  const rolePrompt: RolePrompt = { role, prompt };
  const model = data["model"];
  if (model !== undefined && model.length > 0) rolePrompt.model = model;
  const tools = data["tools"];
  if (tools !== undefined && tools.length > 0) {
    const list = tools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (list.length > 0) rolePrompt.tools = list;
  }
  return rolePrompt;
}

/** Lists role files (*.md, files only) sorted by name; [] when unreadable. */
export function listRoleFiles(agentsDir: string): string[] {
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
