import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

export type SkillDefinition = { name: string; description: string; path: string; content: string };
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Resolve only explicit project-local skills; never scan global or unselected skills. */
export function loadSkills(root: string, agent: string, references: unknown): SkillDefinition[] {
  if (references === undefined) return [];
  const fail = (message: string): never => {
    throw new Error(`Agent '${agent}' skills: ${message}`);
  };
  if (!Array.isArray(references)) return fail("must be a list of skill names");
  const seen = new Set<string>();
  return references.map((name: unknown) => {
    if (typeof name !== "string" || name.length > 64 || !skillName.test(name)) {
      return fail(`invalid reference '${String(name)}'; use lowercase kebab-case names (max 64 characters)`);
    }
    if (seen.has(name)) return fail(`duplicate reference '${name}'`);
    seen.add(name);
    const path = `.agents/skills/${name}/SKILL.md`;
    let content: string;
    try {
      const resolved = realpathSync(resolve(root, path));
      const local = relative(realpathSync(root), resolved);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
        return fail(`'${name}' must resolve inside the project`);
      }
      content = readFileSync(resolved, "utf8");
    } catch (error) {
      return fail(
        `cannot load '${name}' at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!frontmatter) return fail(`'${name}' must start with YAML frontmatter`);
    let metadata: unknown;
    try {
      metadata = parse(frontmatter[1]);
    } catch {
      return fail(`'${name}' has invalid YAML frontmatter`);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return fail(`'${name}' frontmatter must be a mapping`);
    }
    const fields = metadata as Record<string, unknown>;
    if (fields.name !== name) return fail(`'${name}' frontmatter must have name: ${name}`);
    if (typeof fields.description !== "string" || !fields.description.trim()) {
      return fail(`'${name}' must have a non-empty description`);
    }
    const body = content.slice(frontmatter[0].length).trim();
    if (!body) return fail(`'${name}' must have non-empty instructions`);
    return { name, description: fields.description, path, content: body };
  });
}

export function skillInstructions(skills: SkillDefinition[]): string {
  return skills
    .map(
      (skill) => `## Skill: ${skill.name}\nSource: ${skill.path}\n${skill.description}\n\n${skill.content}`,
    )
    .join("\n\n");
}
