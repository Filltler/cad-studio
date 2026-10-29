import { create } from "zustand";
import type { ProjectObject, PrimitiveKind, Vector3 } from "../../domain/project";
import { calculateObjectBounds } from "../../services/booleanOperations";

type AlignmentAxis = "x" | "y" | "z";
type AlignmentMode = "min" | "center" | "max";
type SpacingMode = "fixed" | "uniform";

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
  alignObjects: (objectIds: string[], axis: AlignmentAxis, mode: AlignmentMode) => void;
  spaceObjects: (objectIds: string[], axis: AlignmentAxis, mode: SpacingMode, gap: number) => void;
  applyBooleanResult: (objectIds: string[], name: string, vertices: number[]) => void; 
  addCustomObject: (name: string, vertices: number[], position?: Vector3) => void;
  applyPlanarSplitResult: (objectId: string, name: string, negativeVertices: number[], positiveVertices: number[], negativeLabel: string, positiveLabel: string) => void;
  loadProjectObjects: (objects: ProjectObject[]) => void;
};

const defaultDimensions: Record<Exclude<PrimitiveKind, "custom">, Vector3> = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { x: 20, y: 20, z: 25 },
  sphere: { x: 20, y: 20, z: 20 }
};

const roundMillimeters = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

const cloneObjects = (objects: ProjectObject[]) => objects.map((object) => ({ ...object, position: { ...object.position }, dimensions: { ...object.dimensions }, rotation: { ...object.rotation }, geometryVertices: object.geometryVertices }));
function boundsFromVertices(vertices: number[]) {
  if (vertices.length < 9 || vertices.length % 3 !== 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < vertices.length; index += 3) {
    const x = vertices[index], y = vertices[index + 1], z = vertices[index + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
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
  addCustomObject: (name, vertices, position = { x: 0, y: 0, z: 0 }) => set((state) => {
    if (vertices.length < 36 || vertices.length % 9 !== 0) {
      throw new Error("La malla importada no contiene triángulos 3D válidos.");
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let index = 0; index < vertices.length; index += 3) {
      const x = vertices[index], y = vertices[index + 1], z = vertices[index + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error("La malla importada contiene coordenadas inválidas.");
      }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const dimensions = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
    if (Object.values(dimensions).some((size) => !Number.isFinite(size) || size <= 0.001)) {
      throw new Error("La malla importada debe tener dimensiones 3D válidas.");
    }
    const history = transactionStart
      ? { past: state.past, future: state.future }
      : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    const object: ProjectObject = {
      id: crypto.randomUUID(),
      name: name.trim() || "Malla importada",
      kind: "custom",
      booleanRole: "solid",
      color: "#8b9cf6",
      position: { ...position },
      dimensions: { x: roundMillimeters(dimensions.x), y: roundMillimeters(dimensions.y), z: roundMillimeters(dimensions.z) },
      rotation: { x: 0, y: 0, z: 0 },
      geometryVertices: [...vertices]
    };
    return { ...history, objects: [...state.objects, object], selectedId: object.id };
  }),
  alignObjects: (objectIds, axis, mode) => set((state) => {
    const selectedObjects = state.objects.filter((object) => objectIds.includes(object.id));
    if (selectedObjects.length < 2) return state;

    const boundsById = new Map(selectedObjects.map((object) => [object.id, calculateObjectBounds(object)] as const));
    const aggregateMin = Math.min(...selectedObjects.map((object) => boundsById.get(object.id)!.min[axis]));
    const aggregateMax = Math.max(...selectedObjects.map((object) => boundsById.get(object.id)!.max[axis]));
    const target = mode === "min" ? aggregateMin : mode === "max" ? aggregateMax : (aggregateMin + aggregateMax) / 2;

    let changed = false;
    const nextObjects = state.objects.map((object) => {
      const bounds = boundsById.get(object.id);
      if (!bounds) return object;
      const current = mode === "min" ? bounds.min[axis] : mode === "max" ? bounds.max[axis] : (bounds.min[axis] + bounds.max[axis]) / 2;
      const delta = target - current;
      if (Math.abs(delta) < 0.0005) return object;
      changed = true;
      return { ...object, position: { ...object.position, [axis]: roundMillimeters(object.position[axis] + delta) } };
    });
    if (!changed) return state;

    const history = transactionStart
      ? { past: state.past, future: state.future }
      : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: nextObjects };
  }),
  spaceObjects: (objectIds, axis, mode, gap) => set((state) => {
    const selectedObjects = state.objects.filter((object) => objectIds.includes(object.id));
    if (selectedObjects.length < 2) return state;
    if (mode === "fixed" && (!Number.isFinite(gap) || gap < 0)) {
      throw new Error("La separación debe ser un número igual o mayor que 0 mm.");
    }
    if (mode === "uniform" && selectedObjects.length < 3) {
      throw new Error("La distribución uniforme necesita al menos tres piezas.");
    }

    const workplaneTieBreakers: Record<AlignmentAxis, [AlignmentAxis, AlignmentAxis]> = {
      x: ["z", "y"],
      y: ["x", "z"],
      z: ["x", "y"]
    };
    const centerOn = (bounds: ReturnType<typeof calculateObjectBounds>, coordinate: AlignmentAxis) => (bounds.min[coordinate] + bounds.max[coordinate]) / 2;
    const arranged = selectedObjects
      .map((object) => ({ object, bounds: calculateObjectBounds(object) }))
      .sort((a, b) => {
        const axisDelta = centerOn(a.bounds, axis) - centerOn(b.bounds, axis);
        if (Math.abs(axisDelta) > 0.0005) return axisDelta;
        for (const tieAxis of workplaneTieBreakers[axis]) {
          const tieDelta = centerOn(a.bounds, tieAxis) - centerOn(b.bounds, tieAxis);
          if (Math.abs(tieDelta) > 0.0005) return tieDelta;
        }
        const minDelta = a.bounds.min[axis] - b.bounds.min[axis];
        if (Math.abs(minDelta) > 0.0005) return minDelta;
        const maxDelta = a.bounds.max[axis] - b.bounds.max[axis];
        if (Math.abs(maxDelta) > 0.0005) return maxDelta;
        return a.object.id.localeCompare(b.object.id);
      });
    const shifts = new Map<string, number>();

    if (mode === "fixed") {
      let nextMinimum = arranged[0].bounds.max[axis] + gap;
      for (const item of arranged.slice(1)) {
        const delta = nextMinimum - item.bounds.min[axis];
        shifts.set(item.object.id, delta);
        nextMinimum = item.bounds.max[axis] + delta + gap;
      }
    } else {
      const first = arranged[0];
      const last = arranged[arranged.length - 1];
      const totalSpan = last.bounds.max[axis] - first.bounds.min[axis];
      const totalSize = arranged.reduce((sum, item) => sum + item.bounds.max[axis] - item.bounds.min[axis], 0);
      const uniformGap = (totalSpan - totalSize) / (arranged.length - 1);
      if (uniformGap < -0.0005) {
        throw new Error("No hay espacio suficiente para distribuir las piezas sin que se superpongan. Separá los extremos.");
      }

      let nextMinimum = first.bounds.min[axis];
      for (let index = 1; index < arranged.length - 1; index++) {
        const previous = arranged[index - 1];
        nextMinimum += previous.bounds.max[axis] - previous.bounds.min[axis] + Math.max(0, uniformGap);
        shifts.set(arranged[index].object.id, nextMinimum - arranged[index].bounds.min[axis]);
      }
    }

    let changed = false;
    const nextObjects = state.objects.map((object) => {
      const delta = shifts.get(object.id);
      if (delta === undefined || Math.abs(delta) < 0.0005) return object;
      changed = true;
      return { ...object, position: { ...object.position, [axis]: roundMillimeters(object.position[axis] + delta) } };
    });
    if (!changed) return state;

    const history = transactionStart
      ? { past: state.past, future: state.future }
      : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: nextObjects };
  }),
  deleteObjects: (ids) => set((state) => {
    const remove = new Set(ids);
    const next = state.objects.filter((object) => !remove.has(object.id));
    if (next.length === state.objects.length) return state;
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: next, selectedId: remove.has(state.selectedId ?? "") ? (next[next.length - 1]?.id ?? null) : state.selectedId };
  }),
  applyPlanarSplitResult: (objectId, name, negativeVertices, positiveVertices, negativeLabel, positiveLabel) => set((state) => {
    const source = state.objects.find((object) => object.id === objectId);
    if (!source) return state;
    const makePart = (partName: string, vertices: number[]): ProjectObject | null => {
      const bounds = boundsFromVertices(vertices);
      if (!bounds) return null;
      return {
        id: crypto.randomUUID(), name: partName, kind: "custom", booleanRole: "solid", color: source.color ?? "#8b9cf6",
        position: { x: 0, y: 0, z: 0 },
        dimensions: {
          x: roundMillimeters(bounds.maxX - bounds.minX),
          y: roundMillimeters(bounds.maxY - bounds.minY),
          z: roundMillimeters(bounds.maxZ - bounds.minZ)
        },
        rotation: { x: 0, y: 0, z: 0 }, geometryVertices: vertices
      };
    };
    const negative = makePart(name + " · " + negativeLabel, negativeVertices);
    const positive = makePart(name + " · " + positiveLabel, positiveVertices);
    if (!negative || !positive) return state;
    const history = transactionStart ? { past: state.past, future: state.future } : { past: [...state.past, cloneObjects(state.objects)].slice(-100), future: [] };
    return { ...history, objects: [...state.objects.filter((object) => object.id !== objectId), negative, positive], selectedId: negative.id };
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
    const bounds = boundsFromVertices(vertices);
    if (selected.length < 1 || !bounds) return state;
    const result: ProjectObject = {
      id: crypto.randomUUID(), name, kind: "custom", booleanRole: "solid", color: selected[0]?.color ?? "#8b9cf6",
      position: { x: 0, y: 0, z: 0 },
      dimensions: { x: roundMillimeters(bounds.maxX - bounds.minX), y: roundMillimeters(bounds.maxY - bounds.minY), z: roundMillimeters(bounds.maxZ - bounds.minZ) },
      rotation: { x: 0, y: 0, z: 0 }, geometryVertices: vertices
    };
    return { ...history, objects: [...state.objects.filter((object) => !objectIds.includes(object.id)), result], selectedId: result.id };
  })
}));

