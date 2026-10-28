import { useCallback, useEffect, useState } from "react";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { Viewport } from "../features/viewport/Viewport";
import { useEditorStore } from "../features/editor/editorStore";
import { listProjects, loadProject, saveProject } from "../services/storage/projectStorage";
import { calculateBoolean, calculateHollow, type BooleanOperation } from "../services/booleanOperations";

export function App() {
  const [advanced, setAdvanced] = useState(false);
  const [booleanSelection, setBooleanSelection] = useState<string[]>([]);
  const [viewportMultiSelect, setViewportMultiSelect] = useState(false);
  const [notice, setNotice] = useState("MiCAD · herramientas CAD en desarrollo");
  const [wallThicknesses, setWallThicknesses] = useState({ left: "2", right: "2", front: "2", back: "2", bottom: "2" });
  const [numericDraft, setNumericDraft] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState("local-project");
  const [projectName, setProjectName] = useState("Mi primer proyecto");
  const [projects, setProjects] = useState<Array<{ id: string; name: string; updatedAt: string }>>([]);
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const addPrimitive = useEditorStore((s) => s.addPrimitive);
  const selectObject = useEditorStore((s) => s.selectObject);
  const updateObject = useEditorStore((s) => s.updateObject);
  const applyBooleanResult = useEditorStore((s) => s.applyBooleanResult);
  const loadProjectObjects = useEditorStore((s) => s.loadProjectObjects);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const selected = objects.find((o) => o.id === selectedId);
  useEffect(() => {
    if (!selected) { setNumericDraft({}); return; }
    setNumericDraft({
      dimensionX: String(selected.dimensions.x), dimensionY: String(selected.dimensions.y), dimensionZ: String(selected.dimensions.z),
      positionX: String(selected.position.x), positionY: String(selected.position.y), positionZ: String(selected.position.z),
      rotationX: String(selected.rotation.x), rotationY: String(selected.rotation.y), rotationZ: String(selected.rotation.z)
    });
  }, [selectedId]);

  const refreshProjects = useCallback(async () => {
    const saved = await listProjects();
    setProjects(saved.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return saved;
  }, []);

  useEffect(() => {
    let active = true;
    listProjects()
      .then((saved) => {
        if (!active) return;
        const ordered = [...saved].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setProjects(ordered.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })));
        const project = ordered[0];
        if (project) {
          loadProjectObjects(project.objects);
          setProjectId(project.id);
          setProjectName(project.name);
          setNotice("Proyecto guardado cargado.");
        }
      })
      .catch(() => { if (active) setNotice("No se pudieron cargar los proyectos guardados."); });
    return () => { active = false; };
  }, [loadProjectObjects]);

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

  async function handleHollow() {
    if (!selected) {
      setNotice("Seleccioná un cubo o cilindro para vaciarlo.");
      return;
    }
    if (selected.kind !== "box" && selected.kind !== "cylinder") {
      setNotice("El vaciado está disponible por ahora para cubos y cilindros.");
      return;
    }
    try {
      setNotice("Generando cavidad y comprobando la malla…");
      const parsedWalls = {
        left: Number(wallThicknesses.left),
        right: Number(wallThicknesses.right),
        front: Number(wallThicknesses.front),
        back: Number(wallThicknesses.back),
        bottom: Number(wallThicknesses.bottom)
      };
      const activeValues = selected.kind === "cylinder" ? [parsedWalls.left] : Object.values(parsedWalls);
      if (activeValues.some((value) => !Number.isFinite(value) || value <= 0)) {
        setNotice("Ingresá espesores mayores que 0 mm en todos los campos.");
        return;
      }
      const vertices = await calculateHollow(selected, selected.kind === "cylinder" ? parsedWalls.left : parsedWalls);
      applyBooleanResult([selected.id], `Vaciado ${selected.name}`, vertices);
      setBooleanSelection([]);
      setNotice(selected.kind === "cylinder"
        ? `Tubo generado con pared de ${parsedWalls.left} mm.`
        : "Vaciado completado con espesores independientes.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo vaciar la pieza.");
    }
  }

  function confirmNumericChanges() {
    if (!selected) return;
    const keys = ["dimensionX", "dimensionY", "dimensionZ", "positionX", "positionY", "positionZ", "rotationX", "rotationY", "rotationZ"];
    if (keys.some((key) => !numericDraft[key]?.trim() || !Number.isFinite(Number(numericDraft[key])))) {
      setNotice("Completá todos los campos numéricos antes de confirmar.");
      return;
    }
    const dimensions = { x: Number(numericDraft.dimensionX), y: Number(numericDraft.dimensionY), z: Number(numericDraft.dimensionZ) };
    if (Object.values(dimensions).some((value) => value <= 0)) {
      setNotice("Las dimensiones deben ser mayores que 0 mm.");
      return;
    }
    updateObject(selected.id, {
      dimensions,
      position: { x: Number(numericDraft.positionX), y: Number(numericDraft.positionY), z: Number(numericDraft.positionZ) },
      rotation: { x: Number(numericDraft.rotationX), y: Number(numericDraft.rotationY), z: Number(numericDraft.rotationZ) }
    });
    setNotice("Cambios numéricos confirmados.");
  }

  function cancelNumericChanges() {
    if (!selected) return;
    setNumericDraft({
      dimensionX: String(selected.dimensions.x), dimensionY: String(selected.dimensions.y), dimensionZ: String(selected.dimensions.z),
      positionX: String(selected.position.x), positionY: String(selected.position.y), positionZ: String(selected.position.z),
      rotationX: String(selected.rotation.x), rotationY: String(selected.rotation.y), rotationZ: String(selected.rotation.z)
    });
    setNotice("Se descartaron los cambios numéricos.");
  }

  async function handleSave() {
    try {
      await saveProject({ schemaVersion: 1, id: projectId, name: projectName, units: "mm", objects, updatedAt: new Date().toISOString() });
      await refreshProjects();
      setNotice("Proyecto guardado: " + projectName);
    } catch { setNotice("No se pudo guardar el proyecto en este navegador."); }
  }

  async function handleCreateProject() {
    const entered = window.prompt("Nombre del nuevo proyecto:", "Proyecto nuevo");
    if (entered === null) return;
    const name = entered.trim();
    if (!name) { setNotice("El nombre del proyecto no puede estar vacío."); return; }
    const id = crypto.randomUUID();
    try {
      await saveProject({ schemaVersion: 1, id, name, units: "mm", objects: [], updatedAt: new Date().toISOString() });
      loadProjectObjects([]);
      setProjectId(id);
      setProjectName(name);
      setBooleanSelection([]);
      await refreshProjects();
      setNotice("Proyecto creado: " + name);
    } catch { setNotice("No se pudo crear el proyecto."); }
  }

  async function handleOpenProject(id: string) {
    try {
      const project = await loadProject(id);
      if (!project) { setNotice("No se encontró ese proyecto guardado."); return; }
      loadProjectObjects(project.objects);
      setProjectId(project.id);
      setProjectName(project.name);
      setBooleanSelection([]);
      setNotice("Proyecto abierto: " + project.name);
    } catch { setNotice("No se pudo abrir el proyecto seleccionado."); }
  }

  async function handleRenameProject() {
    const entered = window.prompt("Nuevo nombre del proyecto:", projectName);
    if (entered === null) return;
    const name = entered.trim();
    if (!name) { setNotice("El nombre del proyecto no puede estar vacío."); return; }
    try {
      await saveProject({ schemaVersion: 1, id: projectId, name, units: "mm", objects, updatedAt: new Date().toISOString() });
      setProjectName(name);
      await refreshProjects();
      setNotice("Proyecto renombrado: " + name);
    } catch { setNotice("No se pudo renombrar el proyecto."); }
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
        <select aria-label="Proyecto actual" className="project-select" value={projectId} onChange={(event) => void handleOpenProject(event.target.value)}>
          {projects.length === 0 && <option value={projectId}>{projectName}</option>}
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button className="secondary-button" onClick={() => void handleCreateProject()}>Nuevo proyecto</button>
        <button className="secondary-button" onClick={() => void handleRenameProject()}>Renombrar</button>
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
                  <span className="object-dot" style={{ backgroundColor: object.color ?? "#8b9cf6" }} />
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
                <div className="property-title">Apariencia</div>
                <label className="property-row">
                  <span>Color del objeto</span>
                  <input
                    aria-label="Color del objeto seleccionado"
                    type="color"
                    value={selected.color ?? "#8b9cf6"}
                    onChange={(event) => updateObject(selected.id, { color: event.target.value })}
                  />
                </label>
                <small>El color se guarda en el proyecto y no modifica la geometría. El formato STL no conserva colores.</small>
              </div>
              <div className="property-section">
                <div className="property-title">Dimensiones <span>mm</span></div>
                {(["x", "y", "z"] as const).map((axis) => {
                  const key = "dimension" + axis.toUpperCase();
                  return <label className="property-row" key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input type="number" min="0.1" step="0.1" value={numericDraft[key] ?? ""} onChange={(event) => setNumericDraft((draft) => ({ ...draft, [key]: event.target.value }))} />
                  </label>;
                })}
              </div>
              <div className="property-section">
                <div className="property-title">Posición <span>mm</span></div>
                {(["x", "y", "z"] as const).map((axis) => {
                  const key = "position" + axis.toUpperCase();
                  return <label className="property-row" key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input type="number" step="1" value={numericDraft[key] ?? ""} onChange={(event) => setNumericDraft((draft) => ({ ...draft, [key]: event.target.value }))} />
                  </label>;
                })}
              </div>
              <div className="property-section">
                <div className="property-title">Rotación <span>grados</span></div>
                {(["x", "y", "z"] as const).map((axis) => {
                  const key = "rotation" + axis.toUpperCase();
                  return <label className="property-row" key={axis}>
                    <span>{axis.toUpperCase()}</span>
                    <input type="number" step="15" value={numericDraft[key] ?? ""} onChange={(event) => setNumericDraft((draft) => ({ ...draft, [key]: event.target.value }))} />
                  </label>;
                })}
              </div>
              <div className="property-section">
                <button className="primary-button" onClick={confirmNumericChanges}>Confirmar cambios</button>
                <button className="secondary-button" onClick={cancelNumericChanges}>Cancelar cambios</button>
              </div>
              <div className="property-section">
                <div className="property-title">Vaciado <span>mm</span></div>
                {selected.kind === "box" ? (
                  <>
                    {([
                      ["left", "Izquierda"],
                      ["right", "Derecha"],
                      ["front", "Frontal"],
                      ["back", "Trasera"],
                      ["bottom", "Fondo / base"]
                    ] as const).map(([side, label]) => (
                      <label className="property-row" key={side}>
                        <span>{label}</span>
                        <input
                          aria-label={`Espesor pared ${label}`}
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={wallThicknesses[side]}
                          onChange={(event) => setWallThicknesses((current) => ({ ...current, [side]: event.target.value }))}
                        />
                      </label>
                    ))}
                    <small>La parte superior queda abierta. Cada espesor se mide hacia el interior.</small>
                  </>
                ) : (
                  <>
                    <label className="property-row">
                      <span>Espesor radial</span>
                      <input
                        aria-label="Espesor radial para vaciado cilíndrico"
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={wallThicknesses.left}
                        onChange={(event) => setWallThicknesses((current) => ({ ...current, left: event.target.value }))}
                      />
                    </label>
                    <small>El cilindro se convierte en un tubo con agujero pasante.</small>
                  </>
                )}
                <button className="primary-button" onClick={handleHollow}>
                  Vaciar pieza
                </button>
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
