import type { ProjectObject } from "../../domain/project";

/**
 * Contrato de integración del motor CAD.
 * La implementación OpenCascade.js se añadirá tras validar su API,
 * carga WASM, licencia y estrategia de ejecución.
 */
export interface CadKernel {
  initialize(): Promise<void>;
  union(objects: ProjectObject[]): Promise<unknown>;
  subtract(base: ProjectObject, tools: ProjectObject[]): Promise<unknown>;
  intersect(objects: ProjectObject[]): Promise<unknown>;
  validateSolid(shape: unknown): Promise<{ valid: boolean; issues: string[] }>;
}
