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
  deleteObjects: (ids: string[]) => void;
  updateObject: (id: string, patch: Partial<Pick<ProjectObject, "position" | "dimensions" | "rotation" | "booleanRole" | "color">>) => void;
  applyBooleanResult: (objectIds: string[], name: string, vertices: number[]) => void;\n  applyHeightSplitResult: (objectId: string, name: string, lowerVertices: number[], upperVertices: number[]) => void;
  loadProjectObjects: (objects: ProjectObject[]) => void;
};

const defaultDimensions: Record<Exclude<PrimitiveKind, "custom">, Vector3> = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { x: 20, y: 20, z: 25 },
  sphere: { x: 20, y: 20, z: 20 }
};

const roundMillimeters = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

const cloneObjects = (objects: ProjectObject[]) => objects.map((object) => ({ ...object, position: { ...object.position }, dimensions: { ...object.dimensions }, rotation: { ...object.rotation }, geometryVertices: object.geometryVertices ? [...object.geometryVertices] : undefined }));
let transactionStart: ProjectObject[] | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
  objects: [
    {
      id: crypto.randomUUID(),
      name: "Cubo 1",
      kind: "box",
      booleanRole: "solid",
      color: "#8b9cf6",
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
      booleanRole: "solid",
      color: "#8b9cf6",
      position: { x: state.objects.length * 8, y: defaultDimensions[kind].y / 2, z: 0 },
      dimensions: { ...defaultDimensions[kind] },
      rotation: { x: 0, y: 0, z: 0 }
    };
    return { ...history, objects: [...state.objects, object], selectedId: object.id };
  }),
  selectObject: (id) => set({ selectedId: id }),
  deleteObjects: (ids) => set((state) => {
    const remove = new Set(ids);
    const next = state.objects.filter((object) => !remove.has(object.id));
    if (next.length === state.objects.length) return state;
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: next, selectedId: remove.has(state.selectedId ?? "") ? (next[next.length - 1]?.id ?? null) : state.selectedId };
  }),
  applyHeightSplitResult: (objectId, name, lowerVertices, upperVertices) => set((state) => {
    const source = state.objects.find((object) => object.id === objectId);
    if (!source || lowerVertices.length < 9 || upperVertices.length < 9) return state;
    const makePart = (partName: string, vertices: number[]): ProjectObject => {
      const xs = vertices.filter((_, index) => index % 3 === 0);
      const ys = vertices.filter((_, index) => index % 3 === 1);
      const zs = vertices.filter((_, index) => index % 3 === 2);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      return {
        id: crypto.randomUUID(), name: partName, kind: "custom", booleanRole: "solid", color: source.color ?? "#8b9cf6",
        position: { x: 0, y: 0, z: 0 },
        dimensions: { x: roundMillimeters(maxX - minX), y: roundMillimeters(maxY - minY), z: roundMillimeters(maxZ - minZ) },
        rotation: { x: 0, y: 0, z: 0 }, geometryVertices: vertices
      };
    };
    const lower = makePart(name + " · inferior", lowerVertices);
    const upper = makePart(name + " · superior", upperVertices);
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: [...state.objects.filter((object) => object.id !== objectId), lower, upper], selectedId: lower.id };
  }),
  loadProjectObjects: (objects) => {
    transactionStart = null;
    set({ objects: cloneObjects(objects), selectedId: objects[0]?.id ?? null, past: [], future: [] });
  },
  updateObject: (id, patch) => set((state) => {
    const nextObjects = state.objects.map((object) => object.id === id ? { ...object, ...patch } : object);
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: nextObjects };
  }),
  applyBooleanResult: (objectIds, name, vertices) => set((state) => {
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    const selected = state.objects.filter((object) => objectIds.includes(object.id));
    if (selected.length < 1 || vertices.length < 9) return state;
    const xs = vertices.filter((_, index) => index % 3 === 0);
    const ys = vertices.filter((_, index) => index % 3 === 1);
    const zs = vertices.filter((_, index) => index % 3 === 2);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const result: ProjectObject = {
      id: crypto.randomUUID(), name, kind: "custom", booleanRole: "solid", color: selected[0]?.color ?? "#8b9cf6",
      position: { x: 0, y: 0, z: 0 },
      dimensions: { x: roundMillimeters(maxX - minX), y: roundMillimeters(maxY - minY), z: roundMillimeters(maxZ - minZ) },
      rotation: { x: 0, y: 0, z: 0 }, geometryVertices: vertices
    };
    return { ...history, objects: [...state.objects.filter((object) => !objectIds.includes(object.id)), result], selectedId: result.id };
  })
}));
