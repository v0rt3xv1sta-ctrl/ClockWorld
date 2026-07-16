/*
 * renderer.js — WebGL voxel renderer (no libraries).
 *
 * A procedural sky pass (sun, moon, stars, drifting clouds, dawn/dusk) fills
 * the background, then one textured/lit/fogged shader draws chunk meshes in
 * two passes: an opaque pass with alpha-testing (for leaves/glass cutouts)
 * and a blended water pass with animated waves, fresnel reflection toward the
 * horizon and a sun glint. A tiny extra program draws the wireframe highlight
 * on the targeted block. Chunk geometry lives in per-chunk VBO/IBO pairs.
 */
(function (global) {
  "use strict";

  const CHUNK_VS = `
    attribute vec3 aPos;
    attribute vec2 aUV;
    attribute float aLight;
    attribute float aExtra; // 1 on liquid surface vertices (wave-animated)
    uniform mat4 uProj;
    uniform mat4 uView;
    uniform vec3 uCamPos;
    uniform float uTime;
    uniform float uWater;
    varying vec2 vUV;
    varying float vLight;
    varying float vDist;
    varying vec3 vWorld;
    void main() {
      vec3 pos = aPos;
      if (uWater > 0.5 && aExtra > 0.5) {
        pos.y += sin(pos.x * 0.9 + uTime * 2.1) * 0.05
               + cos(pos.z * 0.75 + uTime * 1.6) * 0.05 - 0.055;
      }
      gl_Position = uProj * uView * vec4(pos, 1.0);
      vUV = aUV;
      vLight = aLight;
      vWorld = pos;
      vDist = distance(pos, uCamPos);
    }`;

  const CHUNK_FS = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform sampler2D uTex;
    uniform vec3 uLightColor; // sunlight tint x day/night level
    uniform vec3 uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform float uAlphaTest;
    uniform float uWater;
    uniform float uTime;
    uniform vec3 uCamPos;
    uniform vec3 uSunDir;
    uniform float uGlint; // sun-glint strength (0 at night)
    varying vec2 vUV;
    varying float vLight;
    varying float vDist;
    varying vec3 vWorld;
    void main() {
      vec4 tex = texture2D(uTex, vUV);
      if (tex.a < uAlphaTest) discard;
      vec3 col = tex.rgb * vLight * uLightColor;
      float alpha = tex.a;
      if (uWater > 0.5) {
        // normal from the same waves the vertex shader displaces with
        vec3 N = normalize(vec3(
          -cos(vWorld.x * 0.9 + uTime * 2.1) * 0.16,
          1.0,
          sin(vWorld.z * 0.75 + uTime * 1.6) * 0.14));
        vec3 V = normalize(uCamPos - vWorld);
        float fres = 0.06 + 0.94 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col = mix(col, uFogColor, fres * 0.55); // sky reflection at grazing angles
        vec3 H = normalize(uSunDir + V);
        col += vec3(1.0, 0.93, 0.75) * pow(max(dot(N, H), 0.0), 140.0) * uGlint * 2.0;
        alpha = clamp(0.52 + fres * 0.36, 0.0, 0.88);
      }
      float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
      col = mix(col, uFogColor, fog);
      gl_FragColor = vec4(col, alpha);
    }`;

  const SKY_VS = `
    attribute vec2 aPos;
    uniform mat4 uInvVP;
    uniform vec3 uCamPos;
    varying vec3 vDir;
    void main() {
      vec4 w = uInvVP * vec4(aPos, 1.0, 1.0);
      vDir = w.xyz / w.w - uCamPos;
      gl_Position = vec4(aPos, 0.99999, 1.0);
    }`;

  const SKY_FS = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec3 uSunDir;
    uniform float uTime;
    varying vec3 vDir;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float hash31(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }
    vec3 hash33(vec3 p) {
      p = fract(p * vec3(0.1031, 0.1030, 0.0973));
      p += dot(p, p.yxz + 33.33);
      return fract((p.xxy + p.yxx) * p.zyx);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) {
        s += a * vnoise(p);
        p = p * 2.03 + vec2(17.3, 9.1);
        a *= 0.5;
      }
      return s;
    }

    void main() {
      vec3 rd = normalize(vDir);
      vec3 sd = uSunDir;
      float sunH = sd.y;
      float day = smoothstep(-0.12, 0.22, sunH);
      float horiz = pow(1.0 - clamp(rd.y, 0.0, 1.0), 3.0);

      vec3 zen = mix(vec3(0.012, 0.02, 0.06), vec3(0.16, 0.4, 0.82), day);
      vec3 hor = mix(vec3(0.03, 0.05, 0.1), vec3(0.62, 0.78, 0.95), day);
      vec3 col = mix(zen, hor, horiz);

      // dawn/dusk band toward the sun's azimuth
      float dusk = smoothstep(-0.32, -0.02, sunH) * smoothstep(0.34, 0.05, sunH);
      vec2 rdH = normalize(rd.xz + vec2(1e-4));
      vec2 sdH = normalize(sd.xz + vec2(1e-4));
      float toward = dot(rdH, sdH) * 0.5 + 0.5;
      col += vec3(0.95, 0.34, 0.12) * dusk * horiz * (0.3 + 1.6 * toward * toward);

      // sun: mie glow + disc that dims and reddens near the horizon
      float cosSun = clamp(dot(rd, sd), 0.0, 1.0);
      vec3 sunTint = mix(vec3(1.0, 0.45, 0.18), vec3(1.0, 0.98, 0.9), smoothstep(-0.02, 0.4, sunH));
      col += sunTint * (pow(cosSun, 8.0) * 0.2 + pow(cosSun, 64.0) * 0.4) * max(day, dusk);
      float disc = smoothstep(0.9991, 0.9995, cosSun) * smoothstep(-0.07, 0.0, sunH);
      col += sunTint * disc * mix(1.2, 3.0, day);

      float night = 1.0 - day;
      // moon opposite the sun
      float cosMoon = clamp(dot(rd, -sd), 0.0, 1.0);
      float moonVis = smoothstep(0.5, 0.9, night);
      col += vec3(0.8, 0.85, 0.95) * smoothstep(0.99955, 0.99985, cosMoon) * moonVis;
      col += vec3(0.35, 0.4, 0.55) * pow(cosMoon, 24.0) * 0.08 * moonVis;

      // stars
      if (rd.y > -0.05) {
        float starNight = smoothstep(0.35, 0.8, night);
        if (starNight > 0.001) {
          vec3 cell = floor(rd * 80.0);
          vec3 f = fract(rd * 80.0);
          vec3 sp = hash33(cell) * 0.7 + 0.15;
          float d = length(f - sp);
          float mag = step(0.8, hash31(cell + 7.31));
          float tw = 0.6 + 0.4 * sin(uTime * 2.0 + hash31(cell) * 40.0);
          col += vec3(0.9, 0.93, 1.0) * smoothstep(0.16, 0.02, d) * mag * tw * starNight;
        }
      }

      // drifting cloud layer
      if (rd.y > 0.02) {
        vec2 cp = rd.xz / (rd.y + 0.22);
        cp = cp * 1.1 + vec2(uTime * 0.008, uTime * 0.003);
        float cl = fbm(cp * 0.6 + fbm(cp * 0.4) * 0.8);
        float cover = smoothstep(0.58, 0.85, cl);
        float fade = smoothstep(0.02, 0.14, rd.y);
        vec3 lit = mix(vec3(0.04, 0.045, 0.08), vec3(1.0, 0.99, 0.96), day);
        lit = mix(lit, vec3(1.05, 0.55, 0.32), dusk * 0.8);
        vec3 shade = lit * mix(0.45, 0.66, cl);
        col = mix(col, mix(shade, lit, smoothstep(0.55, 1.0, cl)), cover * fade * 0.8);
      }

      gl_FragColor = vec4(col, 1.0);
    }`;

  const LINE_VS = `
    attribute vec3 aPos;
    uniform mat4 uProj;
    uniform mat4 uView;
    void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

  const LINE_FS = `
    precision mediump float;
    uniform vec4 uColor;
    void main() { gl_FragColor = uColor; }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile error: " + gl.getShaderInfoLog(s));
    }
    return s;
  }
  function link(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("Program link error: " + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function Renderer(canvas) {
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL is not available in this browser.");
    this.gl = gl;
    this.canvas = canvas;
    this.isGL2 = (typeof WebGL2RenderingContext !== "undefined") && gl instanceof WebGL2RenderingContext;
    if (!this.isGL2) {
      // WebGL1 needs an extension for 32-bit indices used by large chunk meshes.
      this.uintExt = gl.getExtension("OES_element_index_uint");
    }

    this.prog = link(gl, CHUNK_VS, CHUNK_FS);
    this.loc = {
      aPos: gl.getAttribLocation(this.prog, "aPos"),
      aUV: gl.getAttribLocation(this.prog, "aUV"),
      aLight: gl.getAttribLocation(this.prog, "aLight"),
      aExtra: gl.getAttribLocation(this.prog, "aExtra"),
      uProj: gl.getUniformLocation(this.prog, "uProj"),
      uView: gl.getUniformLocation(this.prog, "uView"),
      uCamPos: gl.getUniformLocation(this.prog, "uCamPos"),
      uTex: gl.getUniformLocation(this.prog, "uTex"),
      uLightColor: gl.getUniformLocation(this.prog, "uLightColor"),
      uFogColor: gl.getUniformLocation(this.prog, "uFogColor"),
      uFogNear: gl.getUniformLocation(this.prog, "uFogNear"),
      uFogFar: gl.getUniformLocation(this.prog, "uFogFar"),
      uAlphaTest: gl.getUniformLocation(this.prog, "uAlphaTest"),
      uWater: gl.getUniformLocation(this.prog, "uWater"),
      uTime: gl.getUniformLocation(this.prog, "uTime"),
      uSunDir: gl.getUniformLocation(this.prog, "uSunDir"),
      uGlint: gl.getUniformLocation(this.prog, "uGlint"),
    };

    this.skyProg = link(gl, SKY_VS, SKY_FS);
    this.skyLoc = {
      aPos: gl.getAttribLocation(this.skyProg, "aPos"),
      uInvVP: gl.getUniformLocation(this.skyProg, "uInvVP"),
      uCamPos: gl.getUniformLocation(this.skyProg, "uCamPos"),
      uSunDir: gl.getUniformLocation(this.skyProg, "uSunDir"),
      uTime: gl.getUniformLocation(this.skyProg, "uTime"),
    };
    this.skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.lineLoc = {
      aPos: gl.getAttribLocation(this.lineProg, "aPos"),
      uProj: gl.getUniformLocation(this.lineProg, "uProj"),
      uView: gl.getUniformLocation(this.lineProg, "uView"),
      uColor: gl.getUniformLocation(this.lineProg, "uColor"),
    };
    this.lineBuf = gl.createBuffer();

    this.meshes = new Map(); // chunkKey -> { opaque:{vbo,ibo,count}, water:{...} }
    this.tex = null;

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.5, 0.72, 0.98, 1.0);
  }

  Renderer.prototype.setAtlas = function (canvas) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
  };

  function uploadPart(gl, part, geoPart) {
    if (geoPart.indices.length === 0) {
      if (part) { gl.deleteBuffer(part.vbo); gl.deleteBuffer(part.ibo); }
      return null;
    }
    if (!part) part = { vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: 0 };
    gl.bindBuffer(gl.ARRAY_BUFFER, part.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geoPart.data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geoPart.indices, gl.STATIC_DRAW);
    part.count = geoPart.indices.length;
    return part;
  }

  Renderer.prototype.uploadChunk = function (key, geo) {
    const gl = this.gl;
    let m = this.meshes.get(key) || { opaque: null, water: null };
    m.opaque = uploadPart(gl, m.opaque, geo.opaque);
    m.water = uploadPart(gl, m.water, geo.water);
    this.meshes.set(key, m);
  };

  Renderer.prototype.removeChunk = function (key) {
    const gl = this.gl;
    const m = this.meshes.get(key);
    if (!m) return;
    if (m.opaque) { gl.deleteBuffer(m.opaque.vbo); gl.deleteBuffer(m.opaque.ibo); }
    if (m.water) { gl.deleteBuffer(m.water.vbo); gl.deleteBuffer(m.water.ibo); }
    this.meshes.delete(key);
  };

  // Clear the screen to a flat colour (used by the menu before a world loads).
  Renderer.prototype.clear = function (rgb) {
    const gl = this.gl;
    this.resize();
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  };

  Renderer.prototype.resize = function () {
    const c = this.canvas;
    const w = Math.floor(c.clientWidth * (window.devicePixelRatio || 1));
    const h = Math.floor(c.clientHeight * (window.devicePixelRatio || 1));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.gl.viewport(0, 0, c.width, c.height);
    return c.width / Math.max(1, c.height);
  };

  Renderer.prototype.bindChunkAttribs = function (part) {
    const gl = this.gl, loc = this.loc;
    gl.bindBuffer(gl.ARRAY_BUFFER, part.vbo);
    const stride = 7 * 4; // x,y,z,u,v,light,extra
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(loc.aUV);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(loc.aLight);
    gl.vertexAttribPointer(loc.aLight, 1, gl.FLOAT, false, stride, 20);
    if (loc.aExtra >= 0) {
      gl.enableVertexAttribArray(loc.aExtra);
      gl.vertexAttribPointer(loc.aExtra, 1, gl.FLOAT, false, stride, 24);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ibo);
  };

  // Fullscreen procedural sky: sun, moon, stars, clouds, dawn/dusk. Drawn
  // first with depth writes off; the world draws over it.
  Renderer.prototype.drawSky = function (scene) {
    const gl = this.gl;
    const Mat4 = (typeof window !== "undefined" ? window.Mat4 : null) || (typeof globalThis !== "undefined" ? globalThis.Mat4 : null);
    if (!scene.sunDir || !Mat4 || !Mat4.invert) return;
    const invVP = Mat4.invert(Mat4.multiply(scene.proj, scene.view));
    if (!invVP) return;
    gl.useProgram(this.skyProg);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(this.skyLoc.uInvVP, false, invVP);
    gl.uniform3fv(this.skyLoc.uCamPos, scene.camPos);
    gl.uniform3fv(this.skyLoc.uSunDir, scene.sunDir);
    gl.uniform1f(this.skyLoc.uTime, scene.time || 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.enableVertexAttribArray(this.skyLoc.aPos);
    gl.vertexAttribPointer(this.skyLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  };

  // Clear the currently-bound framebuffer to a flat colour (no resize/rebind).
  Renderer.prototype.clearView = function (rgb) {
    const gl = this.gl;
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  };

  // Desktop: clear the default framebuffer then draw the world.
  // scene: { proj, view, camPos, dayLight, fogColor:[r,g,b], fogNear, fogFar, highlight:[x,y,z]|null }
  Renderer.prototype.render = function (scene) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.clearView(scene.fogColor);
    this.drawWorld(scene);
  };

  // Draw the world with the given camera into the current framebuffer/viewport
  // (no clear) — used per-eye in VR and by render() on desktop.
  Renderer.prototype.drawWorld = function (scene) {
    const gl = this.gl;
    if (!scene.underwater) this.drawSky(scene);

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc.uTex, 0);
    gl.uniformMatrix4fv(this.loc.uProj, false, scene.proj);
    gl.uniformMatrix4fv(this.loc.uView, false, scene.view);
    gl.uniform3fv(this.loc.uCamPos, scene.camPos);
    const lc = scene.lightColor || [scene.dayLight, scene.dayLight, scene.dayLight];
    gl.uniform3fv(this.loc.uLightColor, lc);
    gl.uniform3fv(this.loc.uFogColor, scene.fogColor);
    gl.uniform1f(this.loc.uFogNear, scene.fogNear);
    gl.uniform1f(this.loc.uFogFar, scene.fogFar);
    gl.uniform1f(this.loc.uTime, scene.time || 0);
    gl.uniform3fv(this.loc.uSunDir, scene.sunDir || [0, 1, 0]);
    gl.uniform1f(this.loc.uGlint, scene.glint || 0);

    const indexType = gl.UNSIGNED_INT;

    // Opaque pass (with alpha-test cutout), depth write on, no blend.
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1f(this.loc.uAlphaTest, 0.5);
    gl.uniform1f(this.loc.uWater, 0);
    let drawn = 0;
    this.meshes.forEach((m) => {
      if (m.opaque && m.opaque.count) {
        this.bindChunkAttribs(m.opaque);
        gl.drawElements(gl.TRIANGLES, m.opaque.count, indexType, 0);
        drawn += m.opaque.count;
      }
    });

    // Water pass: blended, no depth write so it doesn't occlude itself badly.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(this.loc.uAlphaTest, 0.0);
    gl.uniform1f(this.loc.uWater, 1);
    this.meshes.forEach((m) => {
      if (m.water && m.water.count) {
        this.bindChunkAttribs(m.water);
        gl.drawElements(gl.TRIANGLES, m.water.count, indexType, 0);
        drawn += m.water.count;
      }
    });
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    if (scene.highlight) this.drawHighlight(scene);
    return drawn;
  };

  Renderer.prototype.drawHighlight = function (scene) {
    const gl = this.gl;
    const [x, y, z] = scene.highlight;
    const e = 0.002, a = -e, b = 1 + e; // slightly enlarged cube
    const c = [
      [a, a, a], [b, a, a], [b, a, b], [a, a, b], // bottom
      [a, b, a], [b, b, a], [b, b, b], [a, b, b], // top
    ].map((p) => [p[0] + x, p[1] + y, p[2] + z]);
    const E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const verts = new Float32Array(E.length * 3);
    for (let i = 0; i < E.length; i++) {
      verts[i * 3] = c[E[i]][0]; verts[i * 3 + 1] = c[E[i]][1]; verts[i * 3 + 2] = c[E[i]][2];
    }
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineLoc.uProj, false, scene.proj);
    gl.uniformMatrix4fv(this.lineLoc.uView, false, scene.view);
    gl.uniform4f(this.lineLoc.uColor, 0, 0, 0, 0.5);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.lineLoc.aPos);
    gl.vertexAttribPointer(this.lineLoc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, E.length);
  };

  // Draw a flat-coloured solid box (reuses the line program with triangles).
  Renderer.prototype.drawSolidBox = function (min, max, color, scene) {
    const gl = this.gl;
    const c = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], min[1], max[2]], [min[0], min[1], max[2]],
      [min[0], max[1], min[2]], [max[0], max[1], min[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
    ];
    const tris = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5,
      3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2];
    const verts = new Float32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
      verts[i * 3] = c[tris[i]][0]; verts[i * 3 + 1] = c[tris[i]][1]; verts[i * 3 + 2] = c[tris[i]][2];
    }
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineLoc.uProj, false, scene.proj);
    gl.uniformMatrix4fv(this.lineLoc.uView, false, scene.view);
    gl.uniform4f(this.lineLoc.uColor, color[0], color[1], color[2], 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.lineLoc.aPos);
    gl.vertexAttribPointer(this.lineLoc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length);
  };

  // Render other players as simple two-tone avatars (body + head).
  Renderer.prototype.drawAvatars = function (list, scene) {
    for (const a of list) {
      const p = a.pos, col = a.color || [0.9, 0.3, 0.3];
      this.drawSolidBox([p[0] - 0.3, p[1], p[2] - 0.3], [p[0] + 0.3, p[1] + 1.4, p[2] + 0.3], col, scene);
      const head = [col[0] * 0.7 + 0.2, col[1] * 0.7 + 0.2, col[2] * 0.7 + 0.2];
      this.drawSolidBox([p[0] - 0.22, p[1] + 1.4, p[2] - 0.22], [p[0] + 0.22, p[1] + 1.84, p[2] + 0.22], head, scene);
    }
  };

  global.Renderer = Renderer;
})(typeof window !== "undefined" ? window : globalThis);
