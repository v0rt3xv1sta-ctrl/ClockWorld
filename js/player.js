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
  const WALK = 4.4, SPRINT = 6.2, SNEAK = 1.7, FLY = 11, SWIM = 4.6, SWIM_UP = 5.0;
  const STEP_LAND = 0.6, STEP_WATER = 1.12; // auto-step height: a block up while swimming
  const SENS = 0.0023, PITCH_LIMIT = Math.PI / 2 - 0.01;

  const MAX_HEALTH = 20, MAX_AIR = 10; // air in seconds underwater before drowning

  function Player(spawn, mode) {
    this.pos = spawn.slice();
    this.spawn = spawn.slice();
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.onGroundPrev = false;
    this.flying = false;
    this.inWater = false;
    this.mode = mode === "creative" ? "creative" : "survival";
    this.creative = this.mode === "creative";
    if (this.creative) this.flying = true;
    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.air = MAX_AIR;
    this.maxAir = MAX_AIR;
    this.dead = false;
    this.fallPeak = spawn[1];
    this._drownAcc = 0;
    this._hurtFlash = 0; // seconds remaining on the red damage flash
  }

  Player.prototype.setMode = function (mode) {
    this.mode = mode === "creative" ? "creative" : "survival";
    this.creative = this.mode === "creative";
    if (!this.creative) { this.flying = false; }
    else { this.health = this.maxHealth; this.air = this.maxAir; this.dead = false; }
  };

  Player.prototype.hurt = function (amount) {
    if (this.creative || this.dead || amount <= 0) return;
    this.health -= amount;
    this._hurtFlash = 0.35;
    if (this.health <= 0) { this.health = 0; this.dead = true; }
  };

  Player.prototype.heal = function (amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  };

  Player.prototype.respawn = function (spawn) {
    this.pos = (spawn || this.spawn).slice();
    this.vel = [0, 0, 0];
    this.health = this.maxHealth;
    this.air = this.maxAir;
    this.dead = false;
    this.fallPeak = this.pos[1];
    this._drownAcc = 0;
  };

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
    if (!this.creative) return; // flying is creative-only
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
    return Blocks.isLiquid(world.getBlock(Math.floor(p[0]), Math.floor(p[1] + 0.5), Math.floor(p[2])));
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

  // Does the body AABB currently overlap any solid voxel?
  Player.prototype.overlapsSolid = function (world) {
    const p = this.pos, e = 0.0005;
    const x0 = Math.floor(p[0] - HALF + e), x1 = Math.floor(p[0] + HALF - e);
    const y0 = Math.floor(p[1] + e), y1 = Math.floor(p[1] + HEIGHT - e);
    const z0 = Math.floor(p[2] - HALF + e), z1 = Math.floor(p[2] + HALF - e);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          if (Blocks.isSolid(world.getBlock(x, y, z))) return true;
    return false;
  };

  // Horizontal movement with auto step-up so the player can climb a ledge (and,
  // with the taller water step, swim up and out of water).
  Player.prototype.moveHoriz = function (world, dx, dz, stepH) {
    const sx = this.pos[0], sy = this.pos[1], sz = this.pos[2];
    const hx = this.collideAxis(world, 0, dx);
    const hz = this.collideAxis(world, 2, dz);
    if (stepH <= 0 || !(hx || hz)) return;
    const nx = this.pos[0], nz = this.pos[2];
    const baseProg = Math.abs(nx - sx) + Math.abs(nz - sz);
    // retry the move from a stepped-up height
    this.pos[0] = sx; this.pos[2] = sz; this.pos[1] = sy + stepH;
    if (this.overlapsSolid(world)) { this.pos[0] = nx; this.pos[2] = nz; this.pos[1] = sy; return; }
    this.collideAxis(world, 0, dx);
    this.collideAxis(world, 2, dz);
    if (Math.abs(this.pos[0] - sx) + Math.abs(this.pos[2] - sz) > baseProg + 1e-3) {
      if (this.vel[1] < 0) this.vel[1] = 0; // settle gently onto the step
    } else {
      this.pos[0] = nx; this.pos[2] = nz; this.pos[1] = sy; // stepping didn't help
    }
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
        this.vel[1] -= GRAVITY * 0.16 * dt;   // gentle sink
        this.vel[1] *= 0.86;                   // water drag
        if (this.vel[1] < -4) this.vel[1] = -4;
        if (cmd.jump) this.vel[1] = SWIM_UP;   // hold to swim / climb up and out
      } else {
        this.vel[1] -= GRAVITY * dt;
        if (this.vel[1] < -TERMINAL) this.vel[1] = -TERMINAL;
        if (cmd.jump && this.onGroundPrev) this.vel[1] = JUMP_VEL;
      }
    }

    const wasAirborne = !this.onGroundPrev;
    const stepH = this.flying ? 0 : (this.inWater ? STEP_WATER : (this.onGroundPrev ? STEP_LAND : 0));
    this.moveHoriz(world, this.vel[0] * dt, this.vel[2] * dt, stepH);
    this.collideAxis(world, 1, this.vel[1] * dt);

    // fall damage on landing (survival only; ignored while flying/swimming)
    if (this.onGround) {
      if (wasAirborne && !this.flying && !this.inWater) {
        const fall = this.fallPeak - this.pos[1];
        if (fall > 3) this.hurt(Math.floor(fall - 3));
      }
      this.fallPeak = this.pos[1];
    } else if (this.pos[1] > this.fallPeak) {
      this.fallPeak = this.pos[1];
    }
    if (this.flying || this.inWater) this.fallPeak = this.pos[1];
    this.onGroundPrev = this.onGround;

    // drowning: a submerged head drains air, then deals 1 damage per second
    const eyeBlock = world.getBlock(
      Math.floor(this.pos[0]), Math.floor(this.pos[1] + EYE), Math.floor(this.pos[2]));
    if (Blocks.isLiquid(eyeBlock) && !this.creative) {
      this.air -= dt;
      if (this.air <= 0) {
        this.air = 0;
        this._drownAcc += dt;
        if (this._drownAcc >= 1) { this.hurt(1); this._drownAcc -= 1; }
      }
    } else {
      this.air = Math.min(this.maxAir, this.air + dt * 3);
      this._drownAcc = 0;
    }

    // the void
    if (this.pos[1] < -20) {
      if (this.creative) { this.pos[1] = 100; this.vel[1] = 0; }
      else this.hurt(this.maxHealth);
    }

    if (this._hurtFlash > 0) this._hurtFlash -= dt;
  };

  global.Player = Player;
  Player.HALF = HALF; Player.HEIGHT = HEIGHT; Player.EYE = EYE;
})(typeof window !== "undefined" ? window : globalThis);
