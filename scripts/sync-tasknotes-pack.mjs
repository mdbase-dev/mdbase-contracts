import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = resolve(process.env.TASKNOTES_MODEL_DIR ?? join(root, "..", "tasknotes-model"));
const { buildTaskNotesMdbaseResources, buildTaskNotesMdbaseTypePack, TASKNOTES_TASK_CONTRACT_VERSION } = await import(pathToFileURL(join(model, "dist/esm/mdbase.js")).href);
const resources = buildTaskNotesMdbaseResources();
// Also verifies the model's pinned semantic digest before importing anything.
await buildTaskNotesMdbaseTypePack(resources);
const version = TASKNOTES_TASK_CONTRACT_VERSION;
for (const [path, document] of [
  [`contracts/tasknotes.task/${version}.md`, resources.contractDocument],
  [`schemas/tasknotes.task/${version}.schema.json`, resources.taskSchemaDocument],
  [`schemas/tasknotes.task.binding/${version}.schema.json`, resources.bindingSchemaDocument],
  [`types/tasknotes-task/${resources.type.version}.md`, resources.typeDocument],
]) {
  const destination = join(root, path);
  let previous;
  try { previous = await readFile(destination, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous !== undefined && previous !== document) throw new Error(`Refusing to overwrite immutable artifact ${path}; use a new version.`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, document);
}
console.log(`Imported TaskNotes ${version} from ${model}`);
