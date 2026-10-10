import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS, SettingsStore, readGamepad, SessionTelemetry, ReplayBuffer} from '../public/race-systems.js';

const storage = () => {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values};
};
const state = (x = 0, extra = {}) => ({x, y: 0, z: 0, yaw: 0, speed: 20, ...extra});
function completeRace(session, duration = 90) {
  session.update(0, state(), 0, {time: 0});
  for (let t = .25; t < duration; t += .25) session.update(.25, state(t * 20), t / duration, {time: t});
  session.update(.25, state(duration * 20), 1, {time: duration, finished: true});
  return session.finish();
}

test('settings survive corrupt, version-mismatched and unavailable storage', () => {
  const saved = storage(), key = 'storm-exe.settings.v2';
  saved.setItem(key, '{');
  assert.deepEqual(new SettingsStore(saved).get(), DEFAULT_SETTINGS);
  saved.setItem(key, JSON.stringify({version: 1, settings: {volume: 0}}));
  assert.equal(new SettingsStore(saved).get().volume, DEFAULT_SETTINGS.volume);
  const inaccessible = {getItem() {throw Error('blocked');}, setItem() {throw Error('quota');}};
  const settings = new SettingsStore(inaccessible);
  assert.equal(settings.update({volume: .2}).volume, .2);
  assert.deepEqual(settings.reset(), DEFAULT_SETTINGS);
});

test('settings validate enums, booleans and ranges and do not accept foreign keys', () => {
  const saved = storage(), settings = new SettingsStore(saved);
  const next = settings.update({assist: 'no-grip', volume: 50, fov: -1, camera: '1', sensitivity: NaN, ghost: 'true', dangerous: true});
  assert.equal(next.assist, 'sport'); assert.equal(next.volume, 1); assert.equal(next.fov, 55);
  assert.equal(next.camera, 0); assert.equal(next.sensitivity, 1); assert.equal(next.ghost, true);
  assert.equal('dangerous' in next, false);
  const patched = settings.update({assist: 'expert', camera: 2, compactHud: true, carId: 'MercedesGT3'});
  assert.deepEqual(new SettingsStore(saved).get(), patched);
  patched.volume = 0; assert.equal(settings.get().volume, 1);
});

test('standard gamepad analog pedals, deadzone, held actions and disconnection work', () => {
  const buttons = Array.from({length: 16}, () => ({value: 0, pressed: false}));
  buttons[7].value = .75; buttons[6].value = .2; buttons[0].pressed = true; buttons[0].value = 1;
  buttons[9].value = 1; buttons[3].value = 1; buttons[2].value = 1; buttons[1].value = 1;
  const pad = {id: 'Controller', mapping: 'standard', connected: true, axes: [.12], buttons};
  const controls = readGamepad([null, pad]);
  assert.equal(controls.steer, 0); assert.equal(controls.throttle, .75); assert.equal(controls.brake, .2);
  for (const key of ['handbrake', 'pause', 'camera', 'reset', 'lookBack']) assert.equal(controls[key], true);
  pad.axes[0] = -.56; assert.ok(Math.abs(readGamepad([pad]).steer + .5) < 1e-8);
  pad.connected = false; assert.equal(readGamepad([pad]).connected, false);
  assert.equal(readGamepad(null).throttle, 0);
  pad.connected = true; pad.axes[0] = NaN; assert.equal(readGamepad([pad]).steer, 0);
});

test('sector timing interpolates multiple skipped thresholds and never recrosses backward', () => {
  const session = new SessionTelemetry({storage: null});
  session.update(0, state(), 0, {time: 0});
  session.update(8, state(80), .8, {time: 8});
  assert.ok(Math.abs(session.sectors[0] - 10 / 3) < 1e-8);
  assert.ok(Math.abs(session.sectors[1] - 10 / 3) < 1e-8);
  const sectors = [...session.sectors];
  session.update(1, state(40), .4, {time: 9});
  session.update(1, state(80), .8, {time: 10});
  assert.deepEqual(session.sectors, sectors);
  const summary = session.update(2, state(100), 1, {time: 12, finished: true});
  assert.equal(summary.valid, true); assert.equal(summary.personalBest, true);
  assert.equal(summary.sectors.reduce((a, b) => a + b), 12);
  assert.equal(summary.time, 12);
});

test('ghost persists by conditions and interpolates positions, shortest yaw and live delta', () => {
  const saved = storage(), context = {storage: saved, carId: 'Porsche992', mode: 'time-trial', wetness: .4, assist: 'expert'};
  const session = new SessionTelemetry(context);
  session.update(0, state(0, {yaw: Math.PI - .1}), 0, {time: 0});
  session.update(1, state(20, {yaw: -Math.PI + .1}), .5, {time: 1});
  session.update(1, state(40), 1, {time: 2, finished: true});
  const restored = new SessionTelemetry(context);
  assert.equal(restored.best.time, 2);
  const ghost = restored.getGhost(.5);
  assert.equal(ghost.x, 10); assert.ok(Math.abs(Math.abs(ghost.yaw) - Math.PI) < 1e-8);
  restored.update(0, state(), 0, {time: 0});
  restored.update(.8, state(20), .5, {time: .8});
  assert.ok(Math.abs(restored.delta() + .2) < 1e-8);
  assert.equal(new SessionTelemetry({...context, wetness: .85}).best, null);
  assert.equal(new SessionTelemetry({...context, assist: 'sport'}).best, null);
  assert.equal(new SessionTelemetry({...context, carId: 'MercedesGT3'}).best, null);
  assert.equal(new SessionTelemetry({...context, mode: 'race'}).best, null);
});

test('recovery invalidates record, does not count teleported distance and cannot rewrite sectors', () => {
  const saved = storage(), session = new SessionTelemetry({storage: saved});
  session.update(0, state(), 0, {time: 0});
  session.update(4, state(40), .4, {time: 4});
  const firstSector = session.sectors[0];
  session.recover(); session.update(1, state(10), .1, {time: 5});
  assert.equal(session.metrics.distance, 40);
  session.update(9, state(100), 1, {time: 14, finished: true});
  assert.equal(session.sectors[0], firstSector);
  assert.equal(session.summary.recoveries, 1); assert.equal(session.summary.valid, false);
  assert.equal(session.summary.personalBest, false); assert.equal(session.best, null);
  assert.ok(session.summary.invalidReasons.includes('recovery')); assert.equal(saved.values.size, 0);
});

test('offroad, collisions, pedal use, demo and unfinished runs are tracked honestly', () => {
  const session = new SessionTelemetry({storage: null});
  session.update(0, state(), 0, {time: 0});
  session.hit(); session.hit(); assert.equal(session.metrics.collisions, 1);
  session.update(.8, state(10, {offroad: .8}), .1, {time: .8, input: {brake: .5}});
  session.hit(); assert.equal(session.metrics.collisions, 2);
  session.update(.8, state(20, {offroad: 1.6}), .2, {time: 1.6});
  const summary = session.finish();
  assert.equal(summary.braking, .8); assert.equal(summary.offroadTime, 1.6);
  assert.equal(summary.clean, false); assert.equal(summary.valid, false);
  assert.ok(summary.invalidReasons.includes('track-limits'));
  assert.ok(summary.invalidReasons.includes('incomplete-course'));
  const demo = new SessionTelemetry({storage: null});
  demo.update(0, state(), 0, {demo: true});
  assert.equal(completeRace(demo, 3).personalBest, false);
});

test('malformed and foreign personal-best records are ignored without blocking races', () => {
  const saved = storage(), session = new SessionTelemetry({storage: saved});
  completeRace(session, 3);
  const pristine = JSON.parse(saved.getItem(session.key));
  const mutations = [
    record => {record.time = -1;}, record => {record.sectors[0] = 'fast';},
    record => {record.samples[1].x = Infinity;}, record => {record.samples[1].t = -1;},
    record => {record.samples[1].p = 1.1;}, record => {record.samples[1].p = -1;},
    record => {record.context.carId = 'MercedesGT3';}, record => {record.version = 1;},
    record => {record.context.carId = 'unknown';}, record => {record.context.assist = 'tampered';},
    record => {record.context.wetness = '0.75';}, record => {delete record.context.difficulty;},
    record => {record.samples = Array(3001).fill(record.samples[0]);},
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(pristine); mutate(changed);
    saved.setItem(session.key, JSON.stringify(changed));
    assert.equal(new SessionTelemetry({storage: saved}).best, null);
  }
  const inaccessible = {getItem() {throw Error('blocked');}, setItem() {throw Error('quota');}};
  const offline = new SessionTelemetry({storage: inaccessible});
  assert.equal(completeRace(offline, 3).personalBest, true);
  assert.equal(offline.best.time, 3);
  offline.reset(); assert.equal(offline.best.time, 3);
});

test('long sessions keep bounded ghost memory including the complete finish', () => {
  const session = new SessionTelemetry({storage: null});
  const summary = completeRace(session, 1600);
  assert.equal(summary.personalBest, true);
  assert.ok(session.samples.length <= 3000);
  assert.equal(session.samples[0].t, 0); assert.equal(session.samples.at(-1).t, 1600);
  assert.equal(session.samples.at(-1).p, 1);
  assert.equal(session.getGhost(1500).x, 30000);
});

test('replay remains bounded, interpolates the latest unsampled frame and resets', () => {
  const replay = new ReplayBuffer({duration: 20, interval: .1, maxSamples: 220});
  assert.equal(replay.sample(1), null);
  replay.record(state(), 0);
  for (let i = 1; i <= 1000; i++) replay.record(state(i / 10, {yaw: i < 999 ? Math.PI - .1 : -Math.PI + .1}), .1);
  assert.ok(replay.samples.length <= 220);
  assert.ok(replay.samples[0].t > 79.8);
  assert.ok(Math.abs(replay.sample(10).x - 90) < 1e-7);
  replay.record(state(100.05), .05);
  assert.equal(replay.sample(0).x, 100.05);
  assert.ok(Math.abs(replay.sample(.025).x - 100.025) < 1e-7);
  replay.reset(); assert.equal(replay.sample(0), null);
});
