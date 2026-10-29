import Module from "manifold-3d";

type WorkerRequest =
  | { id: number; kind: "hollow"; vertices: Float32Array; bounds: { min: [number, number, number]; max: [number, number, number] }; thickness: number; openTop: boolean }
  | { id: number; kind: "subtract"; source: Float32Array; cutter: Float32Array }
  | { id: number; kind: "split"; source: Float32Array; negativeCutter: Float32Array; positiveCutter: Float32Array }
  | { id: number; kind: "interlock"; negative: Float32Array; positive: Float32Array; pegs: Float32Array[]; sockets: Float32Array[] };
type WorkerResponse = { id: number; vertices?: Float32Array; negative?: Float32Array; positive?: Float32Array; error?: string };
type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;
let manifoldPromise: Promise<Awaited<ReturnType<typeof Module>>> | null = null;

async function getManifoldApi() {
  if (!manifoldPromise) {
    manifoldPromise = Module().then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return manifoldPromise;
}

function makeSolid(wasm: Awaited<ReturnType<typeof Module>>, vertices: Float32Array, meshes: Set<any>, solids: Set<any>) {
  if (vertices.length < 36 || vertices.length % 9 !== 0) {
    throw new Error("La malla no contiene triángulos válidos.");
  }
  for (let index = 0; index < vertices.length; index++) {
    if (!Number.isFinite(vertices[index])) throw new Error("La malla contiene coordenadas inválidas.");
  }
  const indices = new Uint32Array(vertices.length / 3);
  for (let index = 0; index < indices.length; index++) indices[index] = index;
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: vertices,
    triVerts: indices,
    runIndex: new Uint32Array([0]),
    runOriginalID: new Uint32Array([0])
  });
  meshes.add(mesh);
  mesh.merge();
  let solid: any;
  try {
    solid = new wasm.Manifold(mesh);
  } catch {
    throw new Error("La malla no es un sólido cerrado válido. Revisá la geometría antes de continuar.");
  }
  solids.add(solid);
  if (solid.status() !== "NoError" || solid.isEmpty()) {
    throw new Error("La malla no es un sólido cerrado válido. Revisá la geometría antes de continuar.");
  }
  return solid;
}

function toTriangleSoup(mesh: any): Float32Array {
  const properties = mesh.vertProperties as ArrayLike<number>;
  const indices = mesh.triVerts as ArrayLike<number>;
  const stride = mesh.numProp as number;
  if (stride < 3 || indices.length < 12 || indices.length % 3 !== 0) {
    throw new Error("El motor devolvió una malla vacía o inválida.");
  }
  const flattened = new Float32Array(indices.length * 3);
  for (let index = 0; index < indices.length; index++) {
    const offset = indices[index] * stride;
    flattened[index * 3] = properties[offset];
    flattened[index * 3 + 1] = properties[offset + 1];
    flattened[index * 3 + 2] = properties[offset + 2];
    if (!Number.isFinite(flattened[index * 3]) || !Number.isFinite(flattened[index * 3 + 1]) || !Number.isFinite(flattened[index * 3 + 2])) {
      throw new Error("El motor devolvió una malla con coordenadas inválidas.");
    }
  }
  return flattened;
}

function checkSolid(solid: any, message: string) {
  if (solid.status() !== "NoError" || solid.isEmpty()) throw new Error(message);
  const volume = solid.volume();
  if (!Number.isFinite(volume) || volume <= 1e-8) throw new Error(message);
  return volume;
}

async function hollow(request: Extract<WorkerRequest, { kind: "hollow" }>, wasm: Awaited<ReturnType<typeof Module>>, meshes: Set<any>, solids: Set<any>) {
  const outer = makeSolid(wasm, request.vertices, meshes, solids);
  const outerVolume = checkSolid(outer, "La malla no es un sólido cerrado válido. Revisá la geometría antes de vaciarla.");
  let offsetSphere: any = null;
  let inner: any = null;
  let shell: any = null;
  let rotatedInner: any = null;
  let openingSection: any = null;
  let openingColumn: any = null;
  let rotatedOpeningColumn: any = null;
  let openingCutter: any = null;
  let result: any = null;
  let outputMesh: any = null;
  try {
    try {
      // A moderate sphere resolution keeps the offset responsive while retaining a smooth cavity.
      offsetSphere = wasm.Manifold.sphere(request.thickness, 16);
      solids.add(offsetSphere);
      inner = outer.minkowskiDifference(offsetSphere);
      solids.add(inner);
    } catch {
      throw new Error("No se pudo calcular el interior de la malla. Probá con un espesor menor.");
    }
    const innerVolume = checkSolid(inner, "Ese espesor no deja una cavidad válida dentro de la pieza. Probá con un espesor menor.");
    const volumeTolerance = Math.max(outerVolume * 1e-10, 1e-8);
    if (innerVolume <= volumeTolerance || innerVolume >= outerVolume - volumeTolerance) {
      throw new Error("Ese espesor no deja una cavidad válida dentro de la pieza. Probá con un espesor menor.");
    }

    shell = outer.subtract(inner);
    solids.add(shell);
    if (request.openTop) {
      const size = request.bounds.max.map((value, axis) => value - request.bounds.min[axis]);
      const maxExtent = Math.max(...size);
      const epsilon = Math.min(Math.max(maxExtent * 1e-5, 1e-4), request.thickness * 0.05);
      const innerBounds = inner.boundingBox();
      const openingBottom = innerBounds.max[1] - epsilon;
      const openingTop = request.bounds.max[1] + epsilon;
      if (openingTop <= openingBottom) throw new Error("No se pudo abrir la cavidad en la cara superior de la malla.");

      rotatedInner = inner.rotate([90, 0, 0]);
      solids.add(rotatedInner);
      const rotatedBounds = rotatedInner.boundingBox();
      openingSection = rotatedInner.slice(rotatedBounds.max[2] - epsilon);
      if (openingSection.numVert() < 3) throw new Error("No se pudo detectar una abertura válida en la cara superior.");
      openingColumn = openingSection.extrude(openingTop - openingBottom);
      solids.add(openingColumn);
      rotatedOpeningColumn = openingColumn.rotate([-90, 0, 0]);
      solids.add(rotatedOpeningColumn);
      openingCutter = rotatedOpeningColumn.translate([0, openingBottom, 0]);
      solids.add(openingCutter);
      try {
        result = shell.subtract(openingCutter);
      } catch {
        throw new Error("No se pudo abrir la cavidad en la cara superior. Probá con otro espesor de pared.");
      }
      solids.add(result);
    } else {
      result = shell;
    }

    const resultVolume = checkSolid(result, "El vaciado no pasó la validación geométrica. Probá con un espesor menor.");
    if (resultVolume <= volumeTolerance || resultVolume >= outerVolume - volumeTolerance) {
      throw new Error("El vaciado no pasó la validación geométrica. Probá con un espesor menor.");
    }
    outputMesh = result.getMesh();
    return toTriangleSoup(outputMesh);
  } finally {
    outputMesh?.delete?.();
    openingSection?.delete?.();
    for (const solid of [result, openingCutter, rotatedOpeningColumn, openingColumn, rotatedInner, shell, inner, offsetSphere]) {
      if (solid) solids.add(solid);
    }
  }
}

function disposeAll(meshes: Set<any>, solids: Set<any>) {
  for (const solid of solids) solid?.delete?.();
  for (const mesh of meshes) mesh?.delete?.();
}

scope.addEventListener("message", (event) => {
  const request = event.data;
  void (async () => {
    const meshes = new Set<any>();
    const solids = new Set<any>();
    let outputMesh: any = null;
    try {
      scope.postMessage({ id: request.id });
      const wasm = await getManifoldApi();
      if (request.kind === "hollow") {
        const vertices = await hollow(request, wasm, meshes, solids);
        scope.postMessage({ id: request.id, vertices }, [vertices.buffer]);
        return;
      }
      const source = request.kind === "interlock"
        ? makeSolid(wasm, request.negative, meshes, solids)
        : makeSolid(wasm, request.source, meshes, solids);
      if (request.kind === "subtract") {
        const cutter = makeSolid(wasm, request.cutter, meshes, solids);
        const result = source.subtract(cutter);
        solids.add(result);
        checkSolid(result, "El corte no produjo una pieza válida.");
        outputMesh = result.getMesh();
        const vertices = toTriangleSoup(outputMesh);
        scope.postMessage({ id: request.id, vertices }, [vertices.buffer]);
        return;
      }
      if (request.kind === "interlock") {
        const positive = makeSolid(wasm, request.positive, meshes, solids);
        if (request.pegs.length === 0 || request.pegs.length !== request.sockets.length) {
          throw new Error("La cantidad de encastres macho y hembra debe coincidir.");
        }
        let negativeResult = source;
        let positiveResult = positive;
        for (let index = 0; index < request.pegs.length; index++) {
          const peg = makeSolid(wasm, request.pegs[index], meshes, solids);
          const pegContact = peg.intersect(source);
          solids.add(pegContact);
          if (pegContact.status() !== "NoError" || pegContact.volume() <= 1e-8) {
            throw new Error("El encastre macho " + (index + 1) + " no apoya sobre la pieza. Probá con menos encastres o un corte distinto.");
          }
          const joinedNegative = negativeResult.add(peg);
          solids.add(joinedNegative);
          negativeResult = joinedNegative;

          const socket = makeSolid(wasm, request.sockets[index], meshes, solids);
          const socketContact = socket.intersect(positive);
          solids.add(socketContact);
          if (socketContact.status() !== "NoError" || socketContact.volume() <= 1e-8) {
            throw new Error("El encastre hembra " + (index + 1) + " no entra en la pieza. Probá con menos encastres o un corte distinto.");
          }
          const cutPositive = positiveResult.subtract(socket);
          solids.add(cutPositive);
          positiveResult = cutPositive;
        }
        const originalNegativeVolume = source.volume();
        const originalPositiveVolume = positive.volume();
        const negativeVolume = checkSolid(negativeResult, "El lado macho no produjo un sólido válido.");
        const positiveVolume = checkSolid(positiveResult, "El lado hembra no produjo un sólido válido.");
        if (negativeVolume <= originalNegativeVolume + 1e-8 || positiveVolume >= originalPositiveVolume - 1e-8) {
          throw new Error("No se pudieron integrar los encastres en las dos mitades.");
        }
        const negativeMesh = negativeResult.getMesh();
        const positiveMesh = positiveResult.getMesh();
        try {
          const negativeVertices = toTriangleSoup(negativeMesh);
          const positiveVertices = toTriangleSoup(positiveMesh);
          scope.postMessage({ id: request.id, negative: negativeVertices, positive: positiveVertices }, [negativeVertices.buffer, positiveVertices.buffer]);
        } finally {
          negativeMesh.delete?.();
          positiveMesh.delete?.();
        }
        return;
      }
      const negativeCutter = makeSolid(wasm, request.negativeCutter, meshes, solids);
      const positiveCutter = makeSolid(wasm, request.positiveCutter, meshes, solids);
      const negative = source.subtract(positiveCutter);
      const positive = source.subtract(negativeCutter);
      solids.add(negative);
      solids.add(positive);
      checkSolid(negative, "El corte no dejó un sólido válido en el lado negativo.");
      checkSolid(positive, "El corte no dejó un sólido válido en el lado positivo.");
      const negativeMesh = negative.getMesh();
      const positiveMesh = positive.getMesh();
      try {
        const negativeVertices = toTriangleSoup(negativeMesh);
        const positiveVertices = toTriangleSoup(positiveMesh);
        scope.postMessage({ id: request.id, negative: negativeVertices, positive: positiveVertices }, [negativeVertices.buffer, positiveVertices.buffer]);
      } finally {
        negativeMesh.delete?.();
        positiveMesh.delete?.();
      }
    } catch (error) {
      scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : "No se pudo completar la operación geométrica." });
    } finally {
      outputMesh?.delete?.();
      disposeAll(meshes, solids);
    }
  })();
});

