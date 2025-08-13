// d20 (icosahedron) with sequential raised pips (OpenSCAD)
// Face i has i+1 pips. Parameters:
// - diameter_in: overall diameter (inches)
// - pip_height_mm: pip cylinder height (mm)
// - pip_segments: cylinder roundness

// ---------- Parameters ----------
diameter_in   = 1.00;   // inches
pip_height_mm = 0.60;   // mm
pip_segments  = 24;

// ---------- Helpers ----------
inch = 25.4;
PI = 3.14159265358979323846;

function dot(a,b) = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
function vadd(a,b) = [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
function vsub(a,b) = [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
function vscale(a,s) = [a[0]*s, a[1]*s, a[2]*s];
function vlen(a) = norm(a);
function vunit(a) = let(n=vlen(a)) (n>0 ? vscale(a, 1/n) : [0,0,0]);
function clamp(x,a,b) = max(a, min(b, x));

// Rotation that aligns +Z to vector n
function rot_axis(n) = let(z=[0,0,1], ax=cross(z, n)) (vlen(ax) < 1e-9 ? [1,0,0] : ax);
function rot_angle_deg(n) = let(z=[0,0,1], c=clamp(dot(z, vunit(n)), -1, 1)) acos(c);

// Icosahedron base (unscaled)
phi = (1 + sqrt(5))/2;
V0 = [
  [-1,  phi, 0], [ 1,  phi, 0], [-1, -phi, 0], [ 1, -phi, 0],
  [0, -1,  phi], [0,  1,  phi], [0, -1, -phi], [0,  1, -phi],
  [ phi, 0, -1], [ phi, 0,  1], [-phi, 0, -1], [-phi, 0,  1]
];
F = [
  [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
  [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
  [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
  [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
];

unscaled_R = sqrt(1 + phi*phi);
R = (diameter_in*inch)/2;
S = R / unscaled_R;
V = [ for (p=V0) [p[0]*S, p[1]*S, p[2]*S] ];

// Triangle/face helpers
function face_center(fi) = vscale(vadd(vadd(V[F[fi][0]], V[F[fi][1]]), V[F[fi][2]]), 1/3);
function face_normal_raw(fi) = cross(vsub(V[F[fi][1]], V[F[fi][0]]), vsub(V[F[fi][2]], V[F[fi][0]]));
function face_normal(fi) = let(n=vunit(face_normal_raw(fi)), c=face_center(fi)) (dot(n,c) > 0 ? n : vscale(n,-1));

// Edge length and face inradius (same for all faces on an icosahedron)
edge_len = vlen(vsub(V[F[0][0]], V[F[0][1]]));
face_inradius = edge_len*sqrt(3)/6;

// Pip sizing to equalize total area per face
pipRefFrac = 0.12;
pipRefN = 10;
pipAreaTarget = pipRefN * PI * pow(face_inradius * pipRefFrac, 2);
function pip_radius_for_n(n) = clamp(sqrt(pipAreaTarget / (max(1,n)*PI)), face_inradius*0.03, face_inradius*0.18);

// Compute minimal lattice L for at least n interior points with i,j,k>=1 and i+j+k=L
// Count(L) = (L-1)*(L-2)/2 for L>=3
function lattice_L_for_n(n) = max(3, ceil((3 + sqrt(1 + 8*n))/2));

// Generate interior lattice points for a face fi at resolution L (barycentric integer lattice, inset by sink)
function face_points(fi, L, sink) =
  let(ia=F[fi][0], ib=F[fi][1], ic=F[fi][2], A=V[ia], B=V[ib], C=V[ic], n=face_normal(fi))
  [ for (i=[1:L-2]) for (j=[1:L-i-1])
      let(k=L-i-j)
      [
        (A[0]*i + B[0]*j + C[0]*k)/L - n[0]*sink,
        (A[1]*i + B[1]*j + C[1]*k)/L - n[1]*sink,
        (A[2]*i + B[2]*j + C[2]*k)/L - n[2]*sink
      ]
  ];

// Choose exactly n points spread across the list
function choose_n_points(pts, n) =
  (len(pts) <= 0) ? [ face_center(0) ] :
  (len(pts) == n) ? pts :
  [ for (i=[0:n-1]) 
      let(idx = round(((i+0.5)/n) * (len(pts)-1))) pts[idx]
  ];

// Place cylinders for pips on face fi
module raised_pips(fi, count, height, sink=0.05) {
  n = max(1, count);
  r = pip_radius_for_n(n);
  L = lattice_L_for_n(n);
  pts = face_points(fi, L, sink);
  pts_sel = len(pts) == 0 ? [face_center(fi)] : choose_n_points(pts, n);
  nrm = face_normal(fi);
  axis = rot_axis(nrm);
  ang = rot_angle_deg(nrm);
  for (P = pts_sel) {
    translate([ P[0] + nrm[0]*(height/2), P[1] + nrm[1]*(height/2), P[2] + nrm[2]*(height/2) ])
      rotate(a=ang, v=axis)
        cylinder(h=height, r=r, $fn=pip_segments, center=true);
  }
}

// Main model
module d20_with_pips(diam_in=diameter_in, pip_h=pip_height_mm) {
  union() {
    // Base icosahedron
    polyhedron(points=V, faces=F);
    // Pips: face i has i+1 pips
    for (fi=[0:len(F)-1])
      raised_pips(fi, fi+1, max(0.2, pip_h), 0.05);
  }
}

// Render
d20_with_pips();
