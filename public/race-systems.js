// Browser-independent input, preferences, race timing and replay state.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const angle = value => Math.atan2(Math.sin(value), Math.cos(value));
const mix = (a, b, t) => a + (b - a) * t;
const VERSION = 2;
const GHOST_LIMIT = 3000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export const DEFAULT_SETTINGS = Object.freeze({
  carId: 'Porsche992', mode: 'race', assist: 'sport', difficulty: 'pro', wetness: .75,
  quality: 'balanced', modelDetail: 'race', camera: 0, sensitivity: 1, deadzone: .12,
  volume: .65, fov: 68, motion: .5, reducedMotion: false, racingLine: true,
  ghost: true, compactHud: false,
});
const enums = {
  carId: ['Porsche992', 'Mercedes2005', 'Mercedes2018', 'MercedesGT3'],
  mode: ['race', 'time-trial'], assist: ['approachable', 'sport', 'expert'],
  difficulty: ['club', 'pro', 'elite'], quality: ['balanced', 'high'],
  modelDetail: ['race', 'full'], camera: [0, 1, 2],
};
const ranges = {wetness: [0, 1], sensitivity: [.6, 1.4], deadzone: [.05, .3], volume: [0, 1], fov: [55, 85], motion: [0, 1]};

function validateSettings(value, base = DEFAULT_SETTINGS) {
  const next = {...base};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return next;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!own(value, key)) continue;
    if (enums[key]) {
      if (enums[key].includes(value[key])) next[key] = value[key];
    } else if (ranges[key]) {
      if (finite(value[key])) next[key] = clamp(value[key], ...ranges[key]);
    } else if (typeof value[key] === 'boolean') next[key] = value[key];
  }
  return next;
}

export class SettingsStore {
  constructor(storage = defaultStorage(), key = 'storm-exe.settings.v2') {
    this.storage = storage;
    this.key = key;
    this.value = {...DEFAULT_SETTINGS};
    try {
      const raw = storage?.getItem(key);
      if (raw && raw.length < 8192) {
        const saved = JSON.parse(raw);
        if (saved?.version === VERSION) this.value = validateSettings(saved.settings);
      }
    } catch { /* Private browsing and corrupt preferences use safe defaults. */ }
  }
  get() { return {...this.value}; }
  update(patch) {
    this.value = validateSettings(patch, this.value);
    try { this.storage?.setItem(this.key, JSON.stringify({version: VERSION, settings: this.value})); } catch { /* Keep settings for this session. */ }
    return this.get();
  }
  reset() {
    this.value = {...DEFAULT_SETTINGS};
    return this.update({});
  }
}

export function readGamepad(pads, deadzone = .12) {
  const neutral = {connected: false, label: '', throttle: 0, brake: 0, steer: 0, handbrake: false, pause: false, camera: false, reset: false, lookBack: false};
  if (!pads || typeof pads[Symbol.iterator] !== 'function') return neutral;
  const pad = Array.from(pads).find(p => p && p.connected !== false && (p.mapping === 'standard' || !p.mapping));
  if (!pad) return neutral;
  const zone = finite(deadzone) ? clamp(deadzone, 0, .45) : .12;
  const axis = finite(pad.axes?.[0]) ? clamp(pad.axes[0], -1, 1) : 0;
  const steer = Math.abs(axis) <= zone ? 0 : Math.sign(axis) * (Math.abs(axis) - zone) / (1 - zone);
  const button = index => {
    const value = pad.buttons?.[index];
    return finite(value) ? clamp(value, 0, 1) : finite(value?.value) ? clamp(value.value, 0, 1) : value?.pressed ? 1 : 0;
  };
  return {
    ...neutral, connected: true, label: String(pad.id || 'Gamepad').slice(0, 160), steer,
    throttle: button(7), brake: button(6), handbrake: button(0) > .5,
    pause: button(9) > .5, camera: button(3) > .5, reset: button(2) > .5,
    lookBack: button(1) > .5 || button(11) > .5,
  };
}

function pose(state, t = 0, p = 0) {
  return {t, p, x: finite(state?.x) ? state.x : 0, y: finite(state?.y) ? state.y : 0,
    z: finite(state?.z) ? state.z : 0, yaw: finite(state?.yaw) ? angle(state.yaw) : 0,
    speed: finite(state?.speed) ? state.speed : 0};
}
function interpolate(a, b, t) {
  const fraction = b.t === a.t ? 0 : clamp((t - a.t) / (b.t - a.t), 0, 1);
  return {t: mix(a.t, b.t, fraction), p: mix(a.p, b.p, fraction),
    x: mix(a.x, b.x, fraction), y: mix(a.y, b.y, fraction), z: mix(a.z, b.z, fraction),
    yaw: angle(a.yaw + angle(b.yaw - a.yaw) * fraction), speed: mix(a.speed, b.speed, fraction)};
}
function sampleAt(samples, time) {
  if (!samples?.length || !finite(time)) return null;
  if (time <= samples[0].t) return {...samples[0]};
  if (time >= samples.at(-1).t) return {...samples.at(-1)};
  let low = 0, high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (samples[mid].t < time) low = mid; else high = mid;
  }
  return interpolate(samples[low], samples[high], time);
}
function raceContext(value = {}) {
  return {carId: enums.carId.includes(value.carId) ? value.carId : DEFAULT_SETTINGS.carId,
    mode: enums.mode.includes(value.mode) ? value.mode : DEFAULT_SETTINGS.mode,
    wetness: finite(value.wetness) ? Math.round(clamp(value.wetness, 0, 1) * 1000) / 1000 : DEFAULT_SETTINGS.wetness,
    assist: enums.assist.includes(value.assist) ? value.assist : DEFAULT_SETTINGS.assist,
    difficulty: enums.difficulty.includes(value.difficulty) ? value.difficulty : DEFAULT_SETTINGS.difficulty};
}
function contextKey(context) {
  return [context.carId, context.mode, context.wetness, context.assist, context.difficulty].join(':');
}
function progressFraction(value) {
  if (finite(value)) return clamp(value, 0, 1);
  if (finite(value?.fraction)) return clamp(value.fraction, 0, 1);
  if (finite(value?.distance) && finite(value?.length) && value.length > 0) return clamp(value.distance / value.length, 0, 1);
  return null;
}
function validRecord(record, context) {
  if (!record || record.version !== VERSION || !record.context || typeof record.context !== 'object') return false;
  if (!['carId', 'mode', 'assist', 'difficulty'].every(key => enums[key].includes(record.context[key]))) return false;
  if (!finite(record.context.wetness) || record.context.wetness < 0 || record.context.wetness > 1) return false;
  if (contextKey(record.context) !== contextKey(context)) return false;
  if (!finite(record.time) || record.time <= 0 || record.time > 86400) return false;
  if (!Array.isArray(record.sectors) || record.sectors.length !== 3 || !record.sectors.every(t => finite(t) && t > 0)) return false;
  if (Math.abs(record.sectors.reduce((a, b) => a + b, 0) - record.time) > .02) return false;
  if (!Array.isArray(record.samples) || record.samples.length < 2 || record.samples.length > GHOST_LIMIT) return false;
  let lastTime = -1, lastProgress = -1;
  for (const sample of record.samples) {
    if (!sample || !['t', 'p', 'x', 'y', 'z', 'yaw', 'speed'].every(key => finite(sample[key]))) return false;
    if (sample.t <= lastTime || sample.t < 0 || sample.t > record.time + .001 || sample.p < lastProgress || sample.p < 0 || sample.p > 1) return false;
    if (Math.abs(sample.x) > 1e7 || Math.abs(sample.y) > 1e7 || Math.abs(sample.z) > 1e7 || Math.abs(sample.yaw) > Math.PI + .001 || Math.abs(sample.speed) > 1000) return false;
    lastTime = sample.t; lastProgress = sample.p;
  }
  return record.samples[0].t === 0 && record.samples[0].p <= .02 && Math.abs(lastTime - record.time) < .001 && lastProgress === 1;
}

export class SessionTelemetry {
  constructor({storage = defaultStorage(), ...context} = {}) {
    this.storage = storage;
    this.reset(context);
  }
  reset(context = {}) {
    const sessionBest = this.best;
    this.context = raceContext({...this.context, ...context});
    this.key = 'storm-exe.best.v2:' + contextKey(this.context);
    this.best = validRecord(sessionBest, this.context) ? sessionBest : null;
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw && raw.length <= 1500000) {
        const record = JSON.parse(raw);
        if (validRecord(record, this.context) && (!this.best || record.time < this.best.time)) this.best = record;
      }
    } catch { /* A race must always start even without browser storage. */ }
    this.elapsed = 0; this.progress = 0; this.maxProgress = 0;
    this.started = false; this.finished = false; this.demo = false;
    this.sectors = [null, null, null]; this.crossings = [null, null, null];
    this.metrics = {maxSpeed: 0, distance: 0, braking: 0, collisions: 0, recoveries: 0, offroadTime: 0, clean: true, valid: true};
    this.invalidReasons = []; this.samples = []; this.summary = null;
    this.previous = null; this.sampleInterval = .25; this.nextSampleTime = .25;
    this.offroadStreak = 0; this.skipDistance = false; this.lastHitTime = -Infinity;
    return this;
  }
  invalidate(reason) {
    this.metrics.valid = false;
    this.metrics.clean = false;
    if (!this.invalidReasons.includes(reason)) this.invalidReasons.push(reason);
  }
  hit() {
    if (!this.started || this.finished) return;
    this.metrics.clean = false;
    if (this.elapsed - this.lastHitTime >= .6) {
      this.metrics.collisions++; this.lastHitTime = this.elapsed;
    }
  }
  recover() {
    this.skipDistance = true;
    if (!this.started || this.finished) return;
    this.metrics.recoveries++;
    this.invalidate('recovery');
  }
  appendSample(sample) {
    if (this.samples.length && Math.abs(sample.t - this.samples.at(-1).t) < 1e-8) {
      this.samples[this.samples.length - 1] = sample; return;
    }
    if (this.samples.length >= GHOST_LIMIT) {
      this.samples = this.samples.filter((_, index) => index % 2 === 0);
      this.sampleInterval *= 2;
    }
    this.samples.push(sample);
  }
  update(dt, state, progress, {started = true, finished = false, demo = false, time, input} = {}) {
    if (this.finished) return this.summary;
    if (demo) this.demo = true;
    const fraction = progressFraction(progress);
    if (!started) return this.metrics;
    if (!this.started) {
      this.started = true;
      this.previous = pose(state, 0, 0);
      this.appendSample({...this.previous});
      if (fraction !== null && fraction > .02) this.invalidate('incomplete-start');
      // Lap.start resets its clock at the line, so the crossing frame itself
      // contributes no time unless the caller supplies an explicit race clock.
      if (!finite(time)) dt = 0;
    }
    dt = finite(dt) && dt > 0 ? Math.min(dt, 86400) : 0;
    const previousTime = this.elapsed;
    this.elapsed = finite(time) ? Math.max(this.elapsed, clamp(time, 0, 86400)) : Math.min(86400, this.elapsed + dt);
    const elapsedStep = this.elapsed - previousTime;
    const previousProgress = this.progress;
    if (fraction !== null) this.progress = fraction;
    this.maxProgress = Math.max(this.maxProgress, this.progress);
    const current = pose(state, this.elapsed, this.maxProgress);
    this.metrics.maxSpeed = Math.max(this.metrics.maxSpeed, Math.abs(current.speed));
    if (!this.skipDistance) this.metrics.distance += Math.hypot(current.x - this.previous.x, current.y - this.previous.y, current.z - this.previous.z);
    this.skipDistance = false;
    if ((input?.brake ?? state?.brake ?? state?.input?.brake ?? 0) > .05) this.metrics.braking += elapsedStep;
    const offroad = state?.offroad === true || (finite(state?.offroad) && state.offroad > 0);
    if (offroad) {
      this.metrics.offroadTime += elapsedStep; this.offroadStreak += elapsedStep;
      if (this.offroadStreak >= 1.5 || this.metrics.offroadTime >= 5) this.invalidate('track-limits');
    } else this.offroadStreak = 0;
    if (this.progress > previousProgress) {
      for (let index = 0; index < 3; index++) {
        const boundary = (index + 1) / 3;
        if (this.crossings[index] === null && previousProgress < boundary && this.progress >= boundary) {
          this.crossings[index] = mix(previousTime, this.elapsed, (boundary - previousProgress) / (this.progress - previousProgress));
          this.sectors[index] = this.crossings[index] - (index ? this.crossings[index - 1] ?? 0 : 0);
        }
      }
    }
    // Resampling instead of retaining every physics tick keeps a complete
    // ghost small. Very long runs progressively halve older sample density.
    while (this.nextSampleTime <= this.elapsed + 1e-8) {
      this.appendSample(interpolate(this.previous, current, this.nextSampleTime));
      this.nextSampleTime += this.sampleInterval;
    }
    this.previous = current;
    if (finished) return this.finish();
    return this.metrics;
  }
  delta(progress = this.progress) {
    const fraction = progressFraction(progress), samples = this.best?.samples;
    if (fraction === null || !samples?.length || !this.started) return null;
    if (fraction <= samples[0].p) return this.elapsed;
    let low = 0, high = samples.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (samples[mid].p < fraction) low = mid; else high = mid;
    }
    const a = samples[low], b = samples[high];
    const t = b.p === a.p ? b.t : mix(a.t, b.t, clamp((fraction - a.p) / (b.p - a.p), 0, 1));
    return this.elapsed - t;
  }
  getGhost(time = this.elapsed) { return sampleAt(this.best?.samples, time); }
  finish(context = {}) {
    if (this.summary) return this.summary;
    if (contextKey(raceContext({...this.context, ...context})) !== contextKey(this.context)) this.invalidate('conditions-changed');
    if (!this.started || this.progress < 1 || this.sectors.some(t => !finite(t) || t <= 0)) this.invalidate('incomplete-course');
    if (this.demo) this.invalidate('demo');
    this.finished = true;
    if (this.previous) this.appendSample({...this.previous, t: this.elapsed});
    const oldBest = this.best?.time ?? null;
    const personalBest = this.metrics.valid && (oldBest === null || this.elapsed < oldBest);
    if (personalBest) {
      const record = {version: VERSION, context: {...this.context}, time: this.elapsed, sectors: [...this.sectors], samples: this.samples.map(sample => ({...sample}))};
      if (validRecord(record, this.context)) {
        this.best = record;
        try { this.storage?.setItem(this.key, JSON.stringify(record)); } catch { /* Session PB remains usable when storage is full. */ }
      } else this.invalidate('invalid-record');
    }
    this.summary = {time: this.elapsed, sectors: [...this.sectors], ...this.metrics,
      invalidReasons: [...this.invalidReasons], personalBest: personalBest && this.metrics.valid,
      bestTime: this.best?.time ?? null, improvement: oldBest === null ? null : oldBest - this.elapsed,
      context: {...this.context}};
    return this.summary;
  }
}

export class ReplayBuffer {
  constructor({duration = 20, interval = 1 / 30, maxSamples = 720} = {}) {
    this.duration = finite(duration) ? clamp(duration, 1, 120) : 20;
    this.interval = finite(interval) ? clamp(interval, 1 / 120, 1) : 1 / 30;
    this.maxSamples = finite(maxSamples) ? clamp(Math.floor(maxSamples), 2, 4000) : 720;
    this.reset();
  }
  reset() { this.samples = []; this.time = 0; this.previous = null; this.nextSampleTime = 0; }
  record(state, dt) {
    const step = finite(dt) && dt > 0 ? Math.min(dt, this.duration) : 0;
    if (!this.previous) {
      this.previous = pose(state, 0); this.samples.push({...this.previous});
      this.nextSampleTime = this.interval; return;
    }
    this.time += step;
    const current = pose(state, this.time);
    while (this.nextSampleTime <= this.time + 1e-8) {
      this.samples.push(interpolate(this.previous, current, this.nextSampleTime));
      this.nextSampleTime += this.interval;
    }
    const earliest = this.time - this.duration;
    while (this.samples.length > 2 && this.samples[1].t < earliest) this.samples.shift();
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    this.previous = current;
  }
  sample(secondsAgo = 0) {
    if (!this.previous || !finite(secondsAgo)) return null;
    const target = this.time - clamp(secondsAgo, 0, this.duration);
    const last = this.samples.at(-1);
    return last && target > last.t ? interpolate(last, this.previous, target) : sampleAt(this.samples, target);
  }
}
