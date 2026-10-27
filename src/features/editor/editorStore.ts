import { create } from "zustand";
import type { ProjectObject, PrimitiveKind, Vector3 } from "../../domain/project";

type EditorState = {
  objects: ProjectObject[];
  selectedId: string | null;
  addPrimitive: (kind: PrimitiveKind) => void;
  selectObject: (id: string | null) => void;
  updateObject: (id: string, patch: Partial<Pick<ProjectObject, "position" | "dimensions" | "rotation">>) => void;
};

const defaultDimensions: Record<PrimitiveKind, Vector3> = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { x: 20, y: 20, z: 25 },
  sphere: { x: 20, y: 20, z: 20 }
};

export const useEditorStore = create<EditorState>((set) => ({
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
  addPrimitive: (kind) => set((state) => {
    const number = state.objects.filter((o) => o.kind === kind).length + 1;
    const object: ProjectObject = {
      id: crypto.randomUUID(),
      name: `${kind === "box" ? "Cubo" : kind === "cylinder" ? "Cilindro" : "Esfera"} ${number}`,
      kind,
      position: { x: state.objects.length * 8, y: defaultDimensions[kind].y / 2, z: 0 },
      dimensions: { ...defaultDimensions[kind] },
      rotation: { x: 0, y: 0, z: 0 }
    };
    return { objects: [...state.objects, object], selectedId: object.id };
  }),
  selectObject: (id) => set({ selectedId: id }),
  updateObject: (id, patch) => set((state) => ({
    objects: state.objects.map((object) => object.id === id ? { ...object, ...patch } : object)
  }))
}));
