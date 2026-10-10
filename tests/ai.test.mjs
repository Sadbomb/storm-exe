import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AI_DIFFICULTIES,CAR_IDS,RaceRoute,RivalRace} from '../public/ai.js';
import {RoadSurface,makeCar,drive,Lap} from '../public/driving.js';
import {CollisionWorld,resolveCars} from '../public/collision.js';
import {gateCollisionTriangles} from '../public/gate-collision.js';

function fixture({difficulty='pro',wetness=0,curvature=()=>0}={}){
 const route=Object.assign(Object.create(RaceRoute.prototype),{
  length:2000,gateDistances:[0,1000],
  at:s=>({x:s,y:0,z:0,fx:1,fz:0,width:6,s}),curvature,
  project:s=>({x:s.x,y:0,z:0,fx:1,fz:0,s:s.x,error:Math.abs(s.z)})
 });
 const gates=[{x:0,y:0,z:0,fx:1,fz:0,width:6},{x:1000,y:0,z:0,fx:1,fz:0,width:6}];
 const race=new RivalRace({route,gates,road:{sample:()=>0},difficulty,wetness});
 const racer=race.racers[0];Object.assign(racer,{routeS:100,lane:0,desiredLane:0,index:1});
 Object.assign(racer.state,{x:100,z:0,speed:25,vx:25,vz:0,yaw:0});
 return {race,racer};
}
const trafficCar=(x,z=0,speed=15)=>({...makeCar({x,y:0,z,yaw:0}),speed,vx:speed});

test('difficulty changes target pace without teleporting or boosting physical state',()=>{
 const speeds=[];
 for(const difficulty of Object.keys(AI_DIFFICULTIES)){
  const {race,racer}=fixture({difficulty}),before={...racer.state};
  race.controls(racer,[],1/120);speeds.push(racer.targetSpeed);
  assert.deepEqual(racer.state,before);
 }
 assert.ok(speeds[0]<speeds[1]&&speeds[1]<speeds[2]);
});

test('wet roads lower corner approach speed and brake before the corner',()=>{
 const speeds=[];
 for(const wetness of [0,1]){
  const {race,racer}=fixture({wetness,curvature:s=>s>=130?.055:0});
  Object.assign(racer.state,{speed:36,vx:36});
  const input=race.controls(racer,[],1/120);speeds.push(racer.targetSpeed);
  assert.ok(input.brake>0);assert.equal(input.throttle,0);
 }
 assert.ok(speeds[1]<speeds[0]);
});

test('a closing car brakes for a stationary leader before contact',()=>{
 const {race,racer}=fixture();const input=race.controls(racer,[trafficCar(113,0,0)],1/120);
 assert.equal(input.brake,1);assert.equal(input.throttle,0);assert.equal(input.canReverse,false);
});

test('slower traffic in another clear lane does not force following brakes',()=>{
 const {race,racer}=fixture();race.controls(racer,[trafficCar(122,4,0)],1/120);
 assert.ok(racer.targetSpeed>40);
});

test('overtaking checks fast rear traffic on both sides before merging',()=>{
 const {race,racer}=fixture();race.controls(racer,[trafficCar(125),trafficCar(89,2.65,48),trafficCar(89,-2.65,48)],1/120);
 assert.equal(racer.desiredLane,0);assert.ok(racer.targetSpeed<25);
});

test('an overtake keeps its selected lane briefly after the leader disappears',()=>{
 const {race,racer}=fixture();race.controls(racer,[trafficCar(130)],1/120);
 assert.ok(Math.abs(racer.desiredLane)>2);const chosen=racer.desiredLane;
 race.controls(racer,[],1/120);assert.equal(racer.desiredLane,chosen);
 assert.ok(Math.abs(racer.lane)<.04,'lane change must be gradual');
});

test('demo controls tolerate absent optional AI fields',()=>{
 const {race}=fixture();const racer={state:trafficCar(100),routeS:100};
 const input=race.controls(racer,undefined,1/120);
 for(const field of ['steer','throttle','brake'])assert.ok(Number.isFinite(input[field]),field);
});

test('car identity and wetness survive reset and recovery',()=>{
 const {race}=fixture();race.setWetness(.4);race.setDifficulty('elite');race.reset('MercedesGT3');
 for(const racer of race.racers){
  assert.equal(racer.state.carId,racer.id);assert.equal(racer.state.wetness,.4);
  race.recover(racer);assert.equal(racer.state.carId,racer.id);assert.equal(racer.state.wetness,.4);
 }
 assert.equal(race.difficulty,'elite');assert.equal(race.setDifficulty('unknown'),'pro');
 assert.equal(race.setWetness(Infinity),1);
});

test('route projection retains unwrapped progress across the finish seam',()=>{
 const route=new RaceRoute({points:[[0,0,0,5],[50,0,0,5],[50,0,50,5],[0,0,50,5]],gateDistances:[0,100]});
 const p=route.project({x:1,y:0,z:0},201,20);
 assert.equal(p.s,201);assert.equal(route.at(201).x,1);
});

test('a missed checkpoint recovers behind it without granting progress',()=>{
 const {race,racer}=fixture();racer.lap.started=true;racer.lap.next=1;racer.routeS=1060;
 Object.assign(racer.state,{x:1060,z:0});race.pendingStep={dt:1/120,racers:[{racer,previous:{x:1059,y:0,z:0}}]};
 race.finalizeStep();assert.equal(racer.lap.next,1);assert.equal(racer.recoveryReason,'missed-checkpoint');
 assert.ok(racer.routeS<1000);assert.equal(racer.recoveries,1);
});

test('missing the start gate also returns a rival to its unstarted grid slot',()=>{
 const {race,racer}=fixture();racer.routeS=40;Object.assign(racer.state,{x:40,z:0});
 race.pendingStep={dt:1/120,racers:[{racer,previous:{x:39,y:0,z:0}}]};race.finalizeStep();
 assert.equal(racer.lap.started,false);assert.ok(racer.routeS<0);assert.equal(racer.recoveryReason,'missed-checkpoint');
});

test('all four cars complete the shipped wet circuit with scenery and traffic collision',()=>{
 const json=file=>JSON.parse(readFileSync(new URL('../public/assets/'+file,import.meta.url)));
 const route=new RaceRoute(json('ai-route.json')),road=new RoadSurface(json('road.json'));
 const gates=json('race.json').gates.map(g=>({x:g.location_cm[0]/100,y:g.location_cm[2]/100,z:g.location_cm[1]/100,fx:g.forward[0],fz:g.forward[1],width:g.pavement_width_m/2}));
 const colliderData=json('collision.json'),world=new CollisionWorld([...(Array.isArray(colliderData)?colliderData:colliderData.triangles),...gateCollisionTriangles(gates[0])]),fleet=json('fleet.json');
 const dimensions=Object.fromEntries(CAR_IDS.map(id=>{
  const b=fleet.cars[id].bounds,w=json(id+'.json').wheels;
  return [id,{halfLength:Math.max(Math.abs(b.min[0]),b.max[0]),halfWidth:Math.max(Math.abs(b.min[2]),b.max[2]),height:b.max[1],bottom:.2,wheelbase:Math.abs(w.FL.center_m[0]-w.BL.center_m[0]),trackWidth:Math.abs(w.FL.center_m[1]-w.FR.center_m[1])}];
 }));
 const race=new RivalRace({route,road,gates,collision:world,carDimensions:dimensions,difficulty:'pro',wetness:.75});
 const p=route.at(-44),state=makeCar({x:p.x,y:p.y,z:p.z,yaw:Math.atan2(p.fz,p.fx),carId:'Porsche992',wetness:.75,dimensions:dimensions.Porsche992}),lap=new Lap(gates);
 const demo={state,lap,index:1,routeS:-44,lane:0,desiredLane:0,topSpeed:65,cornerGrip:11.5};
 for(let frame=0;frame<120*600;frame++){
  const previous={x:state.x,y:state.y,z:state.z},dt=1/120;
  const input=lap.finished?{throttle:0,brake:1,steer:0,canReverse:false}:race.controls(demo,[state,...race.racers.map(r=>r.state)],dt);
  drive(state,input,dt,road,world);race.step(dt,state,lap,{deferGates:true});
  resolveCars([state,...race.racers.map(r=>r.state)],world);lap.step(previous,state,dt);race.finalizeStep();
  if(lap.finished&&race.racers.every(r=>r.finished))break;
 }
 assert.equal(lap.finished,true,'Porsche demonstration must clear every checkpoint');
 for(const racer of race.racers){assert.equal(racer.finished,true,racer.id);assert.equal(racer.recoveries,0,racer.id+' must finish without teleporting');}
});
