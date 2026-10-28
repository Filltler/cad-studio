import { z } from "zod";

export type PrimitiveKind = "box" | "cylinder" | "sphere" | "custom";
export type Vector3 = { x: number; y: number; z: number };

export type BooleanRole = "solid" | "cutter";

export type ProjectObject = {
  id: string;
  booleanRole?: BooleanRole;
  color?: string;
  name: string;
  kind: PrimitiveKind;
  position: Vector3;
  dimensions: Vector3;
  rotation: Vector3;
  geometryVertices?: number[];
};

const vectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
});

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  units: z.literal("mm"),
  objects: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["box", "cylinder", "sphere", "custom"]),
    booleanRole: z.enum(["solid", "cutter"]).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    geometryVertices: z.array(z.number().finite()).optional(),
    position: vectorSchema,
    dimensions: vectorSchema.refine((v) => v.x > 0 && v.y > 0 && v.z > 0, "Las dimensiones deben ser positivas."),
    rotation: vectorSchema.default({ x: 0, y: 0, z: 0 })
  })),
  updatedAt: z.string().datetime()
});

export type ProjectDocument = z.infer<typeof projectSchema>;
