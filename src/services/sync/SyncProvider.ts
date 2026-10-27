import type { ProjectDocument } from "../../domain/project";

/**
 * Contrato futuro de sincronización.
 * La implementación debe contemplar autenticación, permisos, versionado,
 * detección de conflictos y sincronización idempotente.
 */
export interface SyncProvider {
  upload(project: ProjectDocument): Promise<void>;
  download(projectId: string): Promise<ProjectDocument | null>;
  list(): Promise<Array<Pick<ProjectDocument, "id" | "name" | "updatedAt">>>;
}
