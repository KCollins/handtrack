import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

/**
 * Loads a GLTF/GLB model from URL or File Blob, normalizes scale/center,
 * and builds wireframe overlay meshes.
 */
export function loadModelWithWireframe(source, targetGroup, onComplete) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);

  loader.load(url, (gltf) => {
    // Clear previous model children from the gesture target group
    while (targetGroup.children.length > 0) {
      targetGroup.remove(targetGroup.children[0]);
    }

    const rawModel = gltf.scene;

    // 1. Center geometry at origin (0, 0, 0)
    const box = new THREE.Box3().setFromObject(rawModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    rawModel.position.sub(center);

    // 2. Normalize scale to fit viewer viewport
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      rawModel.scale.setScalar(2.5 / maxDim);
    }

    const containerGroup = new THREE.Group();
    containerGroup.add(rawModel);

    // 3. Traversal: Add wireframe edges to meshes
    const wireframeMaterial = new THREE.LineBasicMaterial({
      color: 0x66d9ff,
      transparent: true,
      opacity: 0.75,
      depthTest: true
    });

    rawModel.traverse((child) => {
      if (child.isMesh) {
        // Create wireframe geometry from existing mesh geometry
        const wireframeGeo = new THREE.WireframeGeometry(child.geometry);
        const wireframeMesh = new THREE.LineSegments(wireframeGeo, wireframeMaterial);
        
        // Optional: reduce solid mesh opacity to emphasize line vectors
        if (child.material) {
          child.material.transparent = true;
          child.material.opacity = 0.25;
        }
        
        child.add(wireframeMesh);
      }
    });

    targetGroup.add(containerGroup);

    if (typeof source !== 'string') {
      URL.revokeObjectURL(url);
    }

    if (onComplete) onComplete(containerGroup);
  });
}
