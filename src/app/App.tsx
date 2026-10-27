import { useState } from "react";
import { Viewport } from "../features/viewport/Viewport";
import { useEditorStore } from "../features/editor/editorStore";
import { saveProject } from "../services/storage/projectStorage";

export function App() {
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState("Prototipo inicial · los booleanos CAD aún no están implementados");
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const addPrimitive = useEditorStore((s) => s.addPrimitive);
  const selectObject = useEditorStore((s) => s.selectObject);
  const updateObject = useEditorStore((s) => s.updateObject);
  const selected = objects.find((o) => o.id === selectedId);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">C</div>
        <div className="brand-copy">
          <strong>CAD Studio</strong>
          <span>Diseño 3D modular</span>
        </div>
        <div className="topbar-spacer" />
        <span className="unit-chip">MM</span>
        <button className="secondary-button" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "Modo sencillo" : "Herramientas avanzadas"}
        </button>
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
          <div className="object-list">
            {objects.map((object) => (
              <button
                key={object.id}
                className={`object-row ${selectedId === object.id ? "selected" : ""}`}
                onClick={() => selectObject(object.id)}
              >
                <span className="object-dot" />
                <span>{object.name}</span>
              </button>
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
          <Viewport />
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
                <div><b>{selected.name}</b><small>{selected.kind.toUpperCase()}</small></div>
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
                      value={selected.dimensions[axis]}
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
                      value={selected.position[axis]}
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
                      value={selected.rotation?.[axis] ?? 0}
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
