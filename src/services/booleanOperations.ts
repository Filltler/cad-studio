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
  }
  geometry.clearGroups();
  return geometry;
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
