import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Bootstrap only missing files; project-owned configuration is never overwritten. */
export function initProject(root: string): string[] {
  for (const folder of ["pipelines", "agents"]) {
    mkdirSync(resolve(root, ".factory", folder), { recursive: true });
  }
  const pipelines = resolve(root, ".factory/pipelines");
  if (!readdirSync(pipelines).some((name) => name.endsWith(".yml"))) {
    writeFileSync(
      resolve(pipelines, "hello.yml"),
      'name: Hello Factory\nsteps:\n  - id: hello\n    shell: "echo Hello from Factory"\n',
      { flag: "wx" },
    );
  }
  const ignore = resolve(root, ".factory/.gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "state/\n", { flag: "wx" });
  return listPipelines(root);
}

export function listPipelines(root: string): string[] {
  const pipelines = resolve(root, ".factory/pipelines");
  if (!existsSync(pipelines)) return [];
  return readdirSync(pipelines)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => name.slice(0, -4));
}
