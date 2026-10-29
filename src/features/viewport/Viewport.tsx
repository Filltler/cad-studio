import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { useEditorStore } from "../editor/editorStore";
import type { CutAxis } from "../../services/booleanOperations";

type TransformMode = "translate" | "rotate" | "scale";
type CutPlaneSpec = {
  objectId: string;
  axis: CutAxis;
  normal: [number, number, number];
  tilted: boolean;
  position: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
};
type ViewportProps = {
  multiSelectMode?: boolean;
  multiSelectedIds?: string[];
  onObjectSelect?: (id: string | null, additive: boolean) => void;
  onObjectsMarqueeSelect?: (ids: string[], additive: boolean) => void;
  preview?: { objectId: string; vertices: number[] } | null;
  cutPlane?: CutPlaneSpec | null;
  onCutPositionChange?: (position: number) => void;
};

const modeLabels: Record<TransformMode, string> = {
  translate: "Mover",
  rotate: "Rotar",
  scale: "Escalar"
};

export function Viewport({ multiSelectMode = false, multiSelectedIds = [], onObjectSelect, onObjectsMarqueeSelect, preview = null, cutPlane = null, onCutPositionChange }: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectObject = useEditorStore((s) => s.selectObject);
  const updateObject = useEditorStore((s) => s.updateObject);
  const updateObjectsPositions = useEditorStore((s) => s.updateObjectsPositions);
  const beginTransaction = useEditorStore((s) => s.beginTransaction);
  const endTransaction = useEditorStore((s) => s.endTransaction);
  const [mode, setMode] = useState<TransformMode>("translate");
  const meshMap = useRef(new Map<string, THREE.Mesh>());
  const meshCenterById = useRef(new Map<string, THREE.Vector3>());
  const previewMeshRef = useRef<THREE.Mesh | null>(null);
  const cutPlaneGroupRef = useRef<THREE.Group | null>(null);
  const cutPlaneSurfaceRef = useRef<THREE.Mesh | null>(null);
  const multiMoveGroupRef = useRef<THREE.Group | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const objectsRef = useRef(objects);
  const selectedIdRef = useRef(selectedId);
  const multiSelectModeRef = useRef(multiSelectMode);
  const multiSelectedIdsRef = useRef(multiSelectedIds);
  const multiMoveDragRef = useRef<{ startCenter: THREE.Vector3; startPositions: Record<string, { x: number; y: number; z: number }> } | null>(null);
  const onObjectSelectRef = useRef(onObjectSelect);
  const onObjectsMarqueeSelectRef = useRef(onObjectsMarqueeSelect);
  const previewRef = useRef(preview);
  const cutPlaneRef = useRef(cutPlane);
  const onCutPositionChangeRef = useRef(onCutPositionChange);
  const selectionDragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  objectsRef.current = objects;
  selectedIdRef.current = selectedId;
  multiSelectModeRef.current = multiSelectMode;
  multiSelectedIdsRef.current = multiSelectedIds;
  onObjectSelectRef.current = onObjectSelect;
  onObjectsMarqueeSelectRef.current = onObjectsMarqueeSelect;
  previewRef.current = preview;
  cutPlaneRef.current = cutPlane;
  onCutPositionChangeRef.current = onCutPositionChange;
  const modeRef = useRef<TransformMode>("translate");
  const dimensionHandles = useRef<THREE.Mesh[]>([]);
  const dragState = useRef<{
    objectId: string;
    axis: "x" | "y" | "z";
    sign: 1 | -1;
    startPoint: THREE.Vector3;
    plane: THREE.Plane;
    axisDirection: THREE.Vector3;
    startDimensions: { x: number; y: number; z: number };
    startPosition: { x: number; y: number; z: number };
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#101827");

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(95, 85, 115);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    orbitRef.current = controls;
    controls.enableDamping = true;
    controls.target.set(0, 10, 0);

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode(mode);
    transform.setSize(0.85);
    transformRef.current = transform;
    scene.add(transform.getHelper());

    const cutPlaneGroup = new THREE.Group();
    cutPlaneGroup.userData.cutPlaneHandle = true;
    const cutPlaneSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
    );
    cutPlaneSurface.userData.cutPlaneSurface = true;
    cutPlaneSurface.renderOrder = 8;
    cutPlaneGroup.add(cutPlaneSurface);
    const cutPlaneCenter = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 16, 12),
      new THREE.MeshBasicMaterial({ color: "#f59e0b", depthTest: false })
    );
    cutPlaneCenter.userData.cutPlaneCenter = true;
    cutPlaneCenter.renderOrder = 9;
    cutPlaneGroup.add(cutPlaneCenter);
    cutPlaneGroup.visible = false;
    scene.add(cutPlaneGroup);
    cutPlaneGroupRef.current = cutPlaneGroup;
    cutPlaneSurfaceRef.current = cutPlaneSurface;
    const multiMoveGroup = new THREE.Group();
    multiMoveGroup.userData.multiMoveHandle = true;
    scene.add(multiMoveGroup);
    multiMoveGroupRef.current = multiMoveGroup;

    // Six face-center handles for direct dimension editing in Scale mode.
    const handleMaterial = [
      new THREE.MeshBasicMaterial({ color: "#ef4444", depthTest: false }),
      new THREE.MeshBasicMaterial({ color: "#ef4444", depthTest: false }),
      new THREE.MeshBasicMaterial({ color: "#22c55e", depthTest: false }),
      new THREE.MeshBasicMaterial({ color: "#22c55e", depthTest: false }),
      new THREE.MeshBasicMaterial({ color: "#3b82f6", depthTest: false }),
      new THREE.MeshBasicMaterial({ color: "#3b82f6", depthTest: false })
    ];
    for (let i = 0; i < 6; i++) {
      const handle = new THREE.Mesh(new THREE.SphereGeometry(1.35, 20, 16), handleMaterial[i]);
      handle.renderOrder = 10;
      handle.userData.dimensionHandle = true;
      handle.userData.axis = (["x", "x", "y", "y", "z", "z"] as const)[i];
      handle.userData.sign = ([1, -1, 1, -1, 1, -1] as const)[i];
      handle.visible = false;
      dimensionHandles.current.push(handle);
      scene.add(handle);
    }

    transform.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      const activeObject = transform.object;
      if (activeObject?.userData.cutPlaneHandle) return;
      if (activeObject?.userData.multiMoveHandle) {
        if (event.value) {
          beginTransaction();
          const positions: Record<string, { x: number; y: number; z: number }> = {};
          const objectsById = new Map(objectsRef.current.map((object) => [object.id, object]));
          for (const id of multiSelectedIdsRef.current) {
            const object = objectsById.get(id);
            if (object) positions[id] = { ...object.position };
          }
          multiMoveDragRef.current = { startCenter: activeObject.position.clone(), startPositions: positions };
        } else {
          multiMoveDragRef.current = null;
          endTransaction();
        }
        return;
      }
      if (event.value) beginTransaction();
      else endTransaction();
    });
    transform.addEventListener("objectChange", () => {
      const activeObject = transform.object;
      if (activeObject?.userData.cutPlaneHandle) {
        const normal = cutPlaneRef.current?.normal;
        if (normal) onCutPositionChangeRef.current?.(activeObject.position.x * normal[0] + activeObject.position.y * normal[1] + activeObject.position.z * normal[2]);
        return;
      }
      if (activeObject?.userData.multiMoveHandle) {
        const drag = multiMoveDragRef.current;
        if (!drag) return;
        const delta = activeObject.position.clone().sub(drag.startCenter);
        const positions: Record<string, { x: number; y: number; z: number }> = {};
        for (const [id, start] of Object.entries(drag.startPositions)) {
          positions[id] = { x: start.x + delta.x, y: start.y + delta.y, z: start.z + delta.z };
        }
        updateObjectsPositions(positions);
        return;
      }
      const mesh = activeObject as THREE.Mesh | undefined;
      const id = mesh?.userData.objectId as string | undefined;
      if (!mesh || !id) return;
      const source = objectsRef.current.find((object) => object.id === id);
      if (source?.kind === "custom") {
        const center = meshCenterById.current.get(id) ?? new THREE.Vector3();
        updateObject(id, {
          position: { x: mesh.position.x - center.x, y: mesh.position.y - center.y, z: mesh.position.z - center.z },
          rotation: {
            x: THREE.MathUtils.radToDeg(mesh.rotation.x),
            y: THREE.MathUtils.radToDeg(mesh.rotation.y),
            z: THREE.MathUtils.radToDeg(mesh.rotation.z)
          }
        });
        return;
      }
      updateObject(id, {
        position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
        dimensions: {
          x: Math.max(0.1, Math.abs(mesh.scale.x)),
          y: Math.max(0.1, Math.abs(mesh.scale.y)),
          z: Math.max(0.1, Math.abs(mesh.scale.z))
        },
        rotation: {
          x: THREE.MathUtils.radToDeg(mesh.rotation.x),
          y: THREE.MathUtils.radToDeg(mesh.rotation.y),
          z: THREE.MathUtils.radToDeg(mesh.rotation.z)
        }
      });
    });

    scene.add(new THREE.GridHelper(200, 40, "#64748b", "#263449"));
    scene.add(new THREE.AxesHelper(30));
    scene.add(new THREE.HemisphereLight("#dbeafe", "#334155", 2.0));
    const keyLight = new THREE.DirectionalLight("#ffffff", 2.5);
    keyLight.position.set(80, 120, 60);
    scene.add(keyLight);
    (host as HTMLDivElement & { __cadScene?: THREE.Scene }).__cadScene = scene;

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const getPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };
    const clampToCanvas = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: THREE.MathUtils.clamp(clientX, rect.left, rect.right),
        y: THREE.MathUtils.clamp(clientY, rect.top, rect.bottom),
        rect
      };
    };
    const updateSelectionBox = (startX: number, startY: number, clientX: number, clientY: number) => {
      const end = clampToCanvas(clientX, clientY);
      const box = selectionBoxRef.current;
      if (box) {
        box.style.display = "block";
        box.style.left = Math.min(startX, end.x) - end.rect.left + "px";
        box.style.top = Math.min(startY, end.y) - end.rect.top + "px";
        box.style.width = Math.abs(end.x - startX) + "px";
        box.style.height = Math.abs(end.y - startY) + "px";
      }
      return end;
    };
    const getObjectsFullyInsideSelection = (startX: number, startY: number, endX: number, endY: number) => {
      const canvasRect = renderer.domElement.getBoundingClientRect();
      const selection = {
        left: Math.min(startX, endX),
        right: Math.max(startX, endX),
        top: Math.min(startY, endY),
        bottom: Math.max(startY, endY)
      };
      const selectionCenterX = (selection.left + selection.right) / 2;
      const selectionCenterY = (selection.top + selection.bottom) / 2;
      const contained: { id: string; distance: number; screenX: number; screenY: number }[] = [];
      for (const mesh of meshMap.current.values()) {
        if (!mesh.visible) continue;
        mesh.updateWorldMatrix(true, false);
        const bounds = new THREE.Box3().setFromObject(mesh);
        if (bounds.isEmpty()) continue;
        let fullyInside = true;
        for (const x of [bounds.min.x, bounds.max.x]) {
          for (const y of [bounds.min.y, bounds.max.y]) {
            for (const z of [bounds.min.z, bounds.max.z]) {
              const projected = new THREE.Vector3(x, y, z).project(camera);
              const screenX = canvasRect.left + (projected.x + 1) * 0.5 * canvasRect.width;
              const screenY = canvasRect.top + (1 - projected.y) * 0.5 * canvasRect.height;
              if (projected.z < -1 || projected.z > 1 || screenX < selection.left - 0.5 || screenX > selection.right + 0.5 || screenY < selection.top - 0.5 || screenY > selection.bottom + 0.5) {
                fullyInside = false;
                break;
              }
            }
            if (!fullyInside) break;
          }
          if (!fullyInside) break;
        }
        const id = mesh.userData.objectId as string | undefined;
        if (!fullyInside || !id) continue;
        const center = bounds.getCenter(new THREE.Vector3()).project(camera);
        const screenX = canvasRect.left + (center.x + 1) * 0.5 * canvasRect.width;
        const screenY = canvasRect.top + (1 - center.y) * 0.5 * canvasRect.height;
        contained.push({ id, distance: (screenX - selectionCenterX) ** 2 + (screenY - selectionCenterY) ** 2, screenX, screenY });
      }
      return contained
        .sort((a, b) => a.distance - b.distance || a.screenX - b.screenX || a.screenY - b.screenY || a.id.localeCompare(b.id))
        .map((item) => item.id);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (transform.dragging) return;
      getPointer(event);
      if (cutPlaneRef.current && event.button === 0) return;
      if (event.button === 0 && event.shiftKey && !previewRef.current && !cutPlaneRef.current) {
        const objectHit = raycaster.intersectObjects([...meshMap.current.values()], false)[0];
        const dimensionHandleHit = raycaster.intersectObjects(dimensionHandles.current, false)[0];
        const transformHandleHit = Boolean(transform.object && transform.axis);
        if (!objectHit && !dimensionHandleHit && !transformHandleHit) {
          const start = clampToCanvas(event.clientX, event.clientY);
          selectionDragRef.current = { pointerId: event.pointerId, startX: start.x, startY: start.y };
          controls.enabled = false;
          host.classList.add("marquee-selecting");
          updateSelectionBox(start.x, start.y, start.x, start.y);
          try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* Ignore unsupported pointer capture. */ }
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      if (modeRef.current === "scale") {
        const handleHit = raycaster.intersectObjects(dimensionHandles.current, false)[0];
        const handle = handleHit?.object as THREE.Mesh | undefined;
        const selected = selectedIdRef.current ? meshMap.current.get(selectedIdRef.current) : undefined;
        if (handle && selected) {
          const axis = handle.userData.axis as "x" | "y" | "z";
          const sign = handle.userData.sign as 1 | -1;
          selected.updateMatrixWorld(true);
          const axisDirection = new THREE.Vector3(
            axis === "x" ? 1 : 0,
            axis === "y" ? 1 : 0,
            axis === "z" ? 1 : 0
          ).applyQuaternion(selected.quaternion).normalize();
          const cameraDirection = new THREE.Vector3();
          camera.getWorldDirection(cameraDirection);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDirection, handle.position);
          const startPoint = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(plane, startPoint)) {
            const object = objectsRef.current.find((item) => item.id === selected.userData.objectId);
            if (object) {
              beginTransaction();
              dragState.current = {
                objectId: object.id,
                axis,
                sign,
                startPoint,
                plane,
                axisDirection,
                startDimensions: { ...object.dimensions },
                startPosition: { ...object.position }
              };
              controls.enabled = false;
              event.preventDefault();
              return;
            }
          }
        }
      }
      const hits = raycaster.intersectObjects([...meshMap.current.values()], false);
      const hitId = (hits[0]?.object.userData.objectId as string | undefined) ?? null;
      if (onObjectSelectRef.current) onObjectSelectRef.current(hitId, hitId !== null && (event.shiftKey || event.ctrlKey || event.metaKey || multiSelectModeRef.current));
      else selectObject(hitId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const marquee = selectionDragRef.current;
      if (marquee && marquee.pointerId === event.pointerId) {
        updateSelectionBox(marquee.startX, marquee.startY, event.clientX, event.clientY);
        event.preventDefault();
        return;
      }
      const drag = dragState.current;
      if (!drag) return;
      getPointer(event);
      const point = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(drag.plane, point)) return;
      const delta = point.sub(drag.startPoint).dot(drag.axisDirection) * drag.sign;
      const dimensions = { ...drag.startDimensions, [drag.axis]: Math.max(0.5, drag.startDimensions[drag.axis] + delta) };
      const startSize = drag.startDimensions[drag.axis];
      const newSize = dimensions[drag.axis];
      // Keep the opposite face fixed in world space while moving only the dragged face.
      const oppositeFace = drag.axisDirection.clone().multiplyScalar(-drag.sign * startSize / 2);
      oppositeFace.add(new THREE.Vector3(drag.startPosition.x, drag.startPosition.y, drag.startPosition.z));
      const positionVector = oppositeFace.add(
        drag.axisDirection.clone().multiplyScalar(drag.sign * newSize / 2)
      );
      const position = { x: positionVector.x, y: positionVector.y, z: positionVector.z };
      updateObject(drag.objectId, { dimensions, position });
    };
    const onPointerUp = (event: PointerEvent) => {
      const marquee = selectionDragRef.current;
      if (marquee && marquee.pointerId === event.pointerId) {
        const end = updateSelectionBox(marquee.startX, marquee.startY, event.clientX, event.clientY);
        const moved = Math.hypot(end.x - marquee.startX, end.y - marquee.startY) >= 5;
        selectionDragRef.current = null;
        host.classList.remove("marquee-selecting");
        if (selectionBoxRef.current) selectionBoxRef.current.style.display = "none";
        controls.enabled = true;
        if (event.type === "pointerup" && moved) {
          const ids = getObjectsFullyInsideSelection(marquee.startX, marquee.startY, end.x, end.y);
          if (ids.length) onObjectsMarqueeSelectRef.current?.(ids, true);
        }
        try {
          if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
        } catch { /* Ignore unsupported pointer capture. */ }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (dragState.current) {
        dragState.current = null;
        controls.enabled = true;
        endTransaction();
      }
    };
    const cancelMarqueeOnEscape = (event: KeyboardEvent) => {
      const marquee = selectionDragRef.current;
      if (event.key !== "Escape" || !marquee) return;
      selectionDragRef.current = null;
      host.classList.remove("marquee-selecting");
      if (selectionBoxRef.current) selectionBoxRef.current.style.display = "none";
      controls.enabled = true;
      try {
        if (renderer.domElement.hasPointerCapture(marquee.pointerId)) renderer.domElement.releasePointerCapture(marquee.pointerId);
      } catch { /* Ignore unsupported pointer capture. */ }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown, true);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp, true);
    renderer.domElement.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("keydown", cancelMarqueeOnEscape);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown, true);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp, true);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("keydown", cancelMarqueeOnEscape);
      selectionDragRef.current = null;
      host.classList.remove("marquee-selecting");
      if (selectionBoxRef.current) selectionBoxRef.current.style.display = "none";
      dimensionHandles.current.forEach((handle) => {
        handle.geometry.dispose();
        (handle.material as THREE.Material).dispose();
        scene.remove(handle);
      });
      dimensionHandles.current = [];
      controls.dispose();
      transform.dispose();
      transformRef.current = null;
      orbitRef.current = null;
      meshMap.current.forEach((mesh) => {
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      });
      meshMap.current.clear();
      meshCenterById.current.clear();
      if (previewMeshRef.current) {
        scene.remove(previewMeshRef.current);
        previewMeshRef.current.geometry.dispose();
        (previewMeshRef.current.material as THREE.Material).dispose();
        previewMeshRef.current = null;
      }
      if (cutPlaneGroupRef.current) {
        transform.detach();
        scene.remove(cutPlaneGroupRef.current);
        cutPlaneGroupRef.current.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            const material = child.material;
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material.dispose();
          }
        });
        cutPlaneGroupRef.current = null;
        cutPlaneSurfaceRef.current = null;
      }
      if (multiMoveGroupRef.current) {
        transform.detach();
        scene.remove(multiMoveGroupRef.current);
        multiMoveGroupRef.current = null;
      }
      delete (host as HTMLDivElement & { __cadScene?: THREE.Scene }).__cadScene;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [selectObject, updateObject]);

  useEffect(() => {
    modeRef.current = mode;
    const transform = transformRef.current;
    const selected = selectedIdRef.current ? meshMap.current.get(selectedIdRef.current) : undefined;
    const activeCutPlane = cutPlaneRef.current;
    const cutGroup = cutPlaneGroupRef.current;
    const multiGroup = multiMoveGroupRef.current;
    const multiCount = multiSelectedIdsRef.current.filter((id) => meshMap.current.has(id)).length;
    const activeMultiMove = !activeCutPlane && mode === "translate" && multiCount >= 2;
    if (transform) {
      if (activeCutPlane && cutGroup?.visible) {
        if (transform.getMode() !== "translate") transform.setMode("translate");
        if (transform.space !== "world") transform.setSpace("world");
        transform.showX = activeCutPlane.tilted || activeCutPlane.axis === "x";
        transform.showY = activeCutPlane.tilted || activeCutPlane.axis === "y";
        transform.showZ = activeCutPlane.tilted || activeCutPlane.axis === "z";
        transform.getHelper().visible = true;
        if (transform.object !== cutGroup) transform.attach(cutGroup);
      } else if (activeMultiMove && multiGroup) {
        if (transform.getMode() !== "translate") transform.setMode("translate");
        if (transform.space !== "world") transform.setSpace("world");
        transform.showX = true;
        transform.showY = true;
        transform.showZ = true;
        transform.getHelper().visible = true;
        if (transform.object !== multiGroup) transform.attach(multiGroup);
      } else {
        transform.setSpace("local");
        transform.showX = true;
        transform.showY = true;
        transform.showZ = true;
        transform.setMode(mode);
        transform.getHelper().visible = mode !== "scale";
        if (mode === "scale") transform.detach();
        else if (selected) transform.attach(selected);
      }
    }
    dimensionHandles.current.forEach((handle) => {
      handle.visible = Boolean(selected && mode === "scale" && !activeCutPlane && !activeMultiMove);
    });
    if (selected && !activeCutPlane && !activeMultiMove) {
      selected.updateMatrixWorld(true);
      dimensionHandles.current.forEach((handle) => {
        const axis = handle.userData.axis as "x" | "y" | "z";
        const sign = handle.userData.sign as 1 | -1;
        const localPoint = new THREE.Vector3(
          axis === "x" ? 0.5 * sign : 0,
          axis === "y" ? 0.5 * sign : 0,
          axis === "z" ? 0.5 * sign : 0
        );
        handle.position.copy(selected.localToWorld(localPoint));
      });
    }
  }, [mode, multiSelectedIds]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host?.querySelector("canvas")) return;
    const scene = (host as HTMLDivElement & { __cadScene?: THREE.Scene }).__cadScene;
    if (!scene) return;

    const existing = meshMap.current;
    const ids = new Set(objects.map((o) => o.id));
    for (const [id, mesh] of existing) {
      if (!ids.has(id)) {
        if (transformRef.current?.object === mesh) transformRef.current.detach();
        scene.remove(mesh);
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
        existing.delete(id);
      }
    }
    for (const object of objects) {
      let mesh = existing.get(object.id);
      if (!mesh) {
        const geometry = object.kind === "custom"
          ? new THREE.BufferGeometry()
          : object.kind === "box"
            ? new THREE.BoxGeometry(1, 1, 1)
            : object.kind === "cylinder"
              ? new THREE.CylinderGeometry(0.5, 0.5, 1, 48)
              : new THREE.SphereGeometry(0.5, 32, 24);
        if (object.kind === "custom") {
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(object.geometryVertices ?? [], 3));
          geometry.computeBoundingBox();
          const center = geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
          geometry.translate(-center.x, -center.y, -center.z);
          geometry.computeVertexNormals();
          meshCenterById.current.set(object.id, center);
        }
        const material = new THREE.MeshStandardMaterial({
          color: object.color ?? "#8b9cf6",
          metalness: 0.12,
          roughness: 0.38
        });
        mesh = new THREE.Mesh(geometry, material);
        mesh.userData.objectId = object.id;
        existing.set(object.id, mesh);
        scene.add(mesh);
      }
      if (object.kind === "custom") {
        const center = meshCenterById.current.get(object.id) ?? new THREE.Vector3();
        mesh.position.set(center.x + object.position.x, center.y + object.position.y, center.z + object.position.z);
        mesh.scale.set(1, 1, 1);
        mesh.rotation.set(
          THREE.MathUtils.degToRad(object.rotation?.x ?? 0),
          THREE.MathUtils.degToRad(object.rotation?.y ?? 0),
          THREE.MathUtils.degToRad(object.rotation?.z ?? 0)
        );
      } else {
        mesh.position.set(object.position.x, object.position.y, object.position.z);
        mesh.scale.set(object.dimensions.x, object.dimensions.y, object.dimensions.z);
        mesh.rotation.set(
        THREE.MathUtils.degToRad(object.rotation?.x ?? 0),
        THREE.MathUtils.degToRad(object.rotation?.y ?? 0),
        THREE.MathUtils.degToRad(object.rotation?.z ?? 0)
        );
      }
      (mesh.material as THREE.MeshStandardMaterial).color.set(object.color ?? "#8b9cf6");
    }

    const selectedMesh = selectedId ? existing.get(selectedId) : undefined;
    const activeCutPlane = cutPlane && cutPlane.objectId === selectedId ? cutPlane : null;
    const selectedForMultiMove = multiSelectedIds.filter((id) => existing.has(id));
    const activeMultiMove = !activeCutPlane && modeRef.current === "translate" && selectedForMultiMove.length >= 2;
    const multiMoveGroup = multiMoveGroupRef.current;
    existing.forEach((mesh, id) => { mesh.visible = !(preview && id === preview.objectId); });
    if (preview) {
      let previewMesh = previewMeshRef.current;
      if (!previewMesh) {
        previewMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: "#22d3ee", transparent: true, opacity: 0.92, side: THREE.DoubleSide }));
        previewMesh.userData.planarCutPreview = true;
        previewMeshRef.current = previewMesh;
        scene.add(previewMesh);
      }
      previewMesh.geometry.dispose();
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(preview.vertices, 3));
      geometry.computeVertexNormals();
      previewMesh.geometry = geometry;
      previewMesh.visible = true;
    } else if (previewMeshRef.current) {
      previewMeshRef.current.visible = false;
    }

    const cutGroup = cutPlaneGroupRef.current;
    const cutSurface = cutPlaneSurfaceRef.current;
    if (cutGroup && cutSurface && activeCutPlane) {
      const minimum = new THREE.Vector3(...activeCutPlane.bounds.min);
      const maximum = new THREE.Vector3(...activeCutPlane.bounds.max);
      const direction = new THREE.Vector3(...activeCutPlane.normal).normalize();
      const boundsCenter = minimum.clone().add(maximum).multiplyScalar(0.5);
      const center = boundsCenter.addScaledVector(direction, activeCutPlane.position - boundsCenter.dot(direction));
      cutGroup.position.copy(center);
      cutGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
      cutSurface.rotation.set(0, 0, 0);
      const span = maximum.sub(minimum).length() * 2 + 2;
      cutSurface.scale.set(span, span, 1);
      cutGroup.visible = true;
      cutGroup.updateMatrixWorld(true);
      if (transformRef.current) {
        const transform = transformRef.current;
        if (transform.getMode() !== "translate") transform.setMode("translate");
        if (transform.space !== "world") transform.setSpace("world");
        transform.showX = activeCutPlane.tilted || activeCutPlane.axis === "x";
        transform.showY = activeCutPlane.tilted || activeCutPlane.axis === "y";
        transform.showZ = activeCutPlane.tilted || activeCutPlane.axis === "z";
        transform.getHelper().visible = true;
        if (transform.object !== cutGroup) transform.attach(cutGroup);
      }
    } else if (activeMultiMove && multiMoveGroup) {
      if (cutGroup) cutGroup.visible = false;
      const selectionBounds = new THREE.Box3();
      for (const id of selectedForMultiMove) {
        const mesh = existing.get(id);
        if (mesh) selectionBounds.expandByObject(mesh);
      }
      if (!selectionBounds.isEmpty()) multiMoveGroup.position.copy(selectionBounds.getCenter(new THREE.Vector3()));
      multiMoveGroup.visible = true;
      multiMoveGroup.updateMatrixWorld(true);
      if (transformRef.current) {
        const transform = transformRef.current;
        if (transform.getMode() !== "translate") transform.setMode("translate");
        if (transform.space !== "world") transform.setSpace("world");
        transform.showX = true;
        transform.showY = true;
        transform.showZ = true;
        transform.getHelper().visible = true;
        if (transform.object !== multiMoveGroup) transform.attach(multiMoveGroup);
      }
    } else {
      if (cutGroup) cutGroup.visible = false;
      if (multiMoveGroup) multiMoveGroup.visible = false;
      if (transformRef.current) {
        transformRef.current.setSpace("local");
        transformRef.current.showX = true;
        transformRef.current.showY = true;
        transformRef.current.showZ = true;
        transformRef.current.setMode(modeRef.current);
        transformRef.current.getHelper().visible = modeRef.current !== "scale";
        if (selectedMesh && modeRef.current !== "scale" && !preview) transformRef.current.attach(selectedMesh);
        else transformRef.current.detach();
      }
    }

    dimensionHandles.current.forEach((handle) => {
      handle.visible = Boolean(selectedMesh && modeRef.current === "scale" && !activeCutPlane && !activeMultiMove);
    });
    if (selectedMesh && !activeCutPlane && !activeMultiMove && !preview) {
      selectedMesh.updateMatrixWorld(true);
      dimensionHandles.current.forEach((handle) => {
        const axis = handle.userData.axis as "x" | "y" | "z";
        const sign = handle.userData.sign as 1 | -1;
        const localPoint = new THREE.Vector3(
          axis === "x" ? 0.5 * sign : 0,
          axis === "y" ? 0.5 * sign : 0,
          axis === "z" ? 0.5 * sign : 0
        );
        handle.position.copy(selectedMesh.localToWorld(localPoint));
      });
    }
  }, [objects, selectedId, preview, cutPlane, multiSelectedIds, mode]);

  return (
    <div className="viewport-stage">
      <div className="transform-toolbar" role="toolbar" aria-label="Herramientas de transformación">
        {(Object.keys(modeLabels) as TransformMode[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`transform-mode-button ${mode === key ? "active" : ""}`}
            onClick={() => setMode(key)}
            aria-pressed={mode === key}
            title={`Modo ${modeLabels[key].toLowerCase()}`}
          >
            {key === "translate" ? "↔" : key === "rotate" ? "⟳" : "⤢"} {modeLabels[key]}
          </button>
        ))}
        <span className="transform-hint">{multiSelectedIds.filter((id) => objectsRef.current.some((object) => object.id === id)).length > 1 && mode === "translate" ? "Arrastrá un eje para mover todas las piezas seleccionadas" : "Seleccioná una pieza y arrastrá los controles"}</span>
      </div>
      <div className="viewport-canvas" ref={hostRef}>
        <div ref={selectionBoxRef} className="selection-marquee" aria-hidden="true" />
      </div>
    </div>
  );
}
