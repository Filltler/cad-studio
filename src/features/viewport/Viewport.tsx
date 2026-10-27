import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { useEditorStore } from "../editor/editorStore";

type TransformMode = "translate" | "rotate" | "scale";

const modeLabels: Record<TransformMode, string> = {
  translate: "Mover",
  rotate: "Rotar",
  scale: "Escalar"
};

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null);
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectObject = useEditorStore((s) => s.selectObject);
  const updateObject = useEditorStore((s) => s.updateObject);
  const [mode, setMode] = useState<TransformMode>("translate");
  const meshMap = useRef(new Map<string, THREE.Mesh>());
  const transformRef = useRef<TransformControls | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const objectsRef = useRef(objects);
  const selectedIdRef = useRef(selectedId);
  objectsRef.current = objects;
  selectedIdRef.current = selectedId;
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
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 12), handleMaterial[i]);
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
    });
    transform.addEventListener("objectChange", () => {
      const mesh = transform.object as THREE.Mesh | undefined;
      const id = mesh?.userData.objectId as string | undefined;
      if (!mesh || !id) return;
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
    const onPointerDown = (event: PointerEvent) => {
      if (transform.dragging) return;
      getPointer(event);
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
      selectObject(hits[0]?.object.userData.objectId ?? null);
    };
    const onPointerMove = (event: PointerEvent) => {
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
    const onPointerUp = () => {
      if (dragState.current) {
        dragState.current = null;
        controls.enabled = true;
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);

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
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
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
      delete (host as HTMLDivElement & { __cadScene?: THREE.Scene }).__cadScene;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [selectObject, updateObject]);

  useEffect(() => {
    modeRef.current = mode;
    const transform = transformRef.current;
    const selected = selectedIdRef.current ? meshMap.current.get(selectedIdRef.current) : undefined;
    if (transform) {
      transform.setMode(mode);
      transform.getHelper().visible = mode !== "scale";
      if (mode === "scale") transform.detach();
      else if (selected) transform.attach(selected);
    }
    dimensionHandles.current.forEach((handle) => {
      handle.visible = Boolean(selected && mode === "scale");
    });
    if (selected) {
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
  }, [mode]);

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
        const geometry = object.kind === "box"
          ? new THREE.BoxGeometry(1, 1, 1)
          : object.kind === "cylinder"
            ? new THREE.CylinderGeometry(0.5, 0.5, 1, 48)
            : new THREE.SphereGeometry(0.5, 32, 24);
        const material = new THREE.MeshStandardMaterial({
          color: object.id === selectedId ? "#60a5fa" : "#8b9cf6",
          metalness: 0.12,
          roughness: 0.38
        });
        mesh = new THREE.Mesh(geometry, material);
        mesh.userData.objectId = object.id;
        existing.set(object.id, mesh);
        scene.add(mesh);
      }
      mesh.position.set(object.position.x, object.position.y, object.position.z);
      mesh.scale.set(object.dimensions.x, object.dimensions.y, object.dimensions.z);
      mesh.rotation.set(
        THREE.MathUtils.degToRad(object.rotation?.x ?? 0),
        THREE.MathUtils.degToRad(object.rotation?.y ?? 0),
        THREE.MathUtils.degToRad(object.rotation?.z ?? 0)
      );
      (mesh.material as THREE.MeshStandardMaterial).color.set(object.id === selectedId ? "#60a5fa" : "#8b9cf6");
    }

    const selectedMesh = selectedId ? existing.get(selectedId) : undefined;
    if (selectedMesh && modeRef.current !== "scale") transformRef.current?.attach(selectedMesh);
    else transformRef.current?.detach();

    dimensionHandles.current.forEach((handle) => {
      handle.visible = Boolean(selectedMesh && modeRef.current === "scale");
    });
    if (selectedMesh) {
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
  }, [objects, selectedId]);

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
        <span className="transform-hint">Seleccioná una pieza y arrastrá los controles</span>
      </div>
      <div className="viewport-canvas" ref={hostRef} />
    </div>
  );
}
