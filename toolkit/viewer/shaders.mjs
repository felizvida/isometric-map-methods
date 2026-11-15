// GLSL for the viewer. One lit program draws terrain (textured), buildings (colour + facade windows) and trees (season
// colours); a depth-only program fills the shadow map; an id program answers clicks; sky, stars and moon are separate.

export const LIT_VS = `#version 300 es
in vec3 a_pos; in vec3 a_nrm; in vec3 a_col; in vec4 a_fac; in float a_id;
uniform mat4 u_vp, u_svp;
out vec3 v_pos, v_nrm, v_col; out vec4 v_fac, v_spos; flat out float v_id;
void main() {
  v_pos = a_pos; v_nrm = a_nrm; v_col = a_col; v_fac = a_fac; v_id = a_id;
  v_spos = u_svp * vec4(a_pos + a_nrm * 0.15, 1.0);        // normal offset against shadow acne
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

export const LIT_FS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 v_pos, v_nrm, v_col; in vec4 v_fac, v_spos; flat in float v_id;
uniform int u_mode;                       // 0 building, 1 terrain, 2 tree
uniform sampler2D u_ground; uniform vec4 u_grect;
uniform sampler2DShadow u_shadow; uniform float u_shadowOn; uniform float u_texel;
uniform vec3 u_ldir, u_lcol, u_asky, u_agnd, u_eye, u_viewDir, u_horizon;
uniform float u_night, u_fogk, u_persp, u_exposure, u_occupancy;
uniform vec4 u_season;                    // leaf, autumn, brown, bloom
uniform float u_sp[10]; uniform vec4 u_win[10];
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float shadowAt() {
  if (u_shadowOn < 0.5) return 1.0;
  vec3 p = v_spos.xyz / v_spos.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float b = 0.00012, t = u_texel;
  float s = 2.0 * texture(u_shadow, vec3(p.xy, p.z - b));
  s += texture(u_shadow, vec3(p.xy + vec2(1.2, 0.4) * t, p.z - b));
  s += texture(u_shadow, vec3(p.xy - vec2(1.2, 0.4) * t, p.z - b));
  s += texture(u_shadow, vec3(p.xy + vec2(-0.4, 1.2) * t, p.z - b));
  s += texture(u_shadow, vec3(p.xy + vec2(0.4, -1.2) * t, p.z - b));
  return s / 6.0;
}
void main() {
  vec3 n = normalize(v_nrm), base = v_col, glow = vec3(0.0);
  bool glass = false;
  if (u_mode == 1) {
    vec2 uv = (v_pos.xy - u_grect.xy) / u_grect.zw;
    base = texture(u_ground, vec2(uv.x, 1.0 - uv.y)).rgb;
  } else if (u_mode == 0 && v_fac.w > -0.5) {
    int s = int(v_fac.w + 0.5);
    float sp = u_sp[s], st = max(2.5, v_fac.z);
    vec4 w = u_win[s];
    float fu = fract(v_fac.x / sp), fz = fract(v_fac.y / st);
    if (v_fac.y > 0.6 && fu > w.x && fu < w.y && fz > w.z && fz < w.w) {
      vec3 V = u_persp > 0.5 ? normalize(u_eye - v_pos) : u_viewDir;
      float F = pow(1.0 - abs(dot(V, n)), 2.0);
      base = mix(vec3(0.13, 0.17, 0.22), u_horizon * 0.8, 0.22 + 0.5 * F);
      glass = true;
      float room = hash(vec2(floor(v_fac.x / sp), floor(v_fac.y / st)) + v_id * 7.31);
      if (room < u_occupancy) glow = vec3(1.0, 0.78, 0.46) * (0.55 + 0.45 * hash(vec2(room, v_id))) * u_night;
    }
  } else if (u_mode == 2 && v_fac.y > 0.5) {
    float seed = v_fac.x;
    vec3 summer = mix(vec3(0.30, 0.42, 0.19), vec3(0.42, 0.52, 0.23), seed);
    if (v_fac.z < 0.5) {                  // deciduous: autumn palette, browning, bare in winter
      int k = int(floor(seed * 4.999));
      vec3 fall = k == 0 ? vec3(0.78, 0.36, 0.12) : k == 1 ? vec3(0.86, 0.62, 0.16) : k == 2 ? vec3(0.62, 0.20, 0.12) : k == 3 ? vec3(0.74, 0.50, 0.20) : vec3(0.55, 0.48, 0.18);
      float onset = smoothstep(0.15, 1.0, u_season.y * (0.45 + 0.75 * fract(seed * 7.13)));
      base = mix(summer, fall, onset);
      base = mix(base, vec3(0.50, 0.38, 0.26), u_season.z);
      if (u_season.w > 0.0 && fract(seed * 3.7) < 0.14) base = mix(base, vec3(0.96, 0.82, 0.88), u_season.w);
      float leaf = smoothstep(0.15, 0.7, u_season.x);
      if (leaf < 0.98) {
        base = mix(vec3(0.47, 0.40, 0.34), base, leaf);
        if (hash(floor(gl_FragCoord.xy)) > 0.3 + 0.7 * leaf) discard;
      }
    } else base = summer * 0.82;
  }
  float ndl = dot(n, u_ldir);
  float lit = smoothstep(-0.02, 0.2, ndl) * (0.72 + 0.28 * clamp(ndl, 0.0, 1.0));
  vec3 amb = mix(u_agnd, u_asky, n.z * 0.5 + 0.5);
  float sh = shadowAt();
  vec3 c = glass ? base * (amb * 0.7 + u_lcol * lit * sh * 0.35) + glow : base * (amb + u_lcol * lit * sh);
  if (u_persp > 0.5) c = mix(c, u_horizon, 1.0 - exp(-length(u_eye - v_pos) * u_fogk));
  o = vec4(clamp(c * u_exposure, 0.0, 1.0), 1.0);
}`;

export const DEPTH_VS = `#version 300 es
in vec3 a_pos; uniform mat4 u_svp;
void main() { gl_Position = u_svp * vec4(a_pos, 1.0); }`;
export const DEPTH_FS = `#version 300 es
precision mediump float; void main() {}`;

export const ID_VS = `#version 300 es
in vec3 a_pos; in float a_id; uniform mat4 u_vp; flat out float v_id;
void main() { v_id = a_id; gl_Position = u_vp * vec4(a_pos, 1.0); }`;
export const ID_FS = `#version 300 es
precision highp float; flat in float v_id; out vec4 o;
void main() { float id = v_id; o = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), 255.0) / 255.0; }`;

export const SKY_VS = `#version 300 es
in vec2 a_xy; out vec2 v_xy;
void main() { v_xy = a_xy; gl_Position = vec4(a_xy, 0.9999, 1.0); }`;
export const SKY_FS = `#version 300 es
precision highp float; in vec2 v_xy; uniform vec3 u_top, u_bottom; uniform mat4 u_inv; uniform float u_persp; out vec4 o;
void main() {
  float t = v_xy.y * 0.5 + 0.5;
  if (u_persp > 0.5) {
    vec4 a = u_inv * vec4(v_xy, -1.0, 1.0), b = u_inv * vec4(v_xy, 1.0, 1.0);
    vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
    t = smoothstep(-0.05, 0.6, d.z);
  }
  o = vec4(mix(u_bottom, u_top, t), 1.0);
}`;

export const STAR_VS = `#version 300 es
in vec3 a_dir; in float a_mag;
uniform mat3 u_eq2w; uniform mat4 u_rvp; uniform float u_limit, u_vis, u_scale;
out float v_a;
void main() {
  vec3 w = u_eq2w * a_dir;
  gl_Position = u_rvp * vec4(w, 1.0);
  gl_Position.z = gl_Position.w;          // at the far plane: drawn only where nothing else is
  float flux = pow(10.0, -0.4 * (a_mag - u_limit));
  gl_PointSize = clamp(1.4 + 0.9 * log(1.0 + flux), 1.4, 4.2) * u_scale;
  v_a = a_mag > u_limit ? 0.0 : u_vis * smoothstep(0.0, 0.16, w.z) * clamp(0.35 + 0.65 * flux, 0.0, 1.0);
}`;
export const STAR_FS = `#version 300 es
precision mediump float; in float v_a; out vec4 o;
void main() { float d = length(gl_PointCoord - 0.5); o = vec4(vec3(1.0, 0.98, 0.94), v_a * smoothstep(0.5, 0.15, d)); }`;

export const MOON_VS = `#version 300 es
uniform vec3 u_dir; uniform mat4 u_rvp; uniform float u_size;
void main() { gl_Position = u_rvp * vec4(u_dir, 1.0); gl_Position.z = gl_Position.w; gl_PointSize = u_size; }`;
export const MOON_FS = `#version 300 es
precision mediump float; uniform float u_illum, u_waxing, u_vis; out vec4 o;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * 2.0; p.y = -p.y;
  float r = length(p); if (r > 1.0) discard;
  float x = u_waxing > 0.5 ? p.x : -p.x;
  float lit = step((1.0 - 2.0 * u_illum) * sqrt(max(0.0, 1.0 - p.y * p.y)), x);
  vec3 c = mix(vec3(0.08, 0.09, 0.12), vec3(0.95, 0.93, 0.86), lit);
  o = vec4(c, u_vis * smoothstep(1.0, 0.92, r));
}`;
