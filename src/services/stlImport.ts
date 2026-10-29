import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

export type ParsedSTL = { vertices: number[]; dimensions: { x: number; y: number; z: number } };

export function parseSTL(buffer: ArrayBuffer): ParsedSTL {
  if (buffer.byteLength === 0) throw new Error("El archivo STL está vacío.");
  let geometry;
  try {
    geometry = new STLLoader().parse(buffer);
  } catch {
    throw new Error("No se pudo leer el archivo. Verificá que sea un STL válido.");
  }

  try {
    const position = geometry.getAttribute("position");
    if (!position || position.count < 12 || position.count % 3 !== 0) {
      throw new Error("El STL no contiene suficientes triángulos para formar una malla 3D.");
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error("El STL contiene coordenadas inválidas.");
      }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    const dimensions = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
    if (Object.values(dimensions).some((size) => !Number.isFinite(size) || size <= 0.001)) {
      throw new Error("El STL debe tener dimensiones 3D válidas en X, Y y Z.");
    }

    // Center the model over the bed and move its lowest Y point to Y = 0.
    geometry.translate(-(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2);
    const normalizedPosition = geometry.getAttribute("position");
    return { vertices: Array.from(normalizedPosition.array as ArrayLike<number>, Number), dimensions };
  } finally {
    geometry.dispose();
  }
}
