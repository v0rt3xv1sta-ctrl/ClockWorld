/*
 * vr.js — WebXR (immersive-vr) support.
 *
 * Feature-detected; desktop is unaffected if WebXR is missing. Sets up an
 * XRWebGLLayer on the existing GL context, drives the session's frame loop, and
 * per eye builds a view matrix from the headset pose offset by the player "rig"
 * (position + snap-turn yaw). Controller input (thumbstick locomotion, snap
 * turn, trigger/grip) is parsed from the gamepads. The pure helpers (input
 * parsing, quaternion forward, rig matrix) are unit-tested under Node.
 */
(function (global) {
  "use strict";

  const node = (typeof module !== "undefined" && module.exports);
  const Mat4 = node ? require("./math.js").Mat4 : global.Mat4;

  // Forward (-Z) vector of a quaternion {x,y,z,w}.
  function quatForward(q) {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    return [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))];
  }
  // Yaw such that dirFromAngles(yaw,0) points along the horizontal of `dir`.
  function yawFromDir(dir) { return Math.atan2(-dir[0], -dir[2]); }

  // inverse(rig) where rig = translate(pos) * rotateY(yaw).
  function computeRigInverse(pos, yaw) {
    return Mat4.multiply(Mat4.rotationY(-yaw), Mat4.translation(-pos[0], -pos[1], -pos[2]));
  }

  // Reduce XR input sources to a simple control intent.
  function readInput(inputSources, pose) {
    const out = { moveX: 0, moveZ: 0, turn: 0, jump: false, sprint: false, brk: false, place: false, headYaw: 0, headDir: [0, 0, -1] };
    if (pose && pose.transform && pose.transform.orientation) {
      const d = quatForward(pose.transform.orientation);
      out.headDir = d; out.headYaw = yawFromDir(d);
    }
    const list = inputSources || [];
    for (let i = 0; i < list.length; i++) {
      const src = list[i], gp = src && src.gamepad;
      if (!gp) continue;
      const ax = gp.axes || [], btn = gp.buttons || [];
      const x = ax.length >= 4 ? ax[2] : (ax[0] || 0);
      const y = ax.length >= 4 ? ax[3] : (ax[1] || 0);
      const pressed = (k) => !!(btn[k] && btn[k].pressed);
      if (src.handedness === "left") {
        out.turn += x;
        if (pressed(1)) out.sprint = true;
        if (pressed(4) || pressed(3)) out.jump = true;
      } else {
        out.moveX += x; out.moveZ += y;
        if (pressed(0)) out.brk = true;     // trigger
        if (pressed(1)) out.place = true;   // grip
        if (pressed(4) || pressed(5)) out.jump = true; // A/B
      }
    }
    return out;
  }

  function isSupported() {
    if (!global.navigator || !global.navigator.xr) return Promise.resolve(false);
    return global.navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
  }

  // opts: { gl, onReady(floor), beginFrame(), getRig()->{pos,yaw}, update(dt,input), renderEye(proj,view,camPos), onEnd() }
  function start(opts) {
    const gl = opts.gl;
    const ready = gl.makeXRCompatible ? gl.makeXRCompatible() : Promise.resolve();
    return ready
      .then(() => global.navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] }))
      .then((session) => {
        const layer = new global.XRWebGLLayer(session, gl);
        session.updateRenderState({ baseLayer: layer });
        return session.requestReferenceSpace("local-floor")
          .then((rs) => ({ session, layer, refSpace: rs, floor: true }))
          .catch(() => session.requestReferenceSpace("local").then((rs) => ({ session, layer, refSpace: rs, floor: false })));
      })
      .then(({ session, layer, refSpace, floor }) => {
        if (opts.onReady) opts.onReady(floor);
        let last = 0;
        function onFrame(t, frame) {
          session.requestAnimationFrame(onFrame);
          const dt = last ? Math.min(0.05, (t - last) / 1000) : 0; last = t;
          const pose = frame.getViewerPose(refSpace);
          if (opts.update) opts.update(dt, readInput(session.inputSources, pose));
          gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
          if (opts.beginFrame) opts.beginFrame();
          if (!pose) return;
          const rig = opts.getRig ? opts.getRig() : { pos: [0, 0, 0], yaw: 0 };
          const rigInv = computeRigInverse(rig.pos, rig.yaw);
          const cy = Math.cos(rig.yaw), sy = Math.sin(rig.yaw);
          for (let i = 0; i < pose.views.length; i++) {
            const view = pose.views[i];
            const vp = layer.getViewport(view);
            gl.viewport(vp.x, vp.y, vp.width, vp.height);
            const eyeView = Mat4.multiply(view.transform.inverse.matrix, rigInv);
            const hp = view.transform.position;
            const camPos = [rig.pos[0] + (cy * hp.x + sy * hp.z), rig.pos[1] + hp.y, rig.pos[2] + (-sy * hp.x + cy * hp.z)];
            if (opts.renderEye) opts.renderEye(view.projectionMatrix, eyeView, camPos);
          }
        }
        session.addEventListener("end", () => { if (opts.onEnd) opts.onEnd(); });
        session.requestAnimationFrame(onFrame);
        return { session, end: () => session.end() };
      });
  }

  const api = { isSupported, start, readInput, quatForward, yawFromDir, computeRigInverse };
  global.VR = api;
  if (node) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
