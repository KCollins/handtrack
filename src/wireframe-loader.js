import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { scene } from './scene.js';

const loader = new GLTFLoader();

// Container added directly to the main Three.js scene
export const modelGroup = new THREE.Group();
scene.add(modelGroup);

/**
 * Loads a GLTF/GLB model from URL or File Blob, normalizes scale/center,
 * and attaches glowing wireframe edge overlays.
 */
export function loadModelWithWireframe(source, onComplete) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);

  loader.load(url, (gltf) => {
    // Clear previous model from the scene group
    while (modelGroup.children.length > 0) {
      modelGroup.remove(modelGroup.children[0]);
    }

    const rawModel = gltf.scene;

    // 1. Center geometry at origin (0, 0, 0)
    const box = new THREE.Box3().setFromObject(rawModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    rawModel.position.sub(center);

    // 2. Scale model to fit the viewport
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      rawModel.scale.setScalar(2.5 / maxDim);
    }

    const containerGroup = new THREE.Group();
    containerGroup.add(rawModel);

    // 3. Add cyan wireframe edge overlays
    const wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0x66d9ff,
      transparent: true,
      opacity: 0.75,
      depthTest: true
    });

    rawModel.traverse((child) => {
      if (child.isMesh) {
        const wireframeGeo = new THREE.WireframeGeometry(child.geometry);
        const wireframeMesh = new THREE.LineSegments(wireframeGeo, wireframeMaterial);
        
        if (child.material) {
          child.material.transparent = true;
          child.material.opacity = 0.35;
        }
        
        child.add(wireframeMesh);
      }
    });

    modelGroup.add(containerGroup);

    if (typeof source !== 'string') {
      URL.revokeObjectURL(url);
    }

    if (onComplete) onComplete(containerGroup);
  });
}
