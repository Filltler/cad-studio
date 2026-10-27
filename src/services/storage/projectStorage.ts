import { openDB } from "idb";
import { projectSchema, type ProjectDocument } from "../../domain/project";

const DB_NAME = "cad-studio";
const STORE_NAME = "projects";

async function database() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    }
  });
}

export async function saveProject(input: ProjectDocument): Promise<void> {
  const project = projectSchema.parse(input);
  const db = await database();
  await db.put(STORE_NAME, project);
}

export async function loadProject(id: string): Promise<ProjectDocument | undefined> {
  const db = await database();
  const result = await db.get(STORE_NAME, id);
  return result ? projectSchema.parse(result) : undefined;
}

export async function listProjects(): Promise<ProjectDocument[]> {
  const db = await database();
  const items = await db.getAll(STORE_NAME);
  return items.map((item) => projectSchema.parse(item));
}
