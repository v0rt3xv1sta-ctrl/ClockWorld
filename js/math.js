/*
 * math.js — minimal vec3 / mat4 utilities for ClockWorld.
 *
 * Column-major 4x4 matrices stored as Float32Array(16), matching the layout
 * WebGL expects for uniformMatrix4fv(..., transpose=false). The perspective,
 * lookAt and multiply routines follow the well-known gl-matrix conventions.
 */
(function (global) {
  "use strict";

  const Vec3 = {
    add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
    sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross(a, b) {
      return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
    },
    length(a) { return Math.hypot(a[0], a[1], a[2]); },
    normalize(a) {
      const l = Math.hypot(a[0], a[1], a[2]);
      if (l === 0) return [0, 0, 0];
      return [a[0] / l, a[1] / l, a[2] / l];
    },
  };

  const Mat4 = {
    identity() {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },

    // out = a * b  (a applied second when transforming a column vector)
    multiply(a, b) {
      const out = new Float32Array(16);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      for (let i = 0; i < 4; i++) {
        const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
        out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return out;
    },

    perspective(fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      const out = new Float32Array(16);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },

    translation(x, y, z) {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      m[12] = x; m[13] = y; m[14] = z;
      return m;
    },

    rotationY(a) {
      const c = Math.cos(a), s = Math.sin(a);
      const m = new Float32Array(16);
      m[0] = c; m[2] = -s; m[5] = 1; m[8] = s; m[10] = c; m[15] = 1;
      return m;
    },

    lookAt(eye, center, up) {
      const out = new Float32Array(16);
      let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      let len = 1 / Math.hypot(z0, z1, z2);
      z0 *= len; z1 *= len; z2 *= len;

      let x0 = up[1] * z2 - up[2] * z1;
      let x1 = up[2] * z0 - up[0] * z2;
      let x2 = up[0] * z1 - up[1] * z0;
      len = Math.hypot(x0, x1, x2);
      if (!len) { x0 = x1 = x2 = 0; } else { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }

      const y0 = z1 * x2 - z2 * x1;
      const y1 = z2 * x0 - z0 * x2;
      const y2 = z0 * x1 - z1 * x0;

      out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
      out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
      out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
      out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
      out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
      out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
      out[15] = 1;
      return out;
    },
  };

  // Direction the camera faces for a given yaw/pitch. yaw=0,pitch=0 looks toward -Z.
  function dirFromAngles(yaw, pitch) {
    const cp = Math.cos(pitch);
    return [
      -Math.sin(yaw) * cp,
      Math.sin(pitch),
      -Math.cos(yaw) * cp,
    ];
  }

  const api = { Vec3, Mat4, dirFromAngles };
  global.Vec3 = Vec3;
  global.Mat4 = Mat4;
  global.dirFromAngles = dirFromAngles;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
