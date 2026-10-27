import { z } from "zod";

export type PrimitiveKind = "box" | "cylinder" | "sphere";
export type Vector3 = { x: number; y: number; z: number };

export type ProjectObject = {
  id: string;
  name: string;
  kind: PrimitiveKind;
  position: Vector3;
  dimensions: Vector3;
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
    kind: z.enum(["box", "cylinder", "sphere"]),
    position: vectorSchema,
    dimensions: vectorSchema.refine((v) => v.x > 0 && v.y > 0 && v.z > 0, "Las dimensiones deben ser positivas.")
  })),
  updatedAt: z.string().datetime()
});

export type ProjectDocument = z.infer<typeof projectSchema>;
