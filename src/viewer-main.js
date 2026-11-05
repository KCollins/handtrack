import { loadModelWithWireframe } from './wireframe-loader.js';
// Re-use hand tracking modules without modifying them
import { initScene, pivotGroup } from './scene.js'; 
import { initHands } from './hands.js';
import { initControls } from './control.js';

// Initialize Three.js scene & webcam controls
initScene();
initHands();
initControls();

const presetSelect = document.getElementById('preset-select');
const fileInput = document.getElementById('glb-input');

// Handle preset dropdown selection
presetSelect.addEventListener('change', (e) => {
  if (e.target.value) {
    loadModelWithWireframe(e.target.value, pivotGroup);
  }
});

// Handle custom .glb file upload
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    loadModelWithWireframe(file, pivotGroup);
  }
});

// Load default initial preset on startup
loadModelWithWireframe(presetSelect.value, pivotGroup);
