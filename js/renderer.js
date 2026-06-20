/*
 * renderer.js — WebGL voxel renderer (no libraries).
 *
 * One textured/lit/fogged shader draws chunk meshes in two passes: an opaque
 * pass with alpha-testing (for leaves/glass cutouts) and a blended pass for
 * water. A tiny second program draws the wireframe highlight on the targeted
 * block. Chunk geometry lives in per-chunk VBO/IBO pairs.
 */
(function (global) {
  "use strict";

  const CHUNK_VS = `
    attribute vec3 aPos;
    attribute vec2 aUV;
    attribute float aLight;
    uniform mat4 uProj;
    uniform mat4 uView;
    uniform vec3 uCamPos;
    varying vec2 vUV;
    varying float vLight;
    varying float vDist;
    void main() {
      gl_Position = uProj * uView * vec4(aPos, 1.0);
      vUV = aUV;
      vLight = aLight;
      vDist = distance(aPos, uCamPos);
    }`;

  const CHUNK_FS = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform float uDayLight;
    uniform vec3 uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform float uAlphaTest;
    varying vec2 vUV;
    varying float vLight;
    varying float vDist;
    void main() {
      vec4 tex = texture2D(uTex, vUV);
      if (tex.a < uAlphaTest) discard;
      vec3 col = tex.rgb * vLight * uDayLight;
      float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
      col = mix(col, uFogColor, fog);
      gl_FragColor = vec4(col, tex.a);
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
      uProj: gl.getUniformLocation(this.prog, "uProj"),
      uView: gl.getUniformLocation(this.prog, "uView"),
      uCamPos: gl.getUniformLocation(this.prog, "uCamPos"),
      uTex: gl.getUniformLocation(this.prog, "uTex"),
      uDayLight: gl.getUniformLocation(this.prog, "uDayLight"),
      uFogColor: gl.getUniformLocation(this.prog, "uFogColor"),
      uFogNear: gl.getUniformLocation(this.prog, "uFogNear"),
      uFogFar: gl.getUniformLocation(this.prog, "uFogFar"),
      uAlphaTest: gl.getUniformLocation(this.prog, "uAlphaTest"),
    };

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
    const stride = 6 * 4;
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(loc.aUV);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(loc.aLight);
    gl.vertexAttribPointer(loc.aLight, 1, gl.FLOAT, false, stride, 20);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ibo);
  };

  // scene: { proj, view, camPos, dayLight, fogColor:[r,g,b], fogNear, fogFar, highlight:[x,y,z]|null }
  Renderer.prototype.render = function (scene) {
    const gl = this.gl;
    gl.clearColor(scene.fogColor[0], scene.fogColor[1], scene.fogColor[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc.uTex, 0);
    gl.uniformMatrix4fv(this.loc.uProj, false, scene.proj);
    gl.uniformMatrix4fv(this.loc.uView, false, scene.view);
    gl.uniform3fv(this.loc.uCamPos, scene.camPos);
    gl.uniform1f(this.loc.uDayLight, scene.dayLight);
    gl.uniform3fv(this.loc.uFogColor, scene.fogColor);
    gl.uniform1f(this.loc.uFogNear, scene.fogNear);
    gl.uniform1f(this.loc.uFogFar, scene.fogFar);

    const indexType = gl.UNSIGNED_INT;

    // Opaque pass (with alpha-test cutout), depth write on, no blend.
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1f(this.loc.uAlphaTest, 0.5);
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

  global.Renderer = Renderer;
})(typeof window !== "undefined" ? window : globalThis);
