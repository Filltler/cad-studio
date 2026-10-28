import { create } from "zustand";
import type { ProjectObject, PrimitiveKind, Vector3 } from "../../domain/project";

type EditorState = {
  objects: ProjectObject[];
  selectedId: string | null;
  past: ProjectObject[][];
  future: ProjectObject[][];
  beginTransaction: () => void;
  endTransaction: () => void;
  undo: () => void;
  redo: () => void;
  addPrimitive: (kind: Exclude<PrimitiveKind, "custom">) => void;
  selectObject: (id: string | null) => void;
  updateObject: (id: string, patch: Partial<Pick<ProjectObject, "position" | "dimensions" | "rotation">>) => void;
  applyBooleanResult: (objectIds: string[], name: string, vertices: number[]) => void;
};

const defaultDimensions: Record<Exclude<PrimitiveKind, "custom">, Vector3> = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { x: 20, y: 20, z: 25 },
  sphere: { x: 20, y: 20, z: 20 }
};

const cloneObjects = (objects: ProjectObject[]) => objects.map((object) => ({ ...object, position: { ...object.position }, dimensions: { ...object.dimensions }, rotation: { ...object.rotation }, geometryVertices: object.geometryVertices ? [...object.geometryVertices] : undefined }));
let transactionStart: ProjectObject[] | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
  objects: [
    {
      id: crypto.randomUUID(),
      name: "Cubo 1",
      kind: "box",
      position: { x: 0, y: 10, z: 0 },
      dimensions: { x: 20, y: 20, z: 20 },
      rotation: { x: 0, y: 0, z: 0 }
    }
  ],
  selectedId: null,
  past: [],
  future: [],
  beginTransaction: () => {
    if (transactionStart === null) transactionStart = cloneObjects(get().objects);
  },
  endTransaction: () => {
    if (transactionStart === null) return;
    const before = transactionStart;
    transactionStart = null;
    if (JSON.stringify(before) === JSON.stringify(get().objects)) return;
    set((state) => ({ past: [...state.past, before].slice(-100), future: [] }));
  },
  undo: () => set((state) => {
    if (state.past.length === 0) return state;
    const objects = state.past[state.past.length - 1];
    return { objects: cloneObjects(objects), past: state.past.slice(0, -1), future: [cloneObjects(state.objects), ...state.future].slice(0, 100), selectedId: objects.some((object) => object.id === state.selectedId) ? state.selectedId : objects[objects.length - 1]?.id ?? null };
  }),
  redo: () => set((state) => {
    if (state.future.length === 0) return state;
    const objects = state.future[0];
    return { objects: cloneObjects(objects), past: [...state.past, cloneObjects(state.objects)].slice(-100), future: state.future.slice(1), selectedId: objects.some((object) => object.id === state.selectedId) ? state.selectedId : objects[objects.length - 1]?.id ?? null };
  }),
  addPrimitive: (kind) => set((state) => {
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    const number = state.objects.filter((o) => o.kind === kind).length + 1;
    const object: ProjectObject = {
      id: crypto.randomUUID(),
      name: `${kind === "box" ? "Cubo" : kind === "cylinder" ? "Cilindro" : "Esfera"} ${number}`,
      kind,
      position: { x: state.objects.length * 8, y: defaultDimensions[kind].y / 2, z: 0 },
      dimensions: { ...defaultDimensions[kind] },
      rotation: { x: 0, y: 0, z: 0 }
    };
    return { ...history, objects: [...state.objects, object], selectedId: object.id };
  }),
  selectObject: (id) => set({ selectedId: id }),
  updateObject: (id, patch) => set((state) => {
    const nextObjects = state.objects.map((object) => object.id === id ? { ...object, ...patch } : object);
    if (JSON.stringify(nextObjects) === JSON.stringify(state.objects)) return state;
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: nextObjects };
  }),
  applyBooleanResult: (objectIds, name, vertices) => set((state) => {
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    const selected = state.objects.filter((object) => objectIds.includes(object.id));
    if (selected.length < 2 || vertices.length < 9) return state;
    const xs = vertices.filter((_, index) => index % 3 === 0);
    const ys = vertices.filter((_, index) => index % 3 === 1);
    const zs = vertices.filter((_, index) => index % 3 === 2);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const result: ProjectObject = {
      id: crypto.randomUUID(), name, kind: "custom",
      position: { x: 0, y: 0, z: 0 },
      dimensions: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      rotation: { x: 0, y: 0, z: 0 }, geometryVertices: vertices
    };
    return { ...history, objects: [...state.objects.filter((object) => !objectIds.includes(object.id)), result], selectedId: result.id };
  })
}));
