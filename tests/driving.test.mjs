import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCar,drive,RoadSurface,REVERSE_HOLD_SECONDS,steeringLock,getCarTuning,ASSIST_MODES} from '../public/driving.js';
import {CAR_TUNING} from '../public/vehicle-tuning.js';
import {CollisionWorld} from '../public/collision.js';
const flat={sample:()=>0};
const run=(state,input,seconds,hz=120,road=flat,collision=null)=>{
 for(let i=0;i<Math.round(seconds*hz);i++)drive(state,input,1/hz,road,collision);
 return state;
};
const rolling=(speed,options={})=>Object.assign(makeCar(options),{speed,vx:speed,vz:0});
function accelerationAndStop(carId,wetness=.75){
 const s=makeCar({carId,wetness});let seconds=0;
 while(s.speed<100/3.6&&seconds<15){drive(s,{throttle:1},1/120,flat);seconds+=1/120;}
 const start=s.distance;let stopSeconds=0;
 while(s.speed>.01&&stopSeconds<10){drive(s,{brake:1,canReverse:false},1/120,flat);stopSeconds+=1/120;}
 return {seconds,distance:s.distance-start,stopSeconds,state:s};
}

test('four vehicles accelerate and stop within plausible calibrated envelopes',()=>{
 const measured=Object.keys(CAR_TUNING).map(id=>({id,...accelerationAndStop(id)}));
 for(const {id,seconds,distance,stopSeconds,state} of measured){
  assert.ok(seconds>3.4&&seconds<6.2,`${id} 0–100 ${seconds.toFixed(2)} s`);
  assert.ok(distance>30&&distance<46,`${id} 100–0 ${distance.toFixed(1)} m`);
  assert.ok(stopSeconds>2&&stopSeconds<3.5);
  assert.ok(state.speed>=0&&state.speed<.01);
  assert.ok(Math.abs(state.z)<1e-8);
 }
 assert.ok(Math.max(...measured.map(m=>m.seconds))-Math.min(...measured.map(m=>m.seconds))>.7,'cars must have different launch/traction characteristics');
 assert.ok(measured.find(m=>m.id==='Mercedes2018').distance<measured.find(m=>m.id==='Mercedes2005').distance-2,'aero DTM brakes differently from the older car');
});

test('wet tires extend braking distance and require more traction control',()=>{
 for(const id of Object.keys(CAR_TUNING)){
  const dry=accelerationAndStop(id,0),wet=accelerationAndStop(id,1);
  assert.ok(wet.seconds>dry.seconds*1.15,id+' wet launch');
  assert.ok(wet.distance>dry.distance*1.12,id+' wet stopping');
 }
 const s=makeCar({wetness:1});let tc=false,abs=false;
 for(let i=0;i<600;i++){drive(s,{throttle:1},1/120,flat);tc ||= s.tcActive;}
 for(let i=0;i<120;i++){drive(s,{brake:1,canReverse:false},1/120,flat);abs ||= s.absActive;}
 assert.ok(tc);assert.ok(abs);
});

test('30, 60 and 120 Hz calls integrate the same maneuver',()=>{
 const states=[30,60,120].map(hz=>{
  const s=makeCar();run(s,{throttle:1},4,hz);run(s,{throttle:.5,steer:.65},2,hz);
  run(s,{brake:.7,steer:-.3,canReverse:false},1,hz);run(s,{},2,hz);return s;
 });
 for(const s of states.slice(1))for(const key of ['x','z','speed','yaw','yawRate','rpm','slip'])assert.ok(Math.abs(s[key]-states[0][key])<1e-8,key);
});

test('stationary steering does not create motion and steering release recenters',()=>{
 const parked=run(makeCar(),{steer:1},5);
 assert.equal(parked.distance,0);assert.equal(parked.speed,0);assert.equal(parked.yaw,0);
 const a=run(rolling(24),{throttle:.25,steer:.2},1),b=run(rolling(24),{throttle:.25,steer:1},1);
 assert.ok(a.yaw>0&&b.yaw>a.yaw*1.4,'analog steering preserves partial angle');
 run(b,{throttle:.1},2);assert.ok(Math.abs(b.steer)<1e-8);assert.ok(Math.abs(b.yawRate)<.03);
 assert.ok(steeringLock(60)<steeringLock(25)&&steeringLock(25)<steeringLock(5));
});

test('braking wins over throttle, stops without inversion, then reverse requires a hold',()=>{
 const s=rolling(20);run(s,{throttle:1,brake:1},4);
 assert.equal(s.speed,0);assert.equal(s.reverseHold,0);
 run(s,{brake:1},REVERSE_HOLD_SECONDS-1/60);assert.equal(s.speed,0);
 run(s,{brake:1},.1);assert.ok(s.speed<0&&s.speed>-.5);
 run(s,{brake:1},8);assert.ok(s.speed< -5&&s.speed>=-getCarTuning(s.carId).reverseSpeed);
 run(s,{throttle:1},3);assert.ok(s.speed>0,'forward throttle first stops reverse and then accelerates');
 const ai=rolling(25);run(ai,{brake:1,canReverse:false},10);assert.equal(ai.speed,0);assert.equal(ai.reverseHold,0);
});

test('engine braking slows a released accelerator without applying service brakes',()=>{
 const coast=rolling(28),powered=rolling(28);
 run(coast,{},2);run(powered,{throttle:.25},2);
 assert.ok(coast.speed<25&&coast.speed>20);
 assert.ok(powered.speed>coast.speed+3);
 assert.equal(coast.brake,0);assert.equal(coast.absActive,false);
});

test('opposite lock catches a handbrake slide in sport and expert modes',()=>{
 for(const assist of ['sport','expert']){
  const s=makeCar({assist});run(s,{throttle:1},5);run(s,{throttle:.5,steer:1,handbrake:true},.7);
  assert.ok(s.slip>.5,'a handbrake slide must be observable');
  const wrong=structuredClone(s);run(s,{throttle:.15,steer:-1},.7);run(wrong,{throttle:.15,steer:1},.7);
  assert.ok(Math.abs(s.slipAngle)<Math.abs(wrong.slipAngle)*.6,assist+' opposite lock reduces sideslip');
  run(s,{throttle:.15},3);
  assert.ok(Math.abs(s.slipAngle)<.01&&Math.abs(s.yawRate)<.03&&s.slip<.05,assist+' recovers without a heading reset');
 }
});

test('braking and cornering share the available grip and expert mode removes ABS',()=>{
 const gentle=rolling(30,{wetness:1}),hard=rolling(30,{wetness:1});
 run(gentle,{throttle:.1,steer:.8},.7);run(hard,{brake:1,steer:.8,canReverse:false},.7);
 assert.ok(hard.speed<gentle.speed-4);
 assert.ok(Math.abs(hard.lateralG)<Math.abs(gentle.lateralG), 'full braking leaves less lateral force');
 const expert=rolling(30,{wetness:1,assist:'expert'});run(expert,{brake:1,canReverse:false},.7);
 assert.equal(expert.absActive,false);assert.equal(expert.tcActive,false);
 assert.ok(expert.speed>hard.speed,'locked expert tires stop less efficiently than ABS');
});

test('all profiles and assist modes keep finite bounded telemetry through mixed inputs',()=>{
 for(const carId of Object.keys(CAR_TUNING))for(const assist of Object.keys(ASSIST_MODES)){
  const s=makeCar({carId,assist,wetness:1});
  for(let i=0;i<3600;i++){
   const phase=Math.floor(i/150)%8;
   drive(s,{throttle:phase<4?1:phase===7?.3:0,brake:phase===5?1:0,steer:Math.sin(i*.007),handbrake:phase===4,canReverse:false},1/120,flat);
   for(const key of ['x','z','speed','vx','vz','yaw','yawRate','slip','rpm','lateralG','longitudinalG','traction'])assert.ok(Number.isFinite(s[key]),carId+'/'+assist+'/'+key);
   assert.ok(s.slip>=0&&s.slip<=1&&s.traction>=0&&s.traction<=1);
   assert.ok(Math.abs(s.yawRate)<=1.65+1e-9);
   assert.ok(s.rpm>=getCarTuning(carId).idleRpm-1&&s.rpm<=getCarTuning(carId).redline*1.03);
  }
 }
});

test('automatic shifts have hysteresis and gear/RPM telemetry follows travel',()=>{
 const s=makeCar();run(s,{throttle:1},15);
 assert.ok(s.gear>=3&&s.gear<=6);assert.ok(s.shiftCount>=2);assert.ok(s.rpm>3000);
 const gear=s.gear;run(s,{throttle:.2},.25);assert.ok(Math.abs(s.gear-gear)<=1);
 run(s,{brake:1,canReverse:false},10);assert.equal(s.gear,0);
 run(s,{brake:1},1.5);assert.equal(s.gear,-1);
});

test('continuous wall collision and unsupported deck protection remain integrated',()=>{
 const wall=new CollisionWorld([[[20,-1,-50],[20,8,-50],[20,8,50]],[[20,-1,-50],[20,8,50],[20,-1,50]]]);
 const s=run(rolling(60),{throttle:1},.6,30,flat,wall);
 assert.ok(s.x<18,'front bumper must stop before wall');assert.ok(s.speed<1);assert.ok(s.contact?.kind==='wall');
 const cliff=rolling(20);run(cliff,{throttle:1},.5,120,{sample:()=>null});
 assert.equal(cliff.x,0);assert.equal(cliff.y,0);assert.ok(cliff.offroad>.49);assert.ok(cliff.speed<20);
 const bridge=new RoadSurface([[[0,10,0],[20,10,0],[20,10,20]],[[0,10,0],[20,10,20],[0,10,20]],[[0,0,0],[20,0,0],[20,0,20]],[[0,0,0],[20,0,20],[0,0,20]]]);
 assert.equal(bridge.sample(10,10,10),10);assert.equal(bridge.sample(10,10,0),0);
});
