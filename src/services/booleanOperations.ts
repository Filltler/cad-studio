import * as THREE from "three";
import Module from "manifold-3d";
import type { ProjectObject } from "../domain/project";

export type BooleanOperation = "union" | "subtract" | "intersect";

type ManifoldApi = Awaited<ReturnType<typeof Module>>;
let manifoldPromise: Promise<ManifoldApi> | null = null;

async function getManifoldApi(): Promise<ManifoldApi> {
  if (!manifoldPromise) {
    manifoldPromise = Module().then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return manifoldPromise;
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

function createWorldGeometry(object: ProjectObject): THREE.BufferGeometry {
  const geometry = createGeometry(object);
  if (object.kind !== "custom") {
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(object.position.x, object.position.y, object.position.z);
    mesh.scale.set(object.dimensions.x, object.dimensions.y, object.dimensions.z);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(object.rotation.x),
      THREE.MathUtils.degToRad(object.rotation.y),
      THREE.MathUtils.degToRad(object.rotation.z)
    );
    mesh.updateMatrixWorld(true);
    geometry.applyMatrix4(mesh.matrixWorld);
  } else {
    // Custom mesh vertices are stored in world-space coordinates at creation. Center them
    // so subsequent object rotation is applied around the mesh's own bounding-box center.
    geometry.computeBoundingBox();
    const center = geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
    geometry.translate(-center.x, -center.y, -center.z);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(center.x + object.position.x, center.y + object.position.y, center.z + object.position.z);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(object.rotation.x),
      THREE.MathUtils.degToRad(object.rotation.y),
      THREE.MathUtils.degToRad(object.rotation.z)
    );
    mesh.updateMatrixWorld(true);
    geometry.applyMatrix4(mesh.matrixWorld);
  }
  geometry.clearGroups();
  return geometry;
}

export function calculateObjectBounds(object: ProjectObject): THREE.Box3 {
  const geometry = createWorldGeometry(object);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox?.clone() ?? null;
  geometry.dispose();
  if (!bounds) throw new Error("No se pudieron calcular los límites del objeto para alinearlo.");
  return bounds;
}

function toManifoldMesh(wasm: ManifoldApi, geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  if (!position || position.count < 4) throw new Error("Una de las piezas no contiene una malla válida.");
  const vertices = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    vertices[i * 3] = position.getX(i);
    vertices[i * 3 + 1] = position.getY(i);
    vertices[i * 3 + 2] = position.getZ(i);
  }
  const indices = geometry.index
    ? new Uint32Array(geometry.index.array as ArrayLike<number>)
    : new Uint32Array(Array.from({ length: position.count }, (_, i) => i));
  if (indices.length < 12 || indices.length % 3 !== 0) {
    throw new Error("La malla de una pieza no contiene triángulos completos.");
  }
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: vertices,
    triVerts: indices,
    runIndex: new Uint32Array([0]),
    runOriginalID: new Uint32Array([0])
  });
  mesh.merge();
  return mesh;
}

export async function calculateBoolean(objects: ProjectObject[], operation: BooleanOperation): Promise<number[]> {
  if (objects.length < 2) throw new Error("Seleccioná al menos dos piezas.");
  const wasm = await getManifoldApi();
  const solids: any[] = [];
  const sourceMeshes: any[] = [];
  let result: any = null;
  let outputMesh: any = null;
  const geometries: THREE.BufferGeometry[] = [];

  try {
    for (const object of objects) {
      const geometry = createWorldGeometry(object);
      geometries.push(geometry);
      const mesh = toManifoldMesh(wasm, geometry);
      sourceMeshes.push(mesh);
      solids.push(new wasm.Manifold(mesh));
    }

    if (operation === "subtract") {
      const targetIndices = objects.map((object, index) => ({ object, index })).filter(({ object }) => object.booleanRole !== "cutter").map(({ index }) => index);
      const cutterIndices = objects.map((object, index) => ({ object, index })).filter(({ object }) => object.booleanRole === "cutter").map(({ index }) => index);
      if (targetIndices.length === 0 || cutterIndices.length === 0) {
        throw new Error("Para Restar, seleccioná al menos un Sólido y una pieza Cortante.");
      }
      result = solids[targetIndices[0]];
      for (const index of targetIndices.slice(1)) {
        const combined = result.add(solids[index]);
        if (!solids.includes(result)) result.delete();
        result = combined;
      }
      for (const index of cutterIndices) {
        const combined = result.subtract(solids[index]);
        if (!solids.includes(result)) result.delete();
        result = combined;
      }
    } else {
      result = solids[0];
      for (let i = 1; i < solids.length; i++) {
        const combined = operation === "union"
          ? result.add(solids[i])
          : result.intersect(solids[i]);
        if (!solids.includes(result)) result.delete();
        result = combined;
      }
    }

    const status = result.status();
    if (status !== "NoError") {
      throw new Error("El motor no pudo validar la geometría de entrada. Revisá que las piezas sean sólidos cerrados y se superpongan.");
    }
    if (result.isEmpty()) throw new Error("La operación no produjo un sólido. Revisá que las piezas se superpongan.");
    outputMesh = result.getMesh();
    const vertices = Array.from(outputMesh.vertProperties as ArrayLike<number>);
    const indices = Array.from(outputMesh.triVerts as ArrayLike<number>);
    const flattened: number[] = [];
    for (const index of indices) {
      const offset = index * 3;
      flattened.push(vertices[offset], vertices[offset + 1], vertices[offset + 2]);
    }
    if (flattened.length < 36 || flattened.some((value) => !Number.isFinite(value))) {
      throw new Error("El motor devolvió una malla vacía o inválida.");
    }
    return flattened;
  } finally {
    outputMesh?.delete?.();
    const uniqueSolids = new Set(solids);
    if (result && !uniqueSolids.has(result)) result.delete?.();
    for (const solid of uniqueSolids) solid.delete?.();
    for (const mesh of sourceMeshes) mesh.delete?.();
    geometries.forEach((geometry) => geometry.dispose());
  }
}


/** Per-face wall thicknesses for the open-top box hollowing operation. */
export type HollowWallThickness = {
  left: number;
  right: number;
  front: number;
  back: number;
  bottom: number;
};

/** Detects a meaningful horizontal face at the custom mesh's highest Y coordinate. */
function hasPlanarTopFace(geometry: THREE.BufferGeometry, bounds: THREE.Box3): boolean {
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3) return false;

  const size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  const yTolerance = Math.max(extent * 1e-6, 1e-5);
  const minimumArea = Math.max(size.x * size.z * 1e-6, 1e-5);
  let topArea = 0;

  for (let index = 0; index + 2 < position.count; index += 3) {
    const ax = position.getX(index), ay = position.getY(index), az = position.getZ(index);
    const bx = position.getX(index + 1), by = position.getY(index + 1), bz = position.getZ(index + 1);
    const cx = position.getX(index + 2), cy = position.getY(index + 2), cz = position.getZ(index + 2);
    if (Math.abs(ay - bounds.max.y) > yTolerance || Math.abs(by - bounds.max.y) > yTolerance || Math.abs(cy - bounds.max.y) > yTolerance) continue;

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    topArea += Math.hypot(crossX, crossY, crossZ) / 2;
  }

  return topArea > minimumArea;
}

/** Builds a uniformly thick cavity for a validated closed custom mesh. */
async function calculateCustomHollow(object: ProjectObject, wallThickness: number): Promise<number[]> {
  if (!Number.isFinite(wallThickness) || wallThickness <= 0) {
    throw new Error("El espesor debe ser mayor que 0 mm.");
  }
  const sourceVertices = object.geometryVertices ?? [];
  if (sourceVertices.length < 36 || sourceVertices.length % 9 !== 0 || sourceVertices.some((value) => !Number.isFinite(value))) {
    throw new Error("La malla personalizada no contiene triángulos cerrados válidos.");
  }

  const geometry = createWorldGeometry(object);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) {
    geometry.dispose();
    throw new Error("No se pudieron calcular los límites de la malla personalizada.");
  }
  const size = bounds.getSize(new THREE.Vector3());
  const minimumExtent = Math.min(size.x, size.y, size.z);
  if (!Number.isFinite(minimumExtent) || minimumExtent <= 1e-5) {
    geometry.dispose();
    throw new Error("La malla personalizada debe tener volumen en las tres dimensiones.");
  }
  if (wallThickness * 2 >= minimumExtent - 1e-5) {
    geometry.dispose();
    throw new Error("Ese espesor es demasiado grande para el tamaño de la malla personalizada.");
  }

  let sourceMesh: any = null;
  let outer: any = null;
  let offsetSphere: any = null;
  let inner: any = null;
  let shell: any = null;
  let rotatedInner: any = null;
  let openingSection: any = null;
  let openingColumn: any = null;
  let rotatedOpeningColumn: any = null;
  let openingCutter: any = null;
  let hollow: any = null;
  let outputMesh: any = null;
  try {
    const wasm = await getManifoldApi();
    sourceMesh = toManifoldMesh(wasm, geometry);
    try {
      outer = new wasm.Manifold(sourceMesh);
    } catch {
      throw new Error("La malla personalizada no es un sólido cerrado válido. Revisá la geometría antes de vaciarla.");
    }
    const outerStatus = outer.status();
    if (outerStatus !== "NoError" || outer.isEmpty()) {
      throw new Error("La malla personalizada no es un sólido cerrado válido. Revisá la geometría antes de vaciarla.");
    }
    const outerVolume = outer.volume();
    if (!Number.isFinite(outerVolume) || outerVolume <= 1e-8) {
      throw new Error("La malla personalizada no es un sólido cerrado válido. Revisá la geometría antes de vaciarla.");
    }

    try {
      offsetSphere = wasm.Manifold.sphere(wallThickness, 32);
      inner = outer.minkowskiDifference(offsetSphere);
    } catch {
      throw new Error("No se pudo calcular el interior de la malla. Probá con un espesor menor.");
    }
    const innerStatus = inner.status();
    if (innerStatus !== "NoError" || inner.isEmpty()) {
      throw new Error("Ese espesor no deja una cavidad válida dentro de la pieza. Probá con un espesor menor.");
    }
    const innerVolume = inner.volume();
    const volumeTolerance = Math.max(outerVolume * 1e-10, 1e-8);
    if (!Number.isFinite(innerVolume) || innerVolume <= volumeTolerance || innerVolume >= outerVolume - volumeTolerance) {
      throw new Error("Ese espesor no deja una cavidad válida dentro de la pieza. Probá con un espesor menor.");
    }

    shell = outer.subtract(inner);
    if (hasPlanarTopFace(geometry, bounds)) {
      const innerBounds = inner.boundingBox();
      const maxExtent = Math.max(size.x, size.y, size.z);
      const epsilon = Math.min(Math.max(maxExtent * 1e-5, 1e-4), wallThickness * 0.05);
      const openingBottom = innerBounds.max[1] - epsilon;
      const openingTop = bounds.max.y + epsilon;
      if (openingTop <= openingBottom) {
        throw new Error("No se pudo abrir la cavidad en la cara superior de la malla.");
      }

      // Slice the eroded interior at its top face and extrude that exact outline upward.
      // This keeps the opening inside concave and irregular walls instead of using a box.
      rotatedInner = inner.rotate([90, 0, 0]);
      const rotatedBounds = rotatedInner.boundingBox();
      openingSection = rotatedInner.slice(rotatedBounds.max[2] - epsilon);
      if (openingSection.numVert() < 3) {
        throw new Error("No se pudo detectar una abertura válida en la cara superior.");
      }
      openingColumn = openingSection.extrude(openingTop - openingBottom);
      rotatedOpeningColumn = openingColumn.rotate([-90, 0, 0]);
      openingCutter = rotatedOpeningColumn.translate([0, openingBottom, 0]);
      try {
        hollow = shell.subtract(openingCutter);
      } catch {
        throw new Error("No se pudo abrir la cavidad en la cara superior. Probá con otro espesor de pared.");
      }
    } else {
      hollow = shell;
    }
    const hollowStatus = hollow.status();
    if (hollowStatus !== "NoError" || hollow.isEmpty()) {
      throw new Error("El vaciado no pasó la validación geométrica. Probá con un espesor menor.");
    }
    const hollowVolume = hollow.volume();
    if (!Number.isFinite(hollowVolume) || hollowVolume <= volumeTolerance || hollowVolume >= outerVolume - volumeTolerance) {
      throw new Error("El vaciado no pasó la validación geométrica. Probá con un espesor menor.");
    }

    outputMesh = hollow.getMesh();
    const properties = outputMesh.vertProperties as ArrayLike<number>;
    const indices = outputMesh.triVerts as ArrayLike<number>;
    const propertyStride = outputMesh.numProp as number;
    if (propertyStride < 3 || indices.length < 12 || indices.length % 3 !== 0) {
      throw new Error("El motor devolvió una malla vaciada incompleta.");
    }
    const flattened: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      const offset = indices[i] * propertyStride;
      flattened.push(properties[offset], properties[offset + 1], properties[offset + 2]);
    }
    if (flattened.length < 36 || flattened.some((value) => !Number.isFinite(value))) {
      throw new Error("El motor devolvió una malla vaciada inválida.");
    }
    return flattened;
  } finally {
    outputMesh?.delete?.();
    openingSection?.delete?.();
    for (const manifold of new Set([hollow, shell, openingCutter, rotatedOpeningColumn, openingColumn, rotatedInner, inner, offsetSphere, outer, sourceMesh])) {
      manifold?.delete?.();
    }
    geometry.dispose();
  }
}

/**
 * Creates a hollow result for supported primitives and custom closed meshes.
 * Custom meshes use a spherical inward offset and are checked as manifold solids.
 */
export async function calculateHollow(
  object: ProjectObject,
  thickness: number | HollowWallThickness
): Promise<number[]> {
  if (object.kind === "custom") {
    const wallThickness = typeof thickness === "number" ? thickness : thickness.left;
    return calculateCustomHollow(object, wallThickness);
  }

  if (object.kind === "sphere") {
    const wallThickness = typeof thickness === "number" ? thickness : thickness.left;
    if (!Number.isFinite(wallThickness) || wallThickness <= 0) {
      throw new Error("El espesor debe ser mayor que 0 mm.");
    }
    if (wallThickness * 2 >= Math.min(object.dimensions.x, object.dimensions.y, object.dimensions.z)) {
      throw new Error("El espesor es demasiado grande para el tamaño de la esfera.");
    }
    const cutter: ProjectObject = {
      id: crypto.randomUUID(), name: "Cortante interior", kind: "sphere", booleanRole: "cutter",
      position: { ...object.position },
      dimensions: { x: object.dimensions.x - wallThickness * 2, y: object.dimensions.y - wallThickness * 2, z: object.dimensions.z - wallThickness * 2 },
      rotation: { ...object.rotation }
    };
    return calculateBoolean([object, cutter], "subtract");
  }

  if (object.kind === "cylinder") {
    const radialThickness = typeof thickness === "number" ? thickness : thickness.left;
    if (!Number.isFinite(radialThickness) || radialThickness <= 0) {
      throw new Error("El espesor debe ser mayor que 0 mm.");
    }
    if (radialThickness * 2 >= Math.min(object.dimensions.x, object.dimensions.z)) {
      throw new Error("El espesor es demasiado grande para el diámetro del cilindro.");
    }
    const cutter: ProjectObject = {
      id: crypto.randomUUID(),
      name: "Cortante interior",
      kind: "cylinder",
      booleanRole: "cutter",
      position: { ...object.position },
      dimensions: {
        x: object.dimensions.x - radialThickness * 2,
        y: object.dimensions.y + 0.02,
        z: object.dimensions.z - radialThickness * 2
      },
      rotation: { ...object.rotation }
    };
    return calculateBoolean([object, cutter], "subtract");
  }

  const walls: HollowWallThickness = typeof thickness === "number"
    ? { left: thickness, right: thickness, front: thickness, back: thickness, bottom: thickness }
    : thickness;
  const values = Object.values(walls);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Todos los espesores deben ser mayores que 0 mm.");
  }
  const innerX = object.dimensions.x - walls.left - walls.right;
  const innerZ = object.dimensions.z - walls.front - walls.back;
  const innerY = object.dimensions.y - walls.bottom;
  if (innerX <= 0 || innerZ <= 0 || innerY <= 0) {
    throw new Error("Los espesores elegidos no caben dentro de las dimensiones de la pieza.");
  }

  const localOffset = new THREE.Vector3(
    (walls.left - walls.right) / 2,
    walls.bottom / 2 + 0.01,
    (walls.front - walls.back) / 2
  );
  const rotation = new THREE.Euler(
    THREE.MathUtils.degToRad(object.rotation.x),
    THREE.MathUtils.degToRad(object.rotation.y),
    THREE.MathUtils.degToRad(object.rotation.z)
  );
  localOffset.applyEuler(rotation);

  const cutter: ProjectObject = {
    id: crypto.randomUUID(),
    name: "Cortante interior",
    kind: "box",
    booleanRole: "cutter",
    position: {
      x: object.position.x + localOffset.x,
      y: object.position.y + localOffset.y,
      z: object.position.z + localOffset.z
    },
    dimensions: { x: innerX, y: innerY + 0.02, z: innerZ },
    rotation: { ...object.rotation }
  };
  return calculateBoolean([object, cutter], "subtract");
}

/**
 * Cut a mesh with a horizontal plane at an absolute world-space Y height.
 * Returns a closed manifold mesh of the portion below the plane.
 */
export async function calculateHeightCut(object: ProjectObject, height: number): Promise<number[]> {
  if (!Number.isFinite(height)) throw new Error("La altura de corte debe ser un número válido.");
  const geometry = createWorldGeometry(object);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  geometry.dispose();
  if (!bounds) throw new Error("No se pudieron calcular los límites de la pieza.");
  if (height <= bounds.min.y + 1e-5) throw new Error("La altura elegida dejaría la pieza sin volumen.");
  if (height >= bounds.max.y - 1e-5) throw new Error("La altura de corte debe estar por debajo de la parte superior de la pieza.");
  const margin = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z, 10) + 10;
  const cutter: ProjectObject = {
    id: crypto.randomUUID(),
    name: "Plano de corte",
    kind: "box",
    booleanRole: "cutter",
    position: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (height + bounds.max.y + margin) / 2,
      z: (bounds.min.z + bounds.max.z) / 2
    },
    dimensions: {
      x: bounds.max.x - bounds.min.x + margin * 2,
      y: bounds.max.y - height + margin,
      z: bounds.max.z - bounds.min.z + margin * 2
    },
    rotation: { x: 0, y: 0, z: 0 }
  };
  return calculateBoolean([{ ...object, booleanRole: "solid" }, cutter], "subtract");
}


/**
 * Returns the closed upper portion of a mesh cut at an absolute world-space Y height.
 */
export async function calculateHeightUpper(object: ProjectObject, height: number): Promise<number[]> {
  if (!Number.isFinite(height)) throw new Error("La altura de corte debe ser un número válido.");
  const geometry = createWorldGeometry(object);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  geometry.dispose();
  if (!bounds) throw new Error("No se pudieron calcular los límites de la pieza.");
  if (height <= bounds.min.y + 1e-5) throw new Error("La altura elegida dejaría la parte superior sin volumen.");
  if (height >= bounds.max.y - 1e-5) throw new Error("La altura de corte debe estar por debajo de la parte superior de la pieza.");
  const margin = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z, 10) + 10;
  const cutter: ProjectObject = {
    id: crypto.randomUUID(), name: "Plano de corte inferior", kind: "box", booleanRole: "cutter",
    position: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + height - margin) / 2,
      z: (bounds.min.z + bounds.max.z) / 2
    },
    dimensions: {
      x: bounds.max.x - bounds.min.x + margin * 2,
      y: height - bounds.min.y + margin,
      z: bounds.max.z - bounds.min.z + margin * 2
    },
    rotation: { x: 0, y: 0, z: 0 }
  };
  return calculateBoolean([{ ...object, booleanRole: "solid" }, cutter], "subtract");
}

/** Returns both independent closed solids produced by a horizontal height cut. */
export async function calculateHeightSplit(object: ProjectObject, height: number): Promise<{ lower: number[]; upper: number[] }> {
  const [lower, upper] = await Promise.all([
    calculateHeightCut(object, height),
    calculateHeightUpper(object, height)
  ]);
  return { lower, upper };
}

