import { loadModelWithWireframe } from './wireframe-loader.js';
import './main.js'; // Initializes webcam, gesture processing, and main animation loop

const presetSelect = document.getElementById('preset-select');
const fileInput = document.getElementById('glb-input');

// Handle preset dropdown menu changes
if (presetSelect) {
  presetSelect.addEventListener('change', (e) => {
    if (e.target.value) {
      loadModelWithWireframe(e.target.value);
    }
  });
}

// Handle custom .glb / .gltf file uploads
if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      loadModelWithWireframe(file);
    }
  });
}

// Load default initial preset on launch
if (presetSelect && presetSelect.value) {
  loadModelWithWireframe(presetSelect.value);
}
