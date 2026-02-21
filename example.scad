/* ===========================================
   Medify MA-12 Pro
   Accurate Circular + True Perforations
   SINGLE MANIFOLD SOLID
=========================================== */

$fn = 240;

// ----------------------------
// Core Dimensions (Official)
// ----------------------------
height = 228.6;
base_d = 254;
top_scale = 0.975;
wall = 3;

// Base lip
base_lip_height = 8;
base_lip_extra = 2;

// ----------------------------
// Intake Perforation Band
// ----------------------------
band_height = 65;
band_offset = 22;
hole_d = 3.8;
hole_row_spacing = 9;
hole_angle_spacing = 9;

// ----------------------------
// Top Vent Recess
// ----------------------------
vent_d = 150;
vent_depth = 8;

// ----------------------------
// MAIN MODEL
// ----------------------------
difference(){

    // ========== OUTER BODY UNION ==========
    union(){

        // Outer tapered shell
        difference(){
            linear_extrude(height=height, scale=top_scale)
                circle(d=base_d);

            // Inner cavity
            translate([0,0,wall])
                linear_extrude(height=height - wall,
                               scale=top_scale)
                    circle(d=base_d - 2*wall);
        }

        // Base lip (fused)
        cylinder(h=base_lip_height,
                 d=base_d + base_lip_extra*2);
    }

    // ========== TOP VENT RECESS ==========
    translate([0,0,height - vent_depth])
        cylinder(h=vent_depth + 0.01,
                 d=vent_d);

    // ========== PERFORATION BAND ==========
    for (z = [band_offset : hole_row_spacing :
              band_offset + band_height]) {

        row_index = floor((z - band_offset) /
                          hole_row_spacing);

        angle_offset = (row_index % 2 == 0)
                       ? 0
                       : hole_angle_spacing/2;

        for (a = [0 : hole_angle_spacing : 360]) {

            rotate([0,0,a + angle_offset])
                translate([base_d/2 - wall/2,
                           0,
                           z])
                    rotate([0,90,0])
                        cylinder(h = wall*4,
                                 d = hole_d,
                                 center = true);
        }
    }
}
