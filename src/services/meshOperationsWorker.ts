type Bounds = { min: [number, number, number]; max: [number, number, number] };
type WorkerRequest =
  | { id: number; kind: "hollow"; vertices: Float32Array; bounds: Bounds; thickness: number; openTop: boolean }
  | { id: number; kind: "subtract"; source: Float32Array; cutter: Float32Array }
  | { id: number; kind: "split"; source: Float32Array; negativeCutter: Float32Array; positiveCutter: Float32Array };
type WorkerTask =
  | { kind: "hollow"; vertices: Float32Array; bounds: Bounds; thickness: number; openTop: boolean }
  | { kind: "subtract"; source: Float32Array; cutter: Float32Array }
  | { kind: "split"; source: Float32Array; negativeCutter: Float32Array; positiveCutter: Float32Array };
type WorkerResponse = { id: number; vertices?: Float32Array; negative?: Float32Array; positive?: Float32Array; error?: string };

let nextRequestId = 1;

function runWorker(request: WorkerTask, signal?: AbortSignal): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("La operación fue cancelada.", "AbortError"));
      return;
    }
    const id = nextRequestId++;
    const worker = new Worker(new URL("./meshOperations.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (error?: Error, response?: WorkerResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else if (response?.error) reject(new Error(response.error));
      else if (response) resolve(response);
      else reject(new Error("El motor geométrico no devolvió un resultado."));
    };
    const abort = () => finish(new DOMException("La operación fue cancelada.", "AbortError"));
    const timeout = window.setTimeout(() => finish(new Error("El cálculo geométrico tardó demasiado. Probá con una malla menos detallada o un espesor menor.")), 90000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (!response.vertices && !response.negative && !response.positive && !response.error) return;
      finish(undefined, response);
    };
    worker.onerror = (event) => finish(new Error(event.message || "Falló el cálculo geométrico en segundo plano."));
    worker.onmessageerror = () => finish(new Error("No se pudo leer la respuesta del cálculo geométrico."));
    const task = { ...request, id } as WorkerRequest;
    const transfer: Transferable[] = [];
    if ("vertices" in task) transfer.push(task.vertices.buffer as ArrayBuffer);
    if ("source" in task) transfer.push(task.source.buffer as ArrayBuffer);
    if ("cutter" in task) transfer.push(task.cutter.buffer as ArrayBuffer);
    if ("negativeCutter" in task) transfer.push(task.negativeCutter.buffer as ArrayBuffer);
    if ("positiveCutter" in task) transfer.push(task.positiveCutter.buffer as ArrayBuffer);
    worker.postMessage(task, transfer);
  });
}

export async function hollowCustomMeshInWorker(
  vertices: Float32Array,
  bounds: Bounds,
  thickness: number,
  openTop: boolean
): Promise<number[]> {
  const response = await runWorker({ kind: "hollow", vertices, bounds, thickness, openTop });
  if (!response.vertices) throw new Error("El motor no devolvió la malla vaciada.");
  return Array.from(response.vertices);
}

export async function subtractMeshInWorker(source: Float32Array, cutter: Float32Array, signal?: AbortSignal): Promise<number[]> {
  const response = await runWorker({ kind: "subtract", source, cutter }, signal);
  if (!response.vertices) throw new Error("El motor no devolvió la malla cortada.");
  return Array.from(response.vertices);
}

export async function splitMeshInWorker(
  source: Float32Array,
  negativeCutter: Float32Array,
  positiveCutter: Float32Array
): Promise<{ negative: number[]; positive: number[] }> {
  const response = await runWorker({ kind: "split", source, negativeCutter, positiveCutter });
  if (!response.negative || !response.positive) throw new Error("El motor no devolvió las dos partes del corte.");
  return { negative: Array.from(response.negative), positive: Array.from(response.positive) };
}


