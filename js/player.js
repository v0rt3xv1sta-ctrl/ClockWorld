/*
 * player.js — first-person controller: look, movement, gravity/jumping,
 * swept AABB-vs-voxel collision, swimming and a creative fly mode.
 *
 * Position is the centre of the feet; the body AABB is HALF*2 wide and HEIGHT
 * tall, with the eye EYE units up. Collision resolves one axis at a time, and
 * per-frame dt is clamped by the caller so steps never exceed a block.
 */
(function (global) {
  "use strict";

  const Blocks = global.Blocks;
  const HALF = 0.3, HEIGHT = 1.8, EYE = 1.62;
  const GRAVITY = 28, JUMP_VEL = 8.4, TERMINAL = 55;
  const WALK = 4.4, SPRINT = 6.2, SNEAK = 1.7, FLY = 11, SWIM = 4.0;
  const SENS = 0.0023, PITCH_LIMIT = Math.PI / 2 - 0.01;

  function Player(spawn) {
    this.pos = spawn.slice();
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.inWater = false;
  }

  Player.prototype.applyMouse = function (dx, dy) {
    this.yaw -= dx * SENS;
    this.pitch -= dy * SENS;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    // keep yaw bounded for numeric stability
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
  };

  Player.prototype.getDir = function () { return global.dirFromAngles(this.yaw, this.pitch); };
  Player.prototype.getEye = function () { return [this.pos[0], this.pos[1] + EYE, this.pos[2]]; };

  Player.prototype.toggleFly = function () {
    this.flying = !this.flying;
    this.vel[1] = 0;
  };

  // Would the body AABB overlap block cell (bx,by,bz)? Used to block placement.
  Player.prototype.intersectsBlock = function (bx, by, bz) {
    const p = this.pos;
    return (bx + 1 > p[0] - HALF && bx < p[0] + HALF &&
      by + 1 > p[1] && by < p[1] + HEIGHT &&
      bz + 1 > p[2] - HALF && bz < p[2] + HALF);
  };

  Player.prototype.bodyInLiquid = function (world) {
    const p = this.pos;
    return Blocks.isLiquid(world.getBlock(Math.floor(p[0]), Math.floor(p[1] + 0.9), Math.floor(p[2])));
  };

  // Move one axis by delta and resolve against solid voxels.
  Player.prototype.collideAxis = function (world, axis, delta) {
    this.pos[axis] += delta;
    const p = this.pos;
    const lo = [p[0] - HALF, p[1], p[2] - HALF];
    const hi = [p[0] + HALF, p[1] + HEIGHT, p[2] + HALF];
    const x0 = Math.floor(lo[0]), x1 = Math.floor(hi[0]);
    const y0 = Math.floor(lo[1]), y1 = Math.floor(hi[1]);
    const z0 = Math.floor(lo[2]), z1 = Math.floor(hi[2]);
    const eps = 0.001;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (!Blocks.isSolid(world.getBlock(x, y, z))) continue;
          if (delta > 0) {
            if (axis === 1) this.pos[1] = y - HEIGHT - eps;
            else this.pos[axis] = (axis === 0 ? x : z) - HALF - eps;
          } else if (delta < 0) {
            if (axis === 1) { this.pos[1] = y + 1 + eps; this.onGround = true; }
            else this.pos[axis] = (axis === 0 ? x : z) + 1 + HALF + eps;
          }
          this.vel[axis] = 0;
          return true;
        }
      }
    }
    return false;
  };

  // cmd: { f, b, l, r, jump, descend, sprint, sneak }
  Player.prototype.update = function (dt, world, cmd) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const fwd = [-sy, 0, -cy];        // horizontal forward
    const right = [cy, 0, -sy];        // horizontal right
    const mz = (cmd.f ? 1 : 0) - (cmd.b ? 1 : 0);
    const mx = (cmd.r ? 1 : 0) - (cmd.l ? 1 : 0);
    let wx = fwd[0] * mz + right[0] * mx;
    let wz = fwd[2] * mz + right[2] * mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    this.inWater = this.bodyInLiquid(world);
    this.onGround = false;

    if (this.flying) {
      const speed = cmd.sprint ? FLY * 1.8 : FLY;
      this.vel[0] = wx * speed;
      this.vel[2] = wz * speed;
      this.vel[1] = ((cmd.jump ? 1 : 0) - (cmd.descend ? 1 : 0)) * speed;
    } else {
      let speed = cmd.sneak ? SNEAK : cmd.sprint ? SPRINT : WALK;
      if (this.inWater) speed = Math.min(speed, SWIM);
      this.vel[0] = wx * speed;
      this.vel[2] = wz * speed;

      if (this.inWater) {
        this.vel[1] -= GRAVITY * 0.28 * dt;          // buoyant, slow sink
        if (this.vel[1] < -6) this.vel[1] = -6;
        if (cmd.jump) this.vel[1] = SWIM;            // swim up
        this.vel[1] *= 0.92;                          // drag
      } else {
        this.vel[1] -= GRAVITY * dt;
        if (this.vel[1] < -TERMINAL) this.vel[1] = -TERMINAL;
        if (cmd.jump && this.onGroundPrev) this.vel[1] = JUMP_VEL;
      }
    }

    this.collideAxis(world, 0, this.vel[0] * dt);
    this.collideAxis(world, 2, this.vel[2] * dt);
    this.collideAxis(world, 1, this.vel[1] * dt);
    this.onGroundPrev = this.onGround;

    // safety: never fall out of the world
    if (this.pos[1] < -10) { this.pos[1] = 80; this.vel[1] = 0; }
  };

  global.Player = Player;
  Player.HALF = HALF; Player.HEIGHT = HEIGHT; Player.EYE = EYE;
})(typeof window !== "undefined" ? window : globalThis);
