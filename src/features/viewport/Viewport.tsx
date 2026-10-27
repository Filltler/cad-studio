import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useEditorStore } from "../editor/editorStore";

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null);
  const objects = useEditorStore((s) => s.objects);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectObject = useEditorStore((s) => s.selectObject);
  const meshMap = useRef(new Map<string, THREE.Mesh>());

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
    controls.enableDamping = true;
    controls.target.set(0, 10, 0);

    scene.add(new THREE.GridHelper(200, 40, "#64748b", "#263449"));
    scene.add(new THREE.AxesHelper(30));

    const ambient = new THREE.HemisphereLight("#dbeafe", "#334155", 2.0);
    scene.add(ambient);
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
    const onPointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...meshMap.current.values()], false);
      selectObject(hits[0]?.object.userData.objectId ?? null);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

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
      controls.dispose();
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
  }, [selectObject]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = host?.querySelector("canvas");
    if (!host || !canvas) return;

    const scene = (host as HTMLDivElement & { __cadScene?: THREE.Scene }).__cadScene;
    if (!scene) return;

    const existing = meshMap.current;
    const ids = new Set(objects.map((o) => o.id));
    for (const [id, mesh] of existing) {
      if (!ids.has(id)) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
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
  }, [objects, selectedId]);

  return <div className="viewport-canvas" ref={hostRef} />;
}
