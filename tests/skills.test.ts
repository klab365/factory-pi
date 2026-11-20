import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAgentRuntime, loadAgentDefinition } from "../src/agent-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "factory-skills-"));
  roots.push(root);
  function file(path: string, content: string) {
    const target = resolve(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  function agent(name: string, skills = "") {
    file(`.factory/agents/${name}.md`, `---\nname: ${name}\n${skills}\n---\nAgent ${name}`);
  }
  function skill(
    name: string,
    content = `---\nname: ${name}\ndescription: Help with ${name}\n---\nInstructions for ${name}`,
  ) {
    file(`.agents/skills/${name}/SKILL.md`, content);
  }
  return { root, file, agent, skill };
}

describe("explicit agent skills", () => {
  test("supports omitted, empty, block and inline lists in declared order", () => {
    const f = fixture();
    f.skill("alpha");
    f.skill("beta");
    for (const skills of ["", "skills: []"]) {
      f.agent("builder", skills);
      expect(loadAgentDefinition(f.root, "builder").skills).toEqual([]);
    }
    for (const skills of ["skills: [beta, alpha]", "skills:\n  - beta\n  - alpha"]) {
      f.agent("builder", skills);
      expect(loadAgentDefinition(f.root, "builder").skills.map((s) => s.name)).toEqual(["beta", "alpha"]);
    }
  });

  test.each([
    "null",
    "alpha",
    "{}",
    "[42]",
    "[null]",
    "['']",
    "['../alpha']",
    "['/alpha']",
    "['Alpha']",
    "[alpha, alpha]",
  ])("rejects malformed or duplicate references: %s", (value) => {
    const f = fixture();
    f.skill("alpha");
    f.agent("builder", `skills: ${value}`);
    expect(() => loadAgentDefinition(f.root, "builder")).toThrow("skills:");
  });

  test.each([
    [undefined, "cannot load"],
    ["no frontmatter", "must start"],
    ["---\nname: [\n---\nbody", "invalid YAML"],
    ["---\n- item\n---\nbody", "mapping"],
    ["---\nname: other\ndescription: test\n---\nbody", "name: alpha"],
    ["---\nname: alpha\ndescription: ''\n---\nbody", "description"],
    ["---\nname: alpha\ndescription: test\n---\n", "instructions"],
  ])("rejects missing or malformed skill files: %s", (content, error) => {
    const f = fixture();
    f.agent("builder", "skills: [alpha]");
    if (content !== undefined) f.skill("alpha", content);
    expect(() => createAgentRuntime(f.root, { steps: [{ id: "build", agent: "builder" }] })).toThrow(error);
  });

  test("rejects symlinks escaping the project", () => {
    const f = fixture();
    const outside = fixture();
    outside.skill("alpha");
    f.agent("builder", "skills: [alpha]");
    mkdirSync(resolve(f.root, ".agents/skills"), { recursive: true });
    symlinkSync(resolve(outside.root, ".agents/skills/alpha"), resolve(f.root, ".agents/skills/alpha"));
    expect(() => loadAgentDefinition(f.root, "builder")).toThrow("inside the project");
  });

  test("assembles only selected skills per agent and runtime, without modifying task histories", () => {
    const f = fixture();
    f.skill("alpha");
    f.skill("beta");
    f.skill("unselected", "invalid unselected skill");
    f.agent("builder", "skills: [alpha]");
    f.agent("reviewer", "skills: [beta]");
    const pipeline = {
      steps: [
        { id: "build", agent: "builder" },
        { id: "review", agent: "reviewer" },
      ],
    };
    const first = createAgentRuntime(f.root, pipeline);
    const builder = first.agentChange("builder").instructions;
    const reviewer = first.agentChange("reviewer").instructions;
    expect(builder).toContain("Agent builder\n\n## Skill: alpha");
    expect(builder).toContain("Source: .agents/skills/alpha/SKILL.md");
    expect(builder).toContain("Instructions for alpha");
    expect(builder).not.toContain("Instructions for beta");
    expect(reviewer).toContain("Instructions for beta");
    expect(reviewer).not.toContain("Instructions for alpha");
    expect(builder).toContain("<factory-result>");
    f.agent("builder", "skills: []");
    const second = createAgentRuntime(f.root, pipeline);
    expect(second.agentChange("builder").instructions).not.toContain("Skill: alpha");
    expect(first.agentChange("builder").instructions).toBe(builder);
  });
});
