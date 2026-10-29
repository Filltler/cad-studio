import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { Viewport } from "../features/viewport/Viewport";
import { useEditorStore } from "../features/editor/editorStore";
import { listProjects, loadProject, saveProject } from "../services/storage/projectStorage";
import { addInterlocksToPlanarSplit, calculateBoolean, calculatePlanarCut, calculatePlanarSplit, calculateHollow, calculateObjectBounds, calculateObjectProjectionBounds, getCutPlaneNormal, getPlanarCutFaceBounds, suggestPlanarInterlocks, type BooleanOperation, type CutAxis, type CutTilt, type InterlockShape } from "../services/booleanOperations";
import { parseSTL } from "../services/stlImport";

export function App() {
  const [advanced, setAdvanced] = useState(false);
  const [booleanSelection, setBooleanSelection] = useState<string[]>([]);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [spacingGap, setSpacingGap] = useState("10");
  const [viewportMultiSelect, setViewportMultiSelect] = useState(false);
  const [notice, setNotice] = useState("MiCAD · herramientas CAD en desarrollo");
  const [wallThicknesses, setWallThicknesses] = useState({ left: "2", right: "2", front: "2", back: "2", bottom: "2" });
  const [numericDraft, setNumericDraft] = useState<Record<string, string>>({});
  const [cutEnabled, setCutEnabled] = useState(false);
  const [cutAxis, setCutAxis] = useState<CutAxis>("y");
  const [cutTilt, setCutTilt] = useState<CutTilt>({ x: 0, y: 0, z: 0 });
  const [cutPosition, setCutPosition] = useState("17");
  const [cutPreview, setCutPreview] = useState<{ objectId: string; vertices: number[] } | null>(null);
  const [cutBusy, setCutBusy] = useState(false);
  const [hollowBusy, setHollowBusy] = useState(false);
  const [interlocksEnabled, setInterlocksEnabled] = useState(false);
  const [interlockShape, setInterlockShape] = useState<InterlockShape>("elastic");
  const [interlockCount, setInterlockCount] = useState("2");
  const [interlockClearance, setInterlockClearance] = useState("0.25");
  const [projectId, setProjectId] = useState("local-project");
  const [projectName, setProjectName] = useState("Mi primer proyecto");
  const [projects, setProjects] = useState<Array<{ id: string; name: string; updatedAt: string }>>([]);
  const [stlImportBusy, setStlImportBusy] = useState(false);
  const stlInputRef = useRef<HTMLInputElement>(null);
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const addPrimitive = useEditorStore((s) => s.addPrimitive);
  const selectObject = useEditorStore((s) => s.selectObject);
  const deleteObjects = useEditorStore((s) => s.deleteObjects);
  const updateObject = useEditorStore((s) => s.updateObject);
  const alignObjects = useEditorStore((s) => s.alignObjects);
  const spaceObjects = useEditorStore((s) => s.spaceObjects);
  const addCustomObject = useEditorStore((s) => s.addCustomObject);
  const applyBooleanResult = useEditorStore((s) => s.applyBooleanResult); 
  const applyPlanarSplitResult = useEditorStore((s) => s.applyPlanarSplitResult);
  const loadProjectObjects = useEditorStore((s) => s.loadProjectObjects);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const selected = objects.find((o) => o.id === selectedId);
  const roundForDisplay = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;
  const cutBounds = useMemo(() => {
    if (!selected) return null;
    try { return calculateObjectBounds(selected); }
    catch { return null; }
  }, [selected]);
  const cutTiltAxes: Record<CutAxis, [CutAxis, CutAxis]> = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] };
  const cutNormal = useMemo(() => getCutPlaneNormal(cutAxis, cutTilt), [cutAxis, cutTilt.x, cutTilt.y, cutTilt.z]);
  const cutTilted = cutTiltAxes[cutAxis].some((axis) => Math.abs(cutTilt[axis]) > 1e-6);
  const cutProjectionBounds = useMemo(() => {
    if (!selected) return null;
    try { return calculateObjectProjectionBounds(selected, cutNormal); }
    catch { return null; }
  }, [selected, cutNormal]);
  const cutExtent = cutProjectionBounds ? cutProjectionBounds.max - cutProjectionBounds.min : 0;
  const cutEpsilon = Math.max(cutExtent * 1e-6, 1e-5);
  const cutMinimum = cutProjectionBounds ? cutProjectionBounds.min + cutEpsilon * 2 : 0;
  const cutMaximum = cutProjectionBounds ? cutProjectionBounds.max - cutEpsilon * 2 : 0;
  const parsedCutPosition = Number(cutPosition);
  const cutPositionValid = Boolean(cutProjectionBounds && cutMaximum > cutMinimum && cutPosition.trim() && Number.isFinite(parsedCutPosition) && parsedCutPosition >= cutMinimum && parsedCutPosition <= cutMaximum);
  const cutAxisLabels: Record<CutAxis, string> = { x: "X · Lateral", y: "Y · Altura", z: "Z · Profundidad" };
  const boundedCutPosition = (value: number) => {
    if (!Number.isFinite(value) || !cutProjectionBounds || cutMaximum <= cutMinimum) return;
    setCutPosition(String(roundForDisplay(Math.min(cutMaximum, Math.max(cutMinimum, value)))));
  };
  const updateCutTilt = (axis: CutAxis, value: number) => {
    if (!Number.isFinite(value)) return;
    setCutTilt((current) => ({ ...current, [axis]: Math.max(-80, Math.min(80, value)) }));
    setInterlocksEnabled(false);
  };
  const cutPlaneSpec = useMemo(() => {
    if (!cutEnabled || !selected || !cutBounds || !cutProjectionBounds) return null;
    return {
      objectId: selected.id,
      axis: cutAxis,
      normal: cutNormal,
      tilted: cutTilted,
      position: cutPositionValid ? parsedCutPosition : (cutProjectionBounds.min + cutProjectionBounds.max) / 2,
      bounds: {
        min: [cutBounds.min.x, cutBounds.min.y, cutBounds.min.z] as [number, number, number],
        max: [cutBounds.max.x, cutBounds.max.y, cutBounds.max.z] as [number, number, number]
      }
    };
  }, [cutEnabled, selected, cutBounds, cutProjectionBounds, cutAxis, cutNormal, cutTilted, cutPositionValid, parsedCutPosition]);
  const cutFaceBounds = useMemo(() => {
    if (cutTilted || !cutPreview || cutPreview.objectId !== selectedId || !cutPositionValid) return null;
    return getPlanarCutFaceBounds(cutPreview.vertices, cutAxis, parsedCutPosition);
  }, [cutPreview, selectedId, cutAxis, parsedCutPosition, cutPositionValid, cutTilted]);
  const parsedInterlockCount = Number(interlockCount);
  const parsedInterlockClearance = Number(interlockClearance);
  const interlockSuggestion = cutBounds && !cutTilted
    ? suggestPlanarInterlocks(cutFaceBounds, cutBounds, cutAxis, parsedCutPosition, parsedInterlockCount, interlockShape, parsedInterlockClearance)
    : null;
  const interlockClearanceValid = Number.isFinite(parsedInterlockClearance) && parsedInterlockClearance >= 0.1 && parsedInterlockClearance <= 1;
  const cutCanUseInterlocks = Boolean(!cutTilted && interlockSuggestion?.available && interlockClearanceValid);

  const getBedBaseY = (object: typeof objects[number]) => {
    if (object.kind !== "custom") return object.position.y - object.dimensions.y / 2;
    const vertices = object.geometryVertices ?? [];
    if (vertices.length < 3) return object.position.y;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let index = 0; index + 2 < vertices.length; index += 3) {
      const x = vertices[index], y = vertices[index + 1], z = vertices[index + 2];
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const rotation = new THREE.Euler(
      THREE.MathUtils.degToRad(object.rotation.x),
      THREE.MathUtils.degToRad(object.rotation.y),
      THREE.MathUtils.degToRad(object.rotation.z)
    );
    const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(rotation);
    const point = new THREE.Vector3();
    let minimumRotatedY = Infinity;
    for (let index = 0; index + 2 < vertices.length; index += 3) {
      point.set(vertices[index] - center.x, vertices[index + 1] - center.y, vertices[index + 2] - center.z).applyMatrix4(rotationMatrix);
      minimumRotatedY = Math.min(minimumRotatedY, point.y + center.y);
    }
    return minimumRotatedY + object.position.y;
  };
  useEffect(() => {
    if (!selected) { setNumericDraft({}); return; }
    setNumericDraft({
      dimensionX: String(roundForDisplay(selected.dimensions.x)), dimensionY: String(roundForDisplay(selected.dimensions.y)), dimensionZ: String(roundForDisplay(selected.dimensions.z)),
      positionX: String(roundForDisplay(selected.position.x)), positionY: String(roundForDisplay(getBedBaseY(selected))), positionZ: String(roundForDisplay(selected.position.z)),
      rotationX: String(roundForDisplay(selected.rotation.x)), rotationY: String(roundForDisplay(selected.rotation.y)), rotationZ: String(roundForDisplay(selected.rotation.z))
    });
  }, [selectedId, selected]);

  useEffect(() => {
    if (!selected || !cutBounds || cutMaximum <= cutMinimum) {
      setCutPosition("");
      return;
    }
    setCutPosition(String(roundForDisplay((cutBounds.min[cutAxis] + cutBounds.max[cutAxis]) / 2)));
  }, [selectedId, cutAxis, cutProjectionBounds]);

  useEffect(() => {
    if (!cutEnabled || !selected || !cutPositionValid) {
      setCutPreview(null);
      setCutBusy(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setCutPreview(null);
    setCutBusy(false);
    const timer = window.setTimeout(() => {
      setCutBusy(true);
      calculatePlanarCut(selected, cutAxis, parsedCutPosition, controller.signal, cutTilt)
        .then((vertices) => {
          if (active) setCutPreview({ objectId: selected.id, vertices });
        })
        .catch((error) => {
          if (active && !(error instanceof Error && error.name === "AbortError")) {
            setCutPreview(null);
            setNotice(error instanceof Error ? error.message : "No se pudo calcular la vista previa del corte.");
          }
        })
        .finally(() => { if (active) setCutBusy(false); });
    }, 300);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [cutEnabled, selectedId, cutAxis, cutTilt, cutPosition, cutPositionValid, objects]);

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
      if (event.key === "Escape") {
        event.preventDefault();
        setBooleanSelection([]);
        setViewportMultiSelect(false);
        selectObject(null);
        return;
      }
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
  }, [undo, redo, selectObject]);

  function handleAlign(axis: "x" | "y" | "z", mode: "min" | "center" | "max") {
    const selectedCount = objects.filter((object) => booleanSelection.includes(object.id)).length;
    if (selectedCount < 2) {
      setNotice("Marcá al menos dos piezas para alinearlas.");
      return;
    }
    try {
      const positionsBefore = new Map(objects.filter((object) => booleanSelection.includes(object.id)).map((object) => [object.id, object.position[axis]]));
      alignObjects(booleanSelection, axis, mode);
      const changed = useEditorStore.getState().objects.some((object) => positionsBefore.has(object.id) && positionsBefore.get(object.id) !== object.position[axis]);
      const modeLabel = mode === "min" ? "mínimo" : mode === "max" ? "máximo" : "centro";
      setNotice(changed
        ? "Piezas alineadas por " + modeLabel + " en " + axis.toUpperCase() + ". Podés deshacerlo."
        : "Las piezas ya estaban alineadas por " + modeLabel + " en " + axis.toUpperCase() + ".");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudieron alinear las piezas.");
    }
  }

  function handleSpace(axis: "x" | "y" | "z", mode: "fixed" | "uniform") {
    const selectedCount = objects.filter((object) => booleanSelection.includes(object.id)).length;
    if (selectedCount < 2) {
      setNotice("Marcá al menos dos piezas para distribuirlas.");
      return;
    }
    if (mode === "uniform" && selectedCount < 3) {
      setNotice("La distribución uniforme necesita al menos tres piezas.");
      return;
    }
    const gap = Number(spacingGap);
    if (mode === "fixed" && (!spacingGap.trim() || !Number.isFinite(gap) || gap < 0)) {
      setNotice("La separación debe ser un número igual o mayor que 0 mm.");
      return;
    }
    try {
      const positionsBefore = new Map(objects.filter((object) => booleanSelection.includes(object.id)).map((object) => [object.id, object.position[axis]]));
      spaceObjects(booleanSelection, axis, mode, mode === "fixed" ? gap : 0);
      const changed = useEditorStore.getState().objects.some((object) => positionsBefore.has(object.id) && positionsBefore.get(object.id) !== object.position[axis]);
      const actionLabel = mode === "fixed" ? "separación de " + gap + " mm" : "distribución uniforme";
      setNotice(changed
        ? "Piezas organizadas en " + axis.toUpperCase() + " con " + actionLabel + ". Podés deshacerlo."
        : "Las piezas ya tenían ese espaciado en " + axis.toUpperCase() + ".");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudieron espaciar las piezas.");
    }
  }

  function toggleBooleanSelection(id: string) {
    setBooleanSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  const handleViewportObjectSelect = useCallback((id: string | null, additive: boolean) => {
    selectObject(id);
    if (!additive) {
      setBooleanSelection([]);
      return;
    }
    if (id) {
      setBooleanSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    }
  }, [selectObject]);

  const handleViewportMarqueeSelect = useCallback((ids: string[], additive: boolean) => {
    if (!ids.length) return;
    selectObject(ids[0]);
    setBooleanSelection((current) => additive ? Array.from(new Set([...current, ...ids])) : ids);
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

  function handleDeleteObjects() { if (!selectedId) { setNotice("Seleccioná un objeto para eliminar."); return; } deleteObjects([selectedId]); setBooleanSelection((current) => current.filter((id) => id !== selectedId)); setCutEnabled(false); setCutPreview(null); setNotice("Objeto eliminado. Podés deshacerlo."); }

  function cancelHeightCut() {
    setCutEnabled(false);
    setCutPreview(null);
    setCutBusy(false);
    setNotice("Vista previa de corte cancelada; la pieza original no se modificó.");
  }

  async function confirmPlanarCut(withoutInterlocks = false) {
    if (!selected || !cutPreview || cutPreview.objectId !== selected.id || cutBusy || !cutPositionValid) {
      setNotice("Esperá a que la vista previa del corte esté lista.");
      return;
    }
    const addInterlocks = interlocksEnabled && !withoutInterlocks;
    if (addInterlocks && (!cutBounds || !cutCanUseInterlocks)) {
      setNotice("En esta sección no entran los encastres seleccionados. Podés confirmar el corte sin encastres.");
      return;
    }
    setCutBusy(true);
    const axisLabel = cutAxis.toUpperCase();
    setNotice(addInterlocks ? "Calculando el corte y los encastres…" : "Calculando las dos partes del corte…");
    try {
      const cutParts = await calculatePlanarSplit(selected, cutAxis, parsedCutPosition, cutTilt);
      let parts = cutParts;
      if (addInterlocks && cutBounds) {
        parts = await addInterlocksToPlanarSplit(
          cutParts,
          cutAxis,
          parsedCutPosition,
          cutBounds,
          interlockShape,
          parsedInterlockCount,
          parsedInterlockClearance
        );
      }
      let negativeLabel = cutTilted ? "lado − del plano" : cutAxis === "y" ? "inferior" : "lado −" + axisLabel;
      let positiveLabel = cutTilted ? "lado + del plano" : cutAxis === "y" ? "superior" : "lado +" + axisLabel;
      if (addInterlocks) {
        negativeLabel += " · macho";
        positiveLabel += " · hembra";
      }
      const cutName = cutTilted ? "Corte inclinado · " + selected.name : "Corte " + axisLabel + " · " + selected.name;
      applyPlanarSplitResult(selected.id, cutName, parts.negative, parts.positive, negativeLabel, positiveLabel);
      setBooleanSelection((current) => current.filter((id) => id !== selected.id));
      setCutEnabled(false);
      setCutPreview(null);
      setNotice(addInterlocks
        ? "Corte confirmado con " + parsedInterlockCount + " encastres " + (interlockShape === "elastic" ? "elásticos" : interlockShape === "round" ? "guías redondas" : "guías cuadradas") + " de " + interlockSuggestion!.diameter.toFixed(1) + " mm y holgura de " + parsedInterlockClearance.toFixed(2) + " mm por lado. Podés deshacerlo."
        : "Corte confirmado" + (cutTilted ? " con plano inclinado" : " en " + axisLabel + " = " + parsedCutPosition.toFixed(3) + " mm") + (withoutInterlocks && interlocksEnabled ? " sin encastres" : "") + ". Se crearon dos objetos independientes; podés deshacerlo.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudieron generar las dos partes del corte.");
    } finally {
      setCutBusy(false);
    }
  }

  async function handleHollow() {
    if (!selected) {
      setNotice("Seleccioná una pieza para vaciarla.");
      return;
    }
    if (hollowBusy) return;
    setHollowBusy(true);
    try {
      setNotice("Calculando el vaciado en segundo plano y comprobando la malla…");
      const parsedWalls = {
        left: Number(wallThicknesses.left),
        right: Number(wallThicknesses.right),
        front: Number(wallThicknesses.front),
        back: Number(wallThicknesses.back),
        bottom: Number(wallThicknesses.bottom)
      };
      const activeValues = selected.kind === "box" ? Object.values(parsedWalls) : [parsedWalls.left];
      if (activeValues.some((value) => !Number.isFinite(value) || value <= 0)) {
        setNotice("Ingresá espesores mayores que 0 mm en los campos activos.");
        return;
      }
      const vertices = await calculateHollow(selected, selected.kind === "box" ? parsedWalls : parsedWalls.left);
      applyBooleanResult([selected.id], `Vaciado ${selected.name}`, vertices);
      setBooleanSelection([]);
      setNotice(selected.kind === "cylinder"
        ? `Tubo generado con pared de ${parsedWalls.left} mm.`
        : selected.kind === "sphere"
          ? `Esfera hueca generada con pared de ${parsedWalls.left} mm.`
          : selected.kind === "custom"
            ? `Malla personalizada vaciada con pared uniforme de ${parsedWalls.left} mm.`
            : "Vaciado completado con espesores independientes.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo vaciar la pieza.");
    } finally {
      setHollowBusy(false);
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
    const rotation = { x: Number(numericDraft.rotationX), y: Number(numericDraft.rotationY), z: Number(numericDraft.rotationZ) };
    const enteredBaseY = Number(numericDraft.positionY);
    const positionY = selected.kind === "custom"
      ? enteredBaseY - getBedBaseY({ ...selected, position: { ...selected.position, y: 0 }, rotation })
      : enteredBaseY + dimensions.y / 2;
    updateObject(selected.id, {
      dimensions,
      position: { x: Number(numericDraft.positionX), y: positionY, z: Number(numericDraft.positionZ) },
      rotation
    });
    setNotice("Cambios numéricos confirmados.");
  }

  function cancelNumericChanges() {
    if (!selected) return;
    setNumericDraft({
      dimensionX: String(selected.dimensions.x), dimensionY: String(selected.dimensions.y), dimensionZ: String(selected.dimensions.z),
      positionX: String(roundForDisplay(selected.position.x)), positionY: String(roundForDisplay(selected.position.y)), positionZ: String(roundForDisplay(selected.position.z)),
      rotationX: String(roundForDisplay(selected.rotation.x)), rotationY: String(roundForDisplay(selected.rotation.y)), rotationZ: String(roundForDisplay(selected.rotation.z))
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

  async function handleImportSTL(file: File | undefined) {
    if (!file) return;
    setStlImportBusy(true);
    setNotice("Importando archivo STL...");
    try {
      const imported = parseSTL(await file.arrayBuffer());
      const name = file.name.replace(/\.stl$/i, "").trim() || "Malla importada";
      let rightmost = -Infinity;
      for (const object of objects) {
        try {
          rightmost = Math.max(rightmost, calculateObjectBounds(object).max.x);
        } catch {
          rightmost = Math.max(rightmost, object.position.x + object.dimensions.x / 2);
        }
      }
      const position = objects.length
        ? { x: rightmost + imported.dimensions.x / 2 + 5, y: 0, z: 0 }
        : { x: 0, y: 0, z: 0 };
      addCustomObject(name, imported.vertices, position);
      setBooleanSelection([]);
      setViewportMultiSelect(false);
      setNotice(
        "STL \"" + name + "\" importado en milímetros, apoyado sobre la cama y con la orientación del archivo. Dimensiones: " +
        roundForDisplay(imported.dimensions.x) + " × " + roundForDisplay(imported.dimensions.y) + " × " + roundForDisplay(imported.dimensions.z) + " mm."
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo importar el archivo STL.");
    } finally {
      setStlImportBusy(false);
      if (stlInputRef.current) stlInputRef.current.value = "";
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
        <button className="secondary-button" onClick={() => stlInputRef.current?.click()} disabled={stlImportBusy}>{stlImportBusy ? "Importando STL…" : "Importar STL"}</button>
        <input ref={stlInputRef} type="file" accept=".stl,model/stl,application/sla" aria-label="Elegir archivo STL para importar" hidden onChange={(event) => void handleImportSTL(event.currentTarget.files?.[0])} />
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
            <small>{viewportMultiSelect ? "Tocá piezas en el área 3D o usá Shift+arrastre en un espacio vacío para seleccionar por recuadro." : "Marcá casillas, usá Shift+clic o Shift+arrastrá en un espacio vacío para sumar piezas por recuadro."}</small>
            <button className={`secondary-button ${viewportMultiSelect ? "active" : ""}`} onClick={() => setViewportMultiSelect((active) => !active)} aria-pressed={viewportMultiSelect}>
              {viewportMultiSelect ? "Finalizar selección 3D" : "Seleccionar piezas en 3D"}
            </button>
            <div className="boolean-buttons">
              <button className="secondary-button" onClick={() => handleBoolean("union")}>Unión</button>
              <button className="secondary-button" onClick={() => handleBoolean("subtract")}>Restar</button>
            </div>
            <button className="secondary-button" onClick={() => handleBoolean("intersect")}>Intersección</button>
            <button className="secondary-button" onClick={() => setAlignmentOpen((open) => !open)} aria-expanded={alignmentOpen}>
              {alignmentOpen ? "Ocultar alineación" : "Alinear objetos"}
            </button>
            {alignmentOpen && (
              <div className="alignment-tools">
                <small>Elegí mínimo, centro o máximo para alinear los límites reales de las piezas marcadas.</small>
                {(["x", "y", "z"] as const).map((axis) => (
                  <div className="alignment-axis" key={axis}>
                    <b>{axis.toUpperCase()}</b>
                    {(["min", "center", "max"] as const).map((mode) => {
                      const modeLabel = mode === "min" ? "mínimo" : mode === "max" ? "máximo" : "centro";
                      return <button
                        key={mode}
                        className="secondary-button"
                        disabled={booleanSelection.length < 2}
                        title={"Alinear por " + modeLabel + " en " + axis.toUpperCase()}
                        aria-label={"Alinear por " + modeLabel + " en " + axis.toUpperCase()}
                        onClick={() => handleAlign(axis, mode)}
                      >{mode === "center" ? "Centro" : mode === "min" ? "Mín" : "Máx"}</button>;
                    })}
                  </div>
                ))}
                <div className="spacing-tools">
                  <b>Espaciado entre piezas</b>
                  <label className="spacing-gap-row">
                    <span>Hueco fijo · mm</span>
                    <input aria-label="Separación fija entre piezas en milímetros" type="number" min="0" step="0.1" value={spacingGap} onChange={(event) => setSpacingGap(event.target.value)} />
                  </label>
                  {(["x", "y", "z"] as const).map((axis) => (
                    <div className="spacing-axis" key={axis}>
                      <b>{axis.toUpperCase()}</b>
                      <button
                        className="secondary-button"
                        disabled={booleanSelection.length < 2}
                        title={"Dejar " + spacingGap + " mm entre piezas en " + axis.toUpperCase()}
                        aria-label={"Separación fija en " + axis.toUpperCase()}
                        onClick={() => handleSpace(axis, "fixed")}
                      >Fijo</button>
                      <button
                        className="secondary-button"
                        disabled={booleanSelection.length < 3}
                        title={"Distribuir con huecos iguales en " + axis.toUpperCase() + " (mínimo tres piezas)"}
                        aria-label={"Distribución uniforme en " + axis.toUpperCase()}
                        onClick={() => handleSpace(axis, "uniform")}
                      >Uniforme</button>
                    </div>
                  ))}
                  <small>Fijo conserva la primera pieza; uniforme mantiene los extremos y reparte los huecos iguales.</small>
                </div>
              </div>
            )}
          </div>
          <div className="object-list">
            {objects.map((object) => (
              <div className="object-entry" key={object.id}>
                <button
                  className={`object-row ${selectedId === object.id ? "selected" : ""}`}
                  onClick={() => selectObject(object.id)}
                >
                  <input aria-label={`Incluir ${object.name} en la selección de piezas`} type="checkbox" checked={booleanSelection.includes(object.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleBooleanSelection(object.id)} />
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
          <Viewport
            multiSelectMode={viewportMultiSelect}
            multiSelectedIds={booleanSelection}
            onObjectSelect={handleViewportObjectSelect}
            onObjectsMarqueeSelect={handleViewportMarqueeSelect}
            preview={cutPreview}
            cutPlane={cutPlaneSpec}
            onCutPositionChange={boundedCutPosition}
          />
          <div className="viewport-bottom">
            <span>Arrastrá para orbitar · Shift+arrastrá para seleccionar · Esc para cancelar · Rueda para zoom</span>
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
                <div className="property-title">Objeto</div>
                <button className="danger-button" onClick={handleDeleteObjects}>Eliminar objeto</button>
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
                    <input type="number" step="0.001" value={numericDraft[key] ?? ""} onChange={(event) => setNumericDraft((draft) => ({ ...draft, [key]: event.target.value }))} />
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
              <div className="property-section height-cut-section">
                <div className="property-title">Corte por plano <span>{cutAxis.toUpperCase()} · mm</span></div>
                <small>Elegí un eje y arrastrá el plano sobre la pieza o ajustá su posición con el número y el deslizador. Los límites se calculan a partir del tamaño real del objeto.</small>
                {!cutEnabled ? (
                  <button className="secondary-button" onClick={() => setCutEnabled(true)}>Activar vista previa</button>
                ) : (
                  <>
                    <div className="cut-axis-options" role="group" aria-label="Eje inicial del corte">
                      {(["x", "y", "z"] as CutAxis[]).map((axis) => (
                        <button
                          key={axis}
                          type="button"
                          className={cutAxis === axis ? "active" : ""}
                          aria-pressed={cutAxis === axis}
                          onClick={() => {
                            setCutAxis(axis);
                            setCutTilt({ x: 0, y: 0, z: 0 });
                            setInterlocksEnabled(false);
                          }}
                        >
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <small className="cut-axis-label">{cutTilted ? "Plano inclinado desde " + cutAxisLabels[cutAxis] : cutAxisLabels[cutAxis]}</small>
                    <div className="cut-tilt-options">
                      <strong>Inclinación del plano · grados</strong>
                      <small>Girá alrededor de los dos ejes que cruzan el eje inicial. El plano puede inclinarse en el espacio.</small>
                      {cutTiltAxes[cutAxis].map((axis) => (
                        <label className="cut-angle-row" key={axis}>
                          <span>{axis.toUpperCase()}</span>
                          <input
                            aria-label={"Inclinación del plano alrededor de " + axis.toUpperCase()}
                            type="range"
                            min="-80"
                            max="80"
                            step="1"
                            value={cutTilt[axis]}
                            onChange={(event) => updateCutTilt(axis, Number(event.target.value))}
                          />
                          <input
                            aria-label={"Ángulo del plano alrededor de " + axis.toUpperCase()}
                            type="number"
                            min="-80"
                            max="80"
                            step="1"
                            value={cutTilt[axis]}
                            onChange={(event) => updateCutTilt(axis, Number(event.target.value))}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="property-row">
                      <span>Posición del plano · mm</span>
                      <input
                        aria-label="Posición del plano de corte en milímetros"
                        type="number"
                        min={cutMinimum}
                        max={cutMaximum}
                        step="0.01"
                        value={cutPosition}
                        disabled={!cutProjectionBounds || cutMaximum <= cutMinimum}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "") setCutPosition("");
                          else boundedCutPosition(Number(value));
                        }}
                      />
                    </label>
                    <input
                      aria-label="Deslizador de posición del plano de corte"
                      type="range"
                      min={cutMinimum}
                      max={cutMaximum}
                      step={Math.max(cutExtent / 1000, 0.001)}
                      value={cutPositionValid ? parsedCutPosition : (cutMinimum + cutMaximum) / 2}
                      disabled={!cutProjectionBounds || cutMaximum <= cutMinimum}
                      onChange={(event) => boundedCutPosition(Number(event.target.value))}
                    />
                    <small>Límites proyectados sobre el plano: {roundForDisplay(cutProjectionBounds?.min ?? 0)} a {roundForDisplay(cutProjectionBounds?.max ?? 0)} mm. Se calculan con los vértices de la malla.</small>
                    <small>{cutBusy ? "Calculando vista previa…" : cutPreview ? "Arrastrá cualquiera de los ejes del control para mover el plano. Al confirmar se crearán ambas partes." : "Mové la posición o incliná el plano para actualizar la vista previa."}</small>
                    <label className="interlock-toggle">
                      <input type="checkbox" checked={interlocksEnabled} disabled={cutTilted} onChange={(event) => setInterlocksEnabled(event.target.checked)} />
                      <span>Agregar encastres macho/hembra</span>
                    </label>
                    {cutTilted && <small>Los encastres automáticos se ofrecen en cortes rectos. El corte inclinado se puede confirmar sin encastres.</small>}
                    {interlocksEnabled && (
                      <div className="interlock-options">
                        <label>
                          <span>Tipo</span>
                          <select value={interlockShape} onChange={(event) => setInterlockShape(event.target.value as InterlockShape)}>
                            <option value="elastic">Clip elástico · traba</option>
                            <option value="round">Guía redonda</option>
                            <option value="square">Guía cuadrada</option>
                          </select>
                        </label>
                        <label>
                          <span>Cantidad</span>
                          <select value={interlockCount} onChange={(event) => setInterlockCount(event.target.value)}>
                            {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>Holgura por lado · mm</span>
                          <input type="number" min="0.1" max="1" step="0.05" value={interlockClearance} onChange={(event) => setInterlockClearance(event.target.value)} />
                        </label>
                        <small>
                          {!interlockClearanceValid
                            ? "La holgura debe estar entre 0,1 y 1 mm por lado."
                            : interlockSuggestion?.available
                              ? (interlockShape === "elastic"
                                ? "Traba automática: dos patas flexibles de " + interlockSuggestion.diameter.toFixed(1) + " mm · profundidad " + interlockSuggestion.depth.toFixed(1) + " mm. Tamaño calculado para esta sección. Conviene PETG o TPU."
                                : "Tamaño automático: " + (interlockShape === "round" ? "Ø" : "lado ") + interlockSuggestion.diameter.toFixed(1) + " mm · profundidad " + interlockSuggestion.depth.toFixed(1) + " mm. Tamaño calculado para esta sección. Las guías alinean, no traban.")
                              : "La sección real no deja espacio para este encastre. Probá con menos trabas, un corte en otra zona o confirmá sin encastres."}
                        </small>
                      </div>
                    )}
                    <button
                      className="primary-button"
                      disabled={!cutPreview || cutBusy || !cutPositionValid || (interlocksEnabled && !cutCanUseInterlocks)}
                      onClick={() => confirmPlanarCut()}
                    >Confirmar corte</button>
                    {interlocksEnabled && !cutCanUseInterlocks && (
                      <button className="primary-button" disabled={!cutPreview || cutBusy || !cutPositionValid} onClick={() => confirmPlanarCut(true)}>Confirmar corte sin encastres</button>
                    )}
                    <button className="secondary-button" onClick={cancelHeightCut}>Cancelar corte</button>
                  </>
                )}
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
                      <span>{selected.kind === "cylinder" ? "Espesor radial" : "Espesor de pared"}</span>
                      <input
                        aria-label={selected.kind === "cylinder" ? "Espesor radial para vaciado cilíndrico" : selected.kind === "custom" ? "Espesor de pared para vaciado de malla personalizada" : "Espesor de pared para vaciado esférico"}
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={wallThicknesses.left}
                        onChange={(event) => setWallThicknesses((current) => ({ ...current, left: event.target.value }))}
                      />
                    </label>
                    <small>{selected.kind === "cylinder" ? "El cilindro se convierte en un tubo con agujero pasante." : selected.kind === "custom" ? "Si la malla tiene una cara superior plana, la cavidad se abre allí. En los demás casos queda cerrada y podés verla con un corte." : "La esfera queda hueca por dentro, con la superficie exterior cerrada."}</small>
                  </>
                )}
                <button className="primary-button" disabled={hollowBusy} onClick={handleHollow}>
                  {hollowBusy ? "Vaciando pieza…" : "Vaciar pieza"}
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
