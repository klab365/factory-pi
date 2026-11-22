import { listPipelines } from "../src/init";
import { validatePipeline } from "../src/pipeline-validation";

const root = process.cwd();
const names = listPipelines(root);
if (!names.length) throw new Error("No Factory pipelines found");
for (const name of names) {
  validatePipeline(root, name);
  console.log(`Pipeline valid: ${name}`);
}
