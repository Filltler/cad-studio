import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import type { ProjectObject } from "../domain/project";

export type BooleanOperation = "union" | "subtract" | "intersect";

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) material.forEach((item) => item.dispose());
  else material.dispose();
}

function createGeometry(object: ProjectObject): THREE.BufferGeometry {
  if (object.kind === "box") return new THREE.BoxGeometry(1, 1, 1);
  if (object.kind === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 64);
  if (object.kind === "sphere") return new THREE.SphereGeometry(0.5, 40, 32);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(object.geometryVertices ?? [], 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createBrush(object: ProjectObject): Brush {
  const geometry = createGeometry(object);
  const brush = new Brush(geometry, new THREE.MeshStandardMaterial());
  if (object.kind !== "custom") {
    brush.position.set(object.position.x, object.position.y, object.position.z);
    brush.scale.set(object.dimensions.x, object.dimensions.y, object.dimensions.z);
    brush.rotation.set(
      THREE.MathUtils.degToRad(object.rotation.x),
      THREE.MathUtils.degToRad(object.rotation.y),
      THREE.MathUtils.degToRad(object.rotation.z)
    );
  }
  brush.updateMatrixWorld(true);
  return brush;
}

export function calculateBoolean(objects: ProjectObject[], operation: BooleanOperation): number[] {
  if (objects.length < 2) throw new Error("Seleccioná al menos dos piezas.");
  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  let result = createBrush(objects[0]);
  try {
    for (const object of objects.slice(1)) {
      const next = createBrush(object);
      try {
        const op = operation === "union" ? ADDITION : operation === "subtract" ? SUBTRACTION : INTERSECTION;
        const combined = evaluator.evaluate(result, next, op);
        result.geometry.dispose();
        disposeMaterial(result.material);
        result = combined;
      } finally {
        next.geometry.dispose();
        disposeMaterial(next.material);
      }
    }
    result.updateMatrixWorld(true);
    // CSG results commonly use indexed geometry. Flatten it so every
    // triangle has its own three consecutive vertices before storing/exporting.
    // CSG evaluation returns vertices in the coordinate system of brush A and
    // also assigns A's world transform to the result brush. Convert the result
    // back to world coordinates exactly once before storing a transform-free mesh.
    // Read exactly the active index range and expand each triangle explicitly.
    // Avoid BufferGeometry.toNonIndexed(), which can expand unused index-buffer capacity.
    const position = result.geometry.getAttribute("position");
    const index = result.geometry.index;
    const drawStart = result.geometry.drawRange.start;
    const drawCount = result.geometry.drawRange.count;
    const availableCount = index ? index.count : position.count;
    const activeCount = Math.min(
      drawCount === Infinity ? availableCount : drawCount,
      availableCount - drawStart
    );
    const vertices: number[] = [];
    for (let i = drawStart; i < drawStart + activeCount; i++) {
      const vertexIndex = index ? index.getX(i) : i;
      vertices.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
    }
    geometry.dispose();
    if (vertices.length < 9) throw new Error("La operación no produjo un sólido válido. Revisá que las piezas se superpongan.");
    return vertices;
  } finally {
    result.geometry.dispose();
    disposeMaterial(result.material);
  }
}
