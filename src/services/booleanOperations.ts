import * as THREE from "three";
import Module from "manifold-3d";
import type { ProjectObject } from "../domain/project";
import { addInterlocksInWorker, hollowCustomMeshInWorker, splitMeshInWorker, subtractMeshInWorker } from "./meshOperationsWorker";

export type BooleanOperation = "union" | "subtract" | "intersect";
export type CutAxis = "x" | "y" | "z";

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


function triangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const position = geometry.getAttribute("position");
  if (!position || position.count < 4) throw new Error("La pieza no contiene una malla válida.");
  const index = geometry.getIndex();
  if (!index) return Float32Array.from(position.array as ArrayLike<number>);
  const flattened = new Float32Array(index.count * 3);
  for (let offset = 0; offset < index.count; offset++) {
    const vertex = index.getX(offset);
    flattened[offset * 3] = position.getX(vertex);
    flattened[offset * 3 + 1] = position.getY(vertex);
    flattened[offset * 3 + 2] = position.getZ(vertex);
  }
  return flattened;
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
  try {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds) throw new Error("No se pudieron calcular los límites de la malla personalizada.");
    const size = bounds.getSize(new THREE.Vector3());
    const minimumExtent = Math.min(size.x, size.y, size.z);
    if (!Number.isFinite(minimumExtent) || minimumExtent <= 1e-5) {
      throw new Error("La malla personalizada debe tener volumen en las tres dimensiones.");
    }
    if (wallThickness * 2 >= minimumExtent - 1e-5) {
      throw new Error("Ese espesor es demasiado grande para el tamaño de la malla personalizada.");
    }

    const vertices = triangleSoup(geometry);
    return await hollowCustomMeshInWorker(
      vertices,
      {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z]
      },
      wallThickness,
      hasPlanarTopFace(geometry, bounds)
    );
  } finally {
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

type CutSide = "negative" | "positive";

function validateCutCoordinate(bounds: THREE.Box3, axis: CutAxis, coordinate: number) {
  if (!Number.isFinite(coordinate)) throw new Error("La posición del corte debe ser un número válido.");
  const minimum = bounds.min[axis];
  const maximum = bounds.max[axis];
  const epsilon = Math.max((maximum - minimum) * 1e-6, 1e-5);
  if (coordinate <= minimum + epsilon) throw new Error("El corte debe quedar dentro de los límites de la pieza, no en el borde mínimo.");
  if (coordinate >= maximum - epsilon) throw new Error("El corte debe quedar dentro de los límites de la pieza, no en el borde máximo.");
}

function createAxisCutter(bounds: THREE.Box3, axis: CutAxis, coordinate: number, removeSide: CutSide): THREE.BufferGeometry {
  const size = bounds.getSize(new THREE.Vector3());
  const margin = Math.max(size.x, size.y, size.z, 1) + 1;
  const minimum = { x: bounds.min.x - margin, y: bounds.min.y - margin, z: bounds.min.z - margin };
  const maximum = { x: bounds.max.x + margin, y: bounds.max.y + margin, z: bounds.max.z + margin };
  if (removeSide === "positive") minimum[axis] = coordinate;
  else maximum[axis] = coordinate;

  const cutter: ProjectObject = {
    id: crypto.randomUUID(),
    name: "Plano de corte",
    kind: "box",
    booleanRole: "cutter",
    position: {
      x: (minimum.x + maximum.x) / 2,
      y: (minimum.y + maximum.y) / 2,
      z: (minimum.z + maximum.z) / 2
    },
    dimensions: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z
    },
    rotation: { x: 0, y: 0, z: 0 }
  };
  return createWorldGeometry(cutter);
}

function getCutGeometry(object: ProjectObject) {
  const geometry = createWorldGeometry(object);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox?.clone();
  if (!bounds) {
    geometry.dispose();
    throw new Error("No se pudieron calcular los límites de la pieza.");
  }
  return { geometry, bounds };
}

/** Returns the negative-side portion of a mesh cut on a world-space X, Y, or Z plane. */
export async function calculatePlanarCut(object: ProjectObject, axis: CutAxis, coordinate: number, signal?: AbortSignal): Promise<number[]> {
  const { geometry, bounds } = getCutGeometry(object);
  let cutterGeometry: THREE.BufferGeometry | null = null;
  try {
    validateCutCoordinate(bounds, axis, coordinate);
    const source = triangleSoup(geometry);
    cutterGeometry = createAxisCutter(bounds, axis, coordinate, "positive");
    return await subtractMeshInWorker(source, triangleSoup(cutterGeometry), signal);
  } finally {
    cutterGeometry?.dispose();
    geometry.dispose();
  }
}

/** Returns both independent solids produced by a planar X, Y, or Z cut. */
export async function calculatePlanarSplit(
  object: ProjectObject,
  axis: CutAxis,
  coordinate: number
): Promise<{ negative: number[]; positive: number[] }> {
  const { geometry, bounds } = getCutGeometry(object);
  let negativeCutterGeometry: THREE.BufferGeometry | null = null;
  let positiveCutterGeometry: THREE.BufferGeometry | null = null;
  try {
    validateCutCoordinate(bounds, axis, coordinate);
    const source = triangleSoup(geometry);
    negativeCutterGeometry = createAxisCutter(bounds, axis, coordinate, "negative");
    positiveCutterGeometry = createAxisCutter(bounds, axis, coordinate, "positive");
    return await splitMeshInWorker(source, triangleSoup(negativeCutterGeometry), triangleSoup(positiveCutterGeometry));
  } finally {
    negativeCutterGeometry?.dispose();
    positiveCutterGeometry?.dispose();
    geometry.dispose();
  }
}

export type InterlockShape = "round" | "square" | "elastic";
export type PlanarCutFaceBounds = {
  firstAxis: CutAxis;
  secondAxis: CutAxis;
  minFirst: number;
  maxFirst: number;
  minSecond: number;
  maxSecond: number;
};
export type InterlockSuggestion = { diameter: number; depth: number; embed: number; available: boolean };

export function getPlanarCutFaceBounds(vertices: number[], axis: CutAxis, coordinate: number): PlanarCutFaceBounds | null {
  const faceAxes: Record<CutAxis, [CutAxis, CutAxis]> = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] };
  const [firstAxis, secondAxis] = faceAxes[axis];
  const axisIndex = { x: 0, y: 1, z: 2 } as const;
  const cutIndex = axisIndex[axis];
  const firstIndex = axisIndex[firstAxis];
  const secondIndex = axisIndex[secondAxis];
  const tolerance = Math.max(Math.abs(coordinate) * 1e-6, 1e-4);
  let minFirst = Infinity, maxFirst = -Infinity;
  let minSecond = Infinity, maxSecond = -Infinity;
  let found = false;
  for (let index = 0; index + 8 < vertices.length; index += 9) {
    if (
      Math.abs(vertices[index + cutIndex] - coordinate) > tolerance ||
      Math.abs(vertices[index + 3 + cutIndex] - coordinate) > tolerance ||
      Math.abs(vertices[index + 6 + cutIndex] - coordinate) > tolerance
    ) continue;
    for (const vertexOffset of [index, index + 3, index + 6]) {
      minFirst = Math.min(minFirst, vertices[vertexOffset + firstIndex]);
      maxFirst = Math.max(maxFirst, vertices[vertexOffset + firstIndex]);
      minSecond = Math.min(minSecond, vertices[vertexOffset + secondIndex]);
      maxSecond = Math.max(maxSecond, vertices[vertexOffset + secondIndex]);
    }
    found = true;
  }
  if (!found || maxFirst - minFirst <= 0.01 || maxSecond - minSecond <= 0.01) return null;
  return { firstAxis, secondAxis, minFirst, maxFirst, minSecond, maxSecond };
}

export function suggestPlanarInterlocks(
  face: PlanarCutFaceBounds | null,
  bounds: THREE.Box3,
  axis: CutAxis,
  coordinate: number,
  count: number
): InterlockSuggestion {
  if (!face || !Number.isInteger(count) || count < 1 || count > 6) {
    return { diameter: 0, depth: 0, embed: 0, available: false };
  }
  const firstSize = face.maxFirst - face.minFirst;
  const secondSize = face.maxSecond - face.minSecond;
  const shortSide = Math.min(firstSize, secondSize);
  const longSide = Math.max(firstSize, secondSize);
  const diameter = Math.floor(Math.min(8, shortSide * 0.28, longSide / (count * 1.8)) * 10) / 10;
  const negativeThickness = coordinate - bounds.min[axis];
  const positiveThickness = bounds.max[axis] - coordinate;
  const embed = Math.min(Math.max(diameter * 0.18, 0.35), negativeThickness * 0.2);
  const depth = Math.min(Math.max(diameter * 1.2, 2), positiveThickness * 0.45);
  const available = diameter >= 1.2 && embed >= 0.25 && depth >= Math.max(1.5, diameter * 0.65);
  return { diameter, depth: Math.floor(depth * 10) / 10, embed: Math.floor(embed * 10) / 10, available };
}

function makeConnectorGeometry(
  center: THREE.Vector3,
  axis: CutAxis,
  shape: InterlockShape,
  width: number,
  start: number,
  end: number
): THREE.BufferGeometry {
  const length = end - start;
  if (length <= 0) throw new Error("La longitud del encastre debe ser mayor que 0 mm.");
  const geometry = shape === "round"
    ? new THREE.CylinderGeometry(width / 2, width / 2, length, 32)
    : new THREE.BoxGeometry(width, length, width);
  const mesh = new THREE.Mesh(geometry);
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  else if (axis === "z") mesh.rotation.x = Math.PI / 2;
  mesh.position.copy(center);
  mesh.position[axis] = (start + end) / 2;
  mesh.updateMatrixWorld(true);
  geometry.applyMatrix4(mesh.matrixWorld);
  return geometry;
}

function makeElasticSnapGeometry(
  points: Array<[number, number]>,
  axis: CutAxis,
  shortAxis: CutAxis,
  longAxis: CutAxis,
  centerShort: number,
  centerLong: number,
  coordinate: number,
  width: number
): THREE.BufferGeometry {
  const signedArea = points.reduce((area, [shortOffset, axisOffset], index) => {
    const next = points[(index + 1) % points.length];
    return area + shortOffset * next[1] - next[0] * axisOffset;
  }, 0);
  const orderedPoints = signedArea >= 0 ? points : [...points].reverse();
  const profile = new THREE.Shape();
  orderedPoints.forEach(([shortOffset, axisOffset], index) => {
    if (index === 0) profile.moveTo(shortOffset, axisOffset);
    else profile.lineTo(shortOffset, axisOffset);
  });
  profile.closePath();
  const geometry = new THREE.ExtrudeGeometry(profile, { depth: width, bevelEnabled: false, steps: 1, curveSegments: 1 });
  const position = geometry.getAttribute("position");
  const indices: Record<CutAxis, number> = { x: 0, y: 1, z: 2 };
  const permutation = [indices[shortAxis], indices[axis], indices[longAxis]];
  let inversions = 0;
  for (let first = 0; first < permutation.length; first++) {
    for (let second = first + 1; second < permutation.length; second++) {
      if (permutation[first] > permutation[second]) inversions++;
    }
  }
  const reversesWinding = inversions % 2 === 1;
  for (let index = 0; index < position.count; index++) {
    const world = [0, 0, 0];
    world[indices[shortAxis]] = centerShort + position.getX(index);
    world[indices[axis]] = coordinate + position.getY(index);
    world[indices[longAxis]] = centerLong + position.getZ(index) - width / 2;
    position.setXYZ(index, world[0], world[1], world[2]);
  }
  if (reversesWinding) {
    for (let triangle = 0; triangle + 2 < position.count; triangle += 3) {
      const second = new THREE.Vector3().fromBufferAttribute(position, triangle + 1);
      const third = new THREE.Vector3().fromBufferAttribute(position, triangle + 2);
      position.setXYZ(triangle + 1, third.x, third.y, third.z);
      position.setXYZ(triangle + 2, second.x, second.y, second.z);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
function combineTriangleSoups(parts: Float32Array[]): Float32Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}
export async function addInterlocksToPlanarSplit(
  parts: { negative: number[]; positive: number[] },
  axis: CutAxis,
  coordinate: number,
  bounds: THREE.Box3,
  shape: InterlockShape,
  count: number,
  clearance: number
): Promise<{ negative: number[]; positive: number[] }> {
  if (!Number.isFinite(clearance) || clearance < 0.1 || clearance > 1) {
    throw new Error("La holgura debe estar entre 0,1 y 1 mm.");
  }
  const face = getPlanarCutFaceBounds(parts.negative, axis, coordinate);
  const suggestion = suggestPlanarInterlocks(face, bounds, axis, coordinate, count);
  if (!face || !suggestion.available) {
    throw new Error("No hay suficiente superficie o espesor para ese número de encastres. Probá con menos encastres o un corte más centrado.");
  }

  const firstSize = face.maxFirst - face.minFirst;
  const secondSize = face.maxSecond - face.minSecond;
  const longAxis = firstSize >= secondSize ? face.firstAxis : face.secondAxis;
  const shortAxis = longAxis === face.firstAxis ? face.secondAxis : face.firstAxis;
  const longMinimum = longAxis === face.firstAxis ? face.minFirst : face.minSecond;
  const longMaximum = longAxis === face.firstAxis ? face.maxFirst : face.maxSecond;
  const shortMinimum = shortAxis === face.firstAxis ? face.minFirst : face.minSecond;
  const shortMaximum = shortAxis === face.firstAxis ? face.maxFirst : face.maxSecond;
  const longSize = longMaximum - longMinimum;
  const center = new THREE.Vector3();
  center[shortAxis] = (shortMinimum + shortMaximum) / 2;
  const pegGeometries: THREE.BufferGeometry[] = [];
  const socketGeometries: THREE.BufferGeometry[] = [];
  const pegs: Float32Array[] = [];
  try {
    for (let index = 0; index < count; index++) {
      center[longAxis] = longMinimum + longSize * (index + 1) / (count + 1);
      if (shape === "elastic") {
        const stemWidth = Math.min(1, Math.max(0.65, suggestion.diameter * 0.16));
        const gap = stemWidth * 0.65;
        const hookHeight = Math.min(0.9, Math.max(0.45, suggestion.diameter * 0.14));
        const shoulderDepth = Math.min(1.2, suggestion.depth * 0.3);
        const rampLength = Math.min(0.9, suggestion.depth * 0.24);
        const shoulderStart = suggestion.depth - shoulderDepth;
        const rampStart = suggestion.depth - rampLength;
        const prongCenter = stemWidth / 2 + gap / 2;
        const rightProng = [
          [prongCenter - stemWidth / 2, -suggestion.embed],
          [prongCenter + stemWidth / 2, -suggestion.embed],
          [prongCenter + stemWidth / 2, shoulderStart],
          [prongCenter + stemWidth / 2 + hookHeight, shoulderStart],
          [prongCenter + stemWidth / 2 + hookHeight, rampStart],
          [prongCenter + stemWidth / 2, suggestion.depth],
          [prongCenter - stemWidth / 2, suggestion.depth]
        ] as Array<[number, number]>;
        const leftProng = rightProng.map(([shortOffset, axisOffset]) => [-shortOffset, axisOffset] as [number, number]);
        const rightGeometry = makeElasticSnapGeometry(
          rightProng, axis, shortAxis, longAxis,
          center[shortAxis], center[longAxis], coordinate, suggestion.diameter
        );
        const leftGeometry = makeElasticSnapGeometry(
          leftProng, axis, shortAxis, longAxis,
          center[shortAxis], center[longAxis], coordinate, suggestion.diameter
        );
        pegGeometries.push(rightGeometry, leftGeometry);
        pegs.push(combineTriangleSoups([triangleSoup(rightGeometry), triangleSoup(leftGeometry)]));

        const channelHalfWidth = prongCenter + stemWidth / 2 + clearance;
        const pocketHalfWidth = channelHalfWidth + hookHeight;
        const socketGeometry = makeElasticSnapGeometry([
          [-channelHalfWidth, -0.05],
          [channelHalfWidth, -0.05],
          [channelHalfWidth, shoulderStart],
          [pocketHalfWidth, shoulderStart],
          [pocketHalfWidth, suggestion.depth + 0.35],
          [-pocketHalfWidth, suggestion.depth + 0.35],
          [-pocketHalfWidth, shoulderStart],
          [-channelHalfWidth, shoulderStart]
        ], axis, shortAxis, longAxis, center[shortAxis], center[longAxis], coordinate, suggestion.diameter + clearance * 2);
        socketGeometries.push(socketGeometry);
      } else {
        const pegGeometry = makeConnectorGeometry(
          center.clone(), axis, shape,
          suggestion.diameter,
          coordinate - suggestion.embed, coordinate + suggestion.depth
        );
        const socketGeometry = makeConnectorGeometry(
          center.clone(), axis, shape,
          suggestion.diameter + clearance * 2,
          coordinate - 0.05, coordinate + suggestion.depth + 0.35
        );
        pegGeometries.push(pegGeometry);
        socketGeometries.push(socketGeometry);
        pegs.push(triangleSoup(pegGeometry));
      }
    }
    const sockets = socketGeometries.map(triangleSoup);
    return await addInterlocksInWorker(
      Float32Array.from(parts.negative),
      Float32Array.from(parts.positive),
      pegs,
      sockets
    );
  } finally {
    pegGeometries.forEach((geometry) => geometry.dispose());
    socketGeometries.forEach((geometry) => geometry.dispose());
  }
}

/** Compatibility wrappers for the original Y-height cut behavior. */
export function calculateHeightCut(object: ProjectObject, height: number, signal?: AbortSignal): Promise<number[]> {
  return calculatePlanarCut(object, "y", height, signal);
}

export async function calculateHeightUpper(object: ProjectObject, height: number): Promise<number[]> {
  const { geometry, bounds } = getCutGeometry(object);
  let cutterGeometry: THREE.BufferGeometry | null = null;
  try {
    validateCutCoordinate(bounds, "y", height);
    const source = triangleSoup(geometry);
    cutterGeometry = createAxisCutter(bounds, "y", height, "negative");
    return await subtractMeshInWorker(source, triangleSoup(cutterGeometry));
  } finally {
    cutterGeometry?.dispose();
    geometry.dispose();
  }
}

export async function calculateHeightSplit(object: ProjectObject, height: number): Promise<{ lower: number[]; upper: number[] }> {
  const result = await calculatePlanarSplit(object, "y", height);
  return { lower: result.negative, upper: result.positive };
}

