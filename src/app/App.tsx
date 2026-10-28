import { useCallback, useEffect, useState } from "react";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { Viewport } from "../features/viewport/Viewport";
import { useEditorStore } from "../features/editor/editorStore";
import { saveProject } from "../services/storage/projectStorage";
import { calculateBoolean, type BooleanOperation } from "../services/booleanOperations";

export function App() {
  const [advanced, setAdvanced] = useState(false);
  const [booleanSelection, setBooleanSelection] = useState<string[]>([]);
  const [viewportMultiSelect, setViewportMultiSelect] = useState(false);
  const [notice, setNotice] = useState("MiCAD · herramientas CAD en desarrollo");
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const addPrimitive = useEditorStore((s) => s.addPrimitive);
  const selectObject = useEditorStore((s) => s.selectObject);
  const updateObject = useEditorStore((s) => s.updateObject);
  const applyBooleanResult = useEditorStore((s) => s.applyBooleanResult);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const selected = objects.find((o) => o.id === selectedId);

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [undo, redo]);

  function toggleBooleanSelection(id: string) {
    setBooleanSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  const handleViewportObjectSelect = useCallback((id: string | null, additive: boolean) => {
    selectObject(id);
    if (id && additive) {
      setBooleanSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    }
  }, [selectObject]);

  async function handleBoolean(operation: BooleanOperation) {
    const selectedObjects = objects.filter((object) => booleanSelection.includes(object.id));
    const chosen = operation === "subtract"
      ? [...selectedObjects.filter((object) => object.booleanRole !== "cutter"), ...selectedObjects.filter((object) => object.booleanRole === "cutter")]
      : selectedObjects;
    if (operation === "subtract" && (!chosen.some((object) => object.booleanRole === "cutter") || !chosen.some((object) => object.booleanRole !== "cutter"))) {
      setNotice("Para Restar, marcá al menos un sólido objetivo y una pieza configurada como Cortante.");
      return;
    }
    if (chosen.length < 2) {
      setNotice("Marcá al menos dos piezas para realizar la operación.");
      return;
    }
    try {
      setNotice("Calculando operación booleana…");
      const vertices = await calculateBoolean(chosen, operation);
      const name = operation === "union" ? "Unión" : operation === "subtract" ? "Diferencia" : "Intersección";
      applyBooleanResult(chosen.map((object) => object.id), `Resultado ${name}`, vertices);
      setBooleanSelection([]);
      setNotice(`Operación ${name.toLowerCase()} completada. Se reemplazaron las piezas seleccionadas.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo completar la operación booleana.");
    }
  }

  async function handleSave() {
    try {
      await saveProject({
        schemaVersion: 1,
        id: "local-project",
        name: "Mi primer proyecto",
        units: "mm",
        objects,
        updatedAt: new Date().toISOString()
      });
      setNotice("Proyecto guardado localmente.");
    } catch {
      setNotice("No se pudo guardar el proyecto en este navegador.");
    }
  }

  function handleExportSTL() {
    if (objects.length === 0) {
      setNotice("Agregá al menos una pieza antes de exportar.");
      return;
    }

    const scene = new THREE.Scene();
    const geometries: THREE.BufferGeometry[] = [];
    for (const object of objects) {
      const geometry = object.kind === "custom"
        ? new THREE.BufferGeometry()
        : object.kind === "box"
          ? new THREE.BoxGeometry(1, 1, 1)
          : object.kind === "cylinder"
            ? new THREE.CylinderGeometry(0.5, 0.5, 1, 48)
            : new THREE.SphereGeometry(0.5, 32, 24);
      if (object.kind === "custom") {
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(object.geometryVertices ?? [], 3));
        geometry.computeVertexNormals();
      }
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry);
      if (object.kind === "custom") {
        mesh.position.set(0, 0, 0);
      } else {
        mesh.position.set(object.position.x, object.position.y, object.position.z);
        mesh.scale.set(object.dimensions.x, object.dimensions.y, object.dimensions.z);
        mesh.rotation.set(
        THREE.MathUtils.degToRad(object.rotation?.x ?? 0),
        THREE.MathUtils.degToRad(object.rotation?.y ?? 0),
        THREE.MathUtils.degToRad(object.rotation?.z ?? 0)
        );
      }
      scene.add(mesh);
    }

    try {
      scene.updateMatrixWorld(true);
      const exporter = new STLExporter();
      const result = exporter.parse(scene, { binary: true });
      const buffer = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
      const blob = new Blob([buffer], { type: "model/stl" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "micad-modelo.stl";
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Archivo STL exportado. Las piezas se guardaron juntas en milímetros.");
    } catch {
      setNotice("No se pudo exportar el STL.");
    } finally {
      geometries.forEach((geometry) => geometry.dispose());
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">M</div>
        <div className="brand-copy">
          <strong>MiCAD</strong>
          <span>Diseño CAD e impresión 3D</span>
        </div>
        <div className="topbar-spacer" />
        <span className="unit-chip">MM</span>
        <button className="secondary-button" onClick={undo} disabled={!canUndo} title="Deshacer (Ctrl+Z)">Deshacer</button>
        <button className="secondary-button" onClick={redo} disabled={!canRedo} title="Rehacer (Ctrl+Y)">Rehacer</button>
        <button className="secondary-button" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "Modo sencillo" : "Herramientas avanzadas"}
        </button>
        <button className="secondary-button" onClick={handleExportSTL}>Exportar STL</button>
        <button className="primary-button" onClick={handleSave}>Guardar proyecto</button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="section-heading">Crear objeto</div>
          <button className="tool-button" onClick={() => addPrimitive("box")}>
            <span className="tool-icon">▧</span><span><b>Cubo</b><small>Prisma rectangular</small></span>
          </button>
          <button className="tool-button" onClick={() => addPrimitive("cylinder")}>
            <span className="tool-icon">◯</span><span><b>Cilindro</b><small>Base circular</small></span>
          </button>
          <button className="tool-button" onClick={() => addPrimitive("sphere")}>
            <span className="tool-icon">●</span><span><b>Esfera</b><small>Volumen redondeado</small></span>
          </button>

          <div className="section-heading object-heading">Objetos del proyecto <span>{objects.length}</span></div>
          <div className="boolean-tools">
            <small>{viewportMultiSelect ? "Tocá piezas en el área 3D para agregarlas o quitarlas de la selección." : "Marcá las piezas que querés combinar o cortar."}</small>
            <button className={`secondary-button ${viewportMultiSelect ? "active" : ""}`} onClick={() => setViewportMultiSelect((active) => !active)} aria-pressed={viewportMultiSelect}>
              {viewportMultiSelect ? "Finalizar selección 3D" : "Seleccionar piezas en 3D"}
            </button>
            <div className="boolean-buttons">
              <button className="secondary-button" onClick={() => handleBoolean("union")}>Unión</button>
              <button className="secondary-button" onClick={() => handleBoolean("subtract")}>Restar</button>
            </div>
            <button className="secondary-button" onClick={() => handleBoolean("intersect")}>Intersección</button>
          </div>
          <div className="object-list">
            {objects.map((object) => (
              <div className="object-entry" key={object.id}>
                <button
                  className={`object-row ${selectedId === object.id ? "selected" : ""}`}
                  onClick={() => selectObject(object.id)}
                >
                  <input aria-label={`Incluir ${object.name} en operación booleana`} type="checkbox" checked={booleanSelection.includes(object.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleBooleanSelection(object.id)} />
                  <span className="object-dot" />
                  <span>{object.name}</span>
                </button>
                <select
                  aria-label={`Tipo booleano de ${object.name}`}
                  className="object-role-select"
                  value={object.booleanRole ?? "solid"}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => updateObject(object.id, { booleanRole: event.target.value as "solid" | "cutter" })}
                >
                  <option value="solid">Sólido</option>
                  <option value="cutter">Cortante</option>
                </select>
              </div>
            ))}
            {objects.length === 0 && <p className="empty-note">Todavía no hay objetos.</p>}
          </div>
          <div className="sidebar-footer">
            <span className="status-dot" /> Guardado local disponible
          </div>
        </aside>

        <section className="viewport-panel">
          <div className="viewport-toolbar">
            <span className="viewport-label">ESPACIO DE TRABAJO</span>
            <div className="viewport-actions">
              <span className="subtle-chip">Perspectiva</span>
              <span className="subtle-chip">Cuadrícula activa</span>
            </div>
          </div>
          <Viewport multiSelectMode={viewportMultiSelect} onObjectSelect={handleViewportObjectSelect} />
          <div className="viewport-bottom">
            <span>Arrastrá para orbitar · Rueda para zoom</span>
            <span>Unidades: milímetros</span>
          </div>
        </section>

        <aside className="properties-panel">
          <div className="section-heading">Propiedades</div>
          {selected ? (
            <>
              <div className="selected-object-card">
                <span className="object-preview">◇</span>
                <div><b>{selected.name}</b><small>{selected.kind === "custom" ? "SÓLIDO RESULTANTE" : selected.kind.toUpperCase()}</small></div>
              </div>
              <div className="property-section">
                <div className="property-title">Dimensiones <span>mm</span></div>
                {(["x", "y", "z"] as const).map((axis) => (
                  <label className="property-row" key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={Number(selected.dimensions[axis].toFixed(2))}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value) && value > 0) {
                          updateObject(selected.id, {
                            dimensions: { ...selected.dimensions, [axis]: value }
                          });
                        }
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="property-section">
                <div className="property-title">Posición <span>mm</span></div>
                {(["x", "y", "z"] as const).map((axis) => (
                  <label className="property-row" key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input
                      type="number"
                      step="1"
                      value={Number(selected.position[axis].toFixed(2))}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          updateObject(selected.id, {
                            position: { ...selected.position, [axis]: value }
                          });
                        }
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="property-section">
                <div className="property-title">Rotación <span>grados</span></div>
                {(["x", "y", "z"] as const).map((axis) => (
                  <label className="property-row" key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input
                      type="number"
                      step="15"
                      value={Number((selected.rotation?.[axis] ?? 0).toFixed(2))}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          updateObject(selected.id, {
                            rotation: { ...(selected.rotation ?? { x: 0, y: 0, z: 0 }), [axis]: value }
                          });
                        }
                      }}
                    />
                  </label>
                ))}
              </div>
              {advanced && (
                <div className="advanced-note">
                  <b>Modo avanzado</b>
                  <p>Esta zona se ampliará con tolerancias, parámetros CAD, restricciones y datos geométricos.</p>
                </div>
              )}
            </>
          ) : (
            <div className="no-selection">
              <span>◇</span>
              <b>Ningún objeto seleccionado</b>
              <p>Elegí un objeto de la lista o creá una figura para editar sus propiedades.</p>
            </div>
          )}
          <div className="properties-footer">{notice}</div>
        </aside>
      </div>
    </main>
  );
}
