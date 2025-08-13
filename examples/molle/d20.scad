<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>d20 with Sequential Pips → STL (Debugged)</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; height:100%; background:#0b0d10; color:#e8e8ea; font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial; }
  #app { position:fixed; inset:0; display:grid; grid-template-rows:auto 1fr; }
  header { display:flex; gap:.5rem; align-items:center; padding:.75rem 1rem; background:#12151a; border-bottom:1px solid #22262c; flex-wrap:wrap; }
  header h1 { font-size:1rem; margin:0; font-weight:600; opacity:.92; }
  header .spacer { flex:1; }
  button, input[type=range] {
    background:#1b2028; color:#e8e8ea; border:1px solid #2a3038; border-radius:10px; padding:.55rem .8rem; cursor:pointer;
  }
  button:hover { background:#222833; }
  #canvas { position:relative; }
  .hint { position:absolute; bottom:.75rem; left:.75rem; font-size:.85rem; opacity:.8; background:#0b0d10cc; padding:.35rem .5rem; border-radius:.6rem; border:1px solid #272c34; }
  .row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
  label { font-size:.9rem; opacity:.9; }
  .pill { background:#0f141b; padding:.3rem .6rem; border:1px solid #2a3038; border-radius:999px; font-size:.8rem; }
  .warn { color:#ffcf8a; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>d20 (icosahedron) with sequential pips → STL</h1>
    <span class="pill">Face i = i+1 pips</span>
    <span class="spacer"></span>
    <div class="row">
      <label for="diam">Diameter (in)</label>
      <input id="diam" type="range" min="0.5" max="2.0" step="0.05" value="1.00" />
      <span id="diamVal" class="pill">1.00 in</span>
      <label for="height">Pip height (mm)</label>
      <input id="height" type="range" min="0.2" max="1.2" step="0.05" value="0.60" />
      <span id="heightVal" class="pill">0.60 mm</span>
      <button id="regen">Regenerate</button>
      <button id="download">Download STL</button>
      <span id="status" class="pill"></span>
    </div>
  </header>
  <div id="canvas"></div>
  <div class="hint">Drag to orbit • Mousewheel to zoom • Shift+drag to pan</div>
</div>

<!-- Three.js + helpers (non-module) -->
<script src="https://unpkg.com/three@0.159.0/build/three.min.js"></script>
<script src="https://unpkg.com/three@0.159.0/examples/js/controls/OrbitControls.js"></script>
<script src="https://unpkg.com/three@0.159.0/examples/js/exporters/STLExporter.js"></script>
<script src="https://unpkg.com/three@0.159.0/examples/js/utils/BufferGeometryUtils.js"></script>

<script>
(function () {
  const statusEl = document.getElementById('status');
  function note(msg, warn=false){ statusEl.textContent = msg; statusEl.classList.toggle('warn', warn); }

  // ----- Scene setup -----
  const container = document.getElementById('canvas');
  const header = document.querySelector('header');

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  function sizeRenderer() {
    const h = window.innerHeight - header.offsetHeight;
    renderer.setSize(window.innerWidth, h, false);
    camera.aspect = window.innerWidth / h;
    camera.updateProjectionMatrix();
  }
  sizeRenderer();
  window.addEventListener('resize', sizeRenderer);

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0b0d10, 1);

  // Lighting
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0b0d10, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(2, 3, 2); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.45); rim.position.set(-3, -1, -2); scene.add(rim);

  // Ground grid (optional)
  const grid = new THREE.GridHelper(10, 10, 0x26303a, 0x1a222a);
  grid.position.y = -1.2; scene.add(grid);

  // UI elements
  const diamEl   = document.getElementById('diam');
  const diamVal  = document.getElementById('diamVal');
  const heightEl = document.getElementById('height');
  const heightVal= document.getElementById('heightVal');
  const regenBtn = document.getElementById('regen');
  const dlBtn    = document.getElementById('download');

  function updateLabels() {
    diamVal.textContent = parseFloat(diamEl.value).toFixed(2) + ' in';
    heightVal.textContent = parseFloat(heightEl.value).toFixed(2) + ' mm';
  }
  diamEl.addEventListener('input', updateLabels);
  heightEl.addEventListener('input', updateLabels);
  updateLabels();

  // ---------- Geometry builders ----------
  const inch = 25.4;
  let d20Mesh = null;

  function safeMergeGeometries(geoms) {
    // Fallback if examples script didn't attach the utils
    const utils = (THREE.BufferGeometryUtils && THREE.BufferGeometryUtils.mergeGeometries)
      ? THREE.BufferGeometryUtils
      : null;

    if (!utils) {
      note('Merging w/o BufferGeometryUtils; STL still OK', true);
      // Make a Group so exporter still collects all parts
      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x9dc1ff, metalness: 0.1, roughness: 0.6 });
      geoms.forEach(g => group.add(new THREE.Mesh(g, mat)));
      return group; // return Group instead of a single mesh
    }
    const merged = utils.mergeGeometries(geoms, false);
    merged.computeVertexNormals();
    return merged;
  }

  function buildIcosahedronWithPips(diameterInches = 1.0, pipHeightMM = 0.6) {
    const D = diameterInches * inch;
    const R = D / 2.0;

    // Base icosahedron
    const phi = (1 + Math.sqrt(5)) / 2;
    const V0 = [
      [-1,  phi, 0], [ 1,  phi, 0], [-1, -phi, 0], [ 1, -phi, 0],
      [0, -1,  phi], [0,  1,  phi], [0, -1, -phi], [0,  1, -phi],
      [ phi, 0, -1], [ phi, 0,  1], [-phi, 0, -1], [-phi, 0,  1]
    ];
    const F = [
      [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
      [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
      [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
      [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
    ];
    const unscaledRadius = Math.sqrt(1 + phi*phi);
    const S = R / unscaledRadius;
    const V = V0.map(p => new THREE.Vector3(p[0]*S, p[1]*S, p[2]*S));

    const baseGeom = new THREE.BufferGeometry();
    const pos = [];
    for (const f of F) {
      const a = V[f[0]], b = V[f[1]], c = V[f[2]];
      pos.push(a.x,a.y,a.z, b.x,b.y,b.z, c.x,c.y,c.z);
    }
    baseGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    baseGeom.computeVertexNormals();

    // Face metrics
    const edgeLen = V[F[0][0]].clone().sub(V[F[0][1]]).length();
    const faceInradius = edgeLen * Math.sqrt(3) / 6;

    // Pip sizing (equalized area)
    const pipRefFrac = 0.12, pipRefN = 10;
    const pipAreaTarget = pipRefN * Math.PI * Math.pow(faceInradius * pipRefFrac, 2);
    const pipRadiusForN = n => {
      const r = Math.sqrt(pipAreaTarget / (Math.max(1,n) * Math.PI));
      return Math.min(Math.max(r, faceInradius*0.03), faceInradius*0.18);
    };

    // Per-face frame
    const faceCenter = fi => V[F[fi][0]].clone().add(V[F[fi][1]]).add(V[F[fi][2]]).multiplyScalar(1/3);
    const faceNormal = fi => {
      const a=V[F[fi][0]], b=V[F[fi][1]], c=V[F[fi][2]];
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      return (n.dot(faceCenter(fi)) > 0) ? n : n.multiplyScalar(-1);
    };
    const faceU = fi => {
      const a=V[F[fi][0]], b=V[F[fi][1]];
      const n = faceNormal(fi);
      const e = b.clone().sub(a).normalize();
      return e.sub(n.clone().multiplyScalar(e.dot(n))).normalize();
    };
    const faceV = fi => faceNormal(fi).clone().cross(faceU(fi)).normalize();

    // Build pips
    const triFillScale = 0.92;
    const pipSegs = 24;
    const pipGeoms = [];

    function addRaisedPips(fi, count, height, sink = 0.05) {
      // Place exactly `count` pips using a barycentric lattice inside the face.
      const n = Math.max(1, count);
      const rPip = pipRadiusForN(n);

      // Face vertices
      const ia = F[fi][0], ib = F[fi][1], ic = F[fi][2];
      const A = V[ia], B = V[ib], C = V[ic];

      // Outward normal and orientation for cylinder
      const nrm = faceNormal(fi);

      // Build a list of interior lattice points at increasing resolution L
      // using integer barycentric coordinates (i,j,k) with i+j+k=L and i,j,k >= t.
      // t=1 ensures an inset from edges to keep pips fully on the face.
      const t = 1;
      const points = [];
      let L = 3; // minimal L that admits an interior point (centroid)
      for (; L <= 24; L++) {
        points.length = 0;
        for (let i=t; i<=L - 2*t; i++) {
          for (let j=t; j<=L - i - t; j++) {
            const k = L - i - j;
            if (k < t) continue;
            // Barycentric to Cartesian on the face triangle
            const p = new THREE.Vector3(0,0,0)
              .addScaledVector(A, i / L)
              .addScaledVector(B, j / L)
              .addScaledVector(C, k / L);
            // Inset slightly along normal to avoid z-fighting with face
            p.addScaledVector(nrm, -sink);
            points.push(p);
          }
        }
        if (points.length >= n) break;
      }

      // If still not enough (very small faces with huge t), fall back to centroid-only
      if (points.length === 0) {
        const c = faceCenter(fi).addScaledVector(nrm, -sink);
        points.push(c);
      }

      // Select exactly n points spread across the list for even distribution
      const chosen = [];
      if (points.length === n) {
        for (let i=0;i<n;i++) chosen.push(points[i]);
      } else {
        for (let i=0; i<n; i++) {
          const idx = Math.round(((i + 0.5) / n) * (points.length - 1));
          chosen.push(points[idx]);
        }
      }

      // Create cylinders at each chosen point along the face normal
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), nrm);
      for (const basePoint of chosen) {
        const cyl = new THREE.CylinderGeometry(rPip, rPip, height, pipSegs, 1, false);
        cyl.applyQuaternion(quat);
        cyl.translate(
          basePoint.x + nrm.x * (height/2),
          basePoint.y + nrm.y * (height/2),
          basePoint.z + nrm.z * (height/2)
        );
        pipGeoms.push(cyl);
      }
    }

    for (let i=0; i<F.length; i++) addRaisedPips(i, i+1, Math.max(0.2, pipHeightMM), 0.05);

    // Try to merge to single geometry; if utils missing, return a Group for exporter
    const mergedOrGroup = safeMergeGeometries([baseGeom, ...pipGeoms]);
    return mergedOrGroup;
  }

  function disposeObject(obj){
    if (!obj) return;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material){
      if (Array.isArray(obj.material)) obj.material.forEach(m=>m.dispose());
      else obj.material.dispose();
    }
  }

  function regen() {
    note('Building…');
    // Remove old
    if (d20Mesh) { scene.remove(d20Mesh); disposeObject(d20Mesh); d20Mesh = null; }

    const built = buildIcosahedronWithPips(parseFloat(diamEl.value), parseFloat(heightEl.value));
    if (built instanceof THREE.BufferGeometry) {
      const mat  = new THREE.MeshStandardMaterial({ color: 0x9dc1ff, metalness: 0.1, roughness: 0.6 });
      d20Mesh = new THREE.Mesh(built, mat);
    } else {
      // Group fallback (when merge utils unavailable)
      d20Mesh = built;
    }
    scene.add(d20Mesh);

    // Frame nicely
    const box = new THREE.Box3().setFromObject(d20Mesh);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const fit = Math.max(size.x,size.y,size.z);
    const dist = fit * 1.6;
    camera.position.set(dist, dist*0.9, dist*1.2);
    controls.target.copy(center);
    camera.lookAt(center);
    note('Ready');
  }

  // Export STL (binary if possible)
  function downloadSTL() {
    if (!d20Mesh) return;
    note('Exporting STL…');
    try {
      const exporter = new THREE.STLExporter();
      // Export the mesh or a wrapper object to include children (Group fallback)
      const root = new THREE.Object3D();
      root.add(d20Mesh.clone(true));
      const data = exporter.parse(root, { binary: true });
      const isArrayBuffer = (data && data.byteLength !== undefined);
      const blob = new Blob([ isArrayBuffer ? data : new TextEncoder().encode(data) ],
                            { type: isArrayBuffer ? 'application/octet-stream' : 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `d20_sequential_${parseFloat(diamEl.value).toFixed(2)}in_${parseFloat(heightEl.value).toFixed(2)}mm.stl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      note('STL downloaded');
    } catch (e) {
      console.error(e);
      note('Export failed. See console.', true);
    }
  }

  document.getElementById('regen').addEventListener('click', regen);
  document.getElementById('download').addEventListener('click', downloadSTL);

  // First build
  regen();

  // Render loop
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
})();
</script>
</body>
</html>
