import {CAR_DIMENSIONS} from './collision.js?v=3.1';
import {getCarTuning,ASSIST_MODES} from './vehicle-tuning.js?v=3.1';
export {getCarTuning,ASSIST_MODES} from './vehicle-tuning.js?v=3.1';
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const angle=x=>Math.atan2(Math.sin(x),Math.cos(x));
// Representative dry-road service brake deceleration (m/s²), also used by AI.
export const SERVICE_BRAKE_DECEL=12.2;
export const REVERSE_HOLD_SECONDS=.45;
// Shared by physics, AI inverse steering and the visible front wheels. Keyboard
// full lock approaches the useful tire range as speed rises; analog input can
// still meter any angle below it. This is a wheel angle, never a yaw command.
export const steeringLock=speed=>{
 const v=Math.abs(speed);
 return Math.min(.62/(1+v/28),.018+Math.atan2(2.8*13,Math.max(25,v*v)));
};
export const steeringYawLimit=speed=>Math.min(1.65,18/Math.max(7,Math.abs(speed)));
const G=9.81,STEP=1/120;
const finite=(value,fallback=0)=>Number.isFinite(value)?value:fallback;
const approach=(value,target,rate,dt)=>value+(target-value)*(1-Math.exp(-rate*dt));
export class RoadSurface {
 constructor(triangles){this.cells=new Map();this.triangles=triangles;this.size=24;for(const t of triangles){const xs=t.map(p=>p[0]),zs=t.map(p=>p[2]);for(let x=Math.floor(Math.min(...xs)/24);x<=Math.floor(Math.max(...xs)/24);x++)for(let z=Math.floor(Math.min(...zs)/24);z<=Math.floor(Math.max(...zs)/24);z++){const k=x+','+z;if(!this.cells.has(k))this.cells.set(k,[]);this.cells.get(k).push(t);}}}
 sample(x,z,y=0,maxStep=8){let best=null,delta=Infinity;for(const t of this.cells.get(Math.floor(x/24)+','+Math.floor(z/24))||[]){const [a,b,c]=t,den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(den)<1e-8)continue;const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den;if(u>=-.00002&&v>=-.00002&&u+v<=1.00002){const h=u*a[1]+v*b[1]+(1-u-v)*c[1];if(Math.abs(h-y)<delta){delta=Math.abs(h-y);best=h;}}}return delta<maxStep?best:null;}
 footprint(x,z,y,yaw,dimensions={}){
  const d={...CAR_DIMENSIONS,...dimensions},co=Math.cos(yaw),si=Math.sin(yaw),halfBase=d.wheelbase/2,halfTrack=d.trackWidth/2;
  const center=this.sample(x,z,y,1.6),wheels=[];
  for(const longitudinal of [halfBase,-halfBase])for(const lateral of [-halfTrack,halfTrack])wheels.push(this.sample(x+co*longitudinal-si*lateral,z+si*longitudinal+co*lateral,y,2.1));
  const valid=wheels.filter(h=>h!==null);if(center===null||valid.length<3)return null;
  const average=(a,b)=>a===null?b:b===null?a:(a+b)/2;
  const front=average(wheels[0],wheels[1]),rear=average(wheels[2],wheels[3]),left=average(wheels[0],wheels[2]),right=average(wheels[1],wheels[3]);
  const pitch=Math.atan2(front-rear,d.wheelbase),roll=Math.atan2(right-left,d.trackWidth);
  // Reject cliffs, deck jumps and single-wheel heights from an adjacent wall.
  if(Math.abs(pitch)>.55||Math.abs(roll)>.5||valid.some(h=>Math.abs(h-center)>1.35))return null;
  return {y:center,pitch,roll,supportedWheels:valid.length};
 }
}
export function makeCar(spawn={}){
 const tuning=getCarTuning(spawn.carId),wetness=clamp(finite(spawn.wetness,.75),0,1);
 return {...spawn,x:finite(spawn.x),y:finite(spawn.y),z:finite(spawn.z),yaw:finite(spawn.yaw),carId:tuning.id,assist:ASSIST_MODES[spawn.assist]?spawn.assist:'sport',wetness,
  speed:0,vx:0,vz:0,steer:0,steerAngle:0,offroad:0,distance:0,pitch:0,roll:0,contact:null,reverseHold:0,
  yawRate:0,lateralSpeed:0,lateralG:0,longitudinalG:0,loadTransfer:0,
  throttle:0,brake:0,slip:0,slipAngle:0,traction:1,absActive:false,tcActive:false,
  rpm:tuning.idleRpm,gear:0,shiftTimer:0,shiftCount:0,frontSlip:0,rearSlip:0};
}

function transmission(s,t,dt){
 const v=Math.abs(s.speed),old=s.gear;
 if(s.speed<-.12)s.gear=-1;
 else if(v<.12&&s.throttle<.02)s.gear=0;
 else{
  if(s.gear<1)s.gear=1;
  // Hysteresis prevents repeated up/down changes during partial throttle.
  const top=t.gearSpeeds[s.gear-1];
  if(v>top*.94&&s.gear<t.gearSpeeds.length)s.gear++;
  else if(s.gear>1&&v<t.gearSpeeds[s.gear-2]*.70)s.gear--;
 }
 if(old>0&&s.gear>0&&old!==s.gear){s.shiftTimer=t.shiftTime;s.shiftCount++;}
 s.shiftTimer=Math.max(0,s.shiftTimer-dt);
 const ratio=s.gear>0?v/t.gearSpeeds[s.gear-1]:s.gear<0?v/t.reverseSpeed:0;
 const launch=s.throttle*Math.max(0,1-v/7)*.35;
 const rpm=t.idleRpm+(t.redline-t.idleRpm)*clamp(Math.max(ratio,launch),0,1.025);
 s.rpm=approach(s.rpm,rpm,18,dt);
}

/**
 * Substepped two-axle simcade model. World velocity and body heading are separate:
 * the tires generate lateral acceleration, and axle moments generate yaw. No
 * velocity snap to a desired heading, so lift-off, trail braking and opposite
 * lock all have an observable effect. Forces below are mass-normalized (m/s²).
 */
function stepCar(s,input,dt,road,collision,t,assist){
 const previousYaw=s.yaw,previousX=s.x,previousZ=s.z,co=Math.cos(s.yaw),si=Math.sin(s.yaw);
 let u=s.vx*co+s.vz*si,lateral=-s.vx*si+s.vz*co;
 const speed=Math.abs(u),rawThrottle=clamp(finite(input.throttle),0,1),rawBrake=clamp(finite(input.brake),0,1);
 s.throttle=approach(s.throttle,rawBrake?0:rawThrottle,rawThrottle>s.throttle?10:20,dt);
 s.brake=approach(s.brake,rawBrake,rawBrake>s.brake?22:30,dt);
 const requestedSteer=clamp(finite(input.steer),-1,1),counter=requestedSteer*s.steer<0;
 const returning=Math.abs(requestedSteer)<Math.abs(s.steer),rate=counter?10:returning?12:7.5;
 s.steer=approach(s.steer,requestedSteer,rate*assist.steeringResponse,dt);
 // Restore steering range when applying opposite lock to a real slide. A
 // high-speed steering limit must not prevent the driver from catching it.
 const counterRange=s.steer*s.slipAngle>0?clamp(Math.abs(s.slipAngle)-.04,0,.42):0;
 const delta=clamp(s.steer*(steeringLock(speed)+counterRange),-.68,.68);s.steerAngle=delta;
 const wheelbase=t.wheelbase,
  frontArm=wheelbase*(1-t.frontWeight),rearArm=wheelbase*t.frontWeight;
 // Aerodynamic load and pitch transfer make fast corners and trail braking
 // behave differently from slow corners without turning the car into a rail.
 const aero=t.downforce*speed*speed,normal=G+aero;
 const transferTarget=clamp(-s.longitudinalG*t.cgHeight/wheelbase,-.16,.19);
 s.loadTransfer=approach(s.loadTransfer,transferTarget,7,dt);
 const frontWeight=clamp(t.frontWeight+s.loadTransfer,.28,.72),mu=t.grip*(1-s.wetness*.27),
  loadSensitivity=1-Math.min(.065,Math.abs(s.lateralG)*.022),
  frontCap=normal*frontWeight*mu*loadSensitivity,rearCap=normal*(1-frontWeight)*mu*loadSensitivity;
 const frontVelocity=lateral+frontArm*s.yawRate,denominator=Math.max(4,speed);
 const frontAngle=Math.atan2(frontVelocity*Math.cos(delta)-u*Math.sin(delta),Math.max(4,Math.abs(u*Math.cos(delta)+frontVelocity*Math.sin(delta)))),
  rearAngle=Math.atan2(lateral-rearArm*s.yawRate,denominator);
 const tire=(alpha,stiffness,cap)=>{
  // Smooth transition through the peak rather than an abrupt grip/no-grip switch.
  const falloff=1-clamp((Math.abs(alpha)-.16)*.65,0,assist.slideLoss);
  return -cap*Math.tanh(alpha*stiffness/Math.max(.1,cap))*falloff;
 };
 const pureFront=tire(frontAngle,t.frontStiffness,frontCap),pureRear=tire(rearAngle,t.rearStiffness,rearCap);
 let demanded=0,braking=false,stopHold=false,reverse=false;
 if(rawBrake>.001){
  if(u>.035||rawThrottle>0||input.canReverse===false){
   braking=true;demanded=-Math.sign(u)*t.brakeDecel*s.brake;s.reverseHold=0;
   if(Math.abs(u)<=.035)stopHold=true;
  }else if(u<-.035){
   reverse=true;demanded=-t.reverseAccel*s.brake*Math.max(0,1-speed/t.reverseSpeed);
  }else{
   s.reverseHold=Math.min(REVERSE_HOLD_SECONDS,s.reverseHold+dt);
   stopHold=s.reverseHold+1e-8<REVERSE_HOLD_SECONDS;
   reverse=!stopHold;if(reverse)demanded=-t.reverseAccel*s.brake;
  }
 }else{
  s.reverseHold=0;
  if(rawThrottle>.001){
   if(u<-.035){braking=true;demanded=t.brakeDecel*s.throttle;}
   else demanded=t.engineAccel*(1-.65*clamp(speed/t.maxSpeed,0,1))*s.throttle*(s.shiftTimer>0?.22:1);
  }else if(speed>.015){
   // Closed-throttle engine braking gives lift-off a clear, controllable effect.
   demanded=-Math.sign(u)*(t.engineBraking+speed*.012);
  }
 }
 const drag=speed>.015?Math.sign(u)*(t.rollingDrag+t.drag*speed*speed):0;
 let frontX=braking?demanded*t.brakeBalance:0,rearX=braking?demanded*(1-t.brakeBalance):demanded;
 const frontBudget=Math.sqrt(Math.max(0,frontCap*frontCap-(pureFront*.82)**2)),
  rearBudget=Math.sqrt(Math.max(0,rearCap*rearCap-(pureRear*.82)**2));
 s.absActive=braking&&assist.abs&&(Math.abs(frontX)>frontBudget||Math.abs(rearX)>rearBudget)&&speed>2;
 s.tcActive=!braking&&!reverse&&demanded>rearBudget&&assist.tc&&speed>.5;
 const wheelspin=!braking&&demanded>rearBudget?clamp((demanded-rearBudget)/Math.max(1,rearBudget),0,1):0,
  frontLocked=braking&&!assist.abs&&Math.abs(frontX)>frontBudget,
  rearLocked=braking&&!assist.abs&&Math.abs(rearX)>rearBudget;
 frontX=clamp(frontX,-frontBudget*(frontLocked?.82:1),frontBudget);
 rearX=clamp(rearX,-rearBudget*(rearLocked?.82:1),rearBudget*(!assist.tc&&wheelspin>0?.84:1));
 if(input.handbrake){rearX=-Math.sign(u)*Math.min(rearCap*.85,4.2);if(speed<.035)stopHold=true;}
 const frontRemaining=Math.sqrt(Math.max(.05,frontCap*frontCap-frontX*frontX)),
  rearRemaining=Math.sqrt(Math.max(.05,rearCap*rearCap-rearX*rearX));
 let frontY=clamp(pureFront,-frontRemaining,frontRemaining)*(frontLocked?.30:1),
  rearY=clamp(pureRear,-rearRemaining,rearRemaining)*(input.handbrake?.22:rearLocked?.32:1)*(!assist.tc?1-wheelspin*.20:1);
 // Body lateral force remains bounded by the combined tire friction circle.
 const frontLateral=frontY*Math.cos(delta)+frontX*Math.sin(delta),
  ax=frontX*Math.cos(delta)-frontY*Math.sin(delta)+rearX-drag-G*Math.sin(s.pitch||0),ay=frontLateral+rearY;
 const yawAcceleration=(frontLateral*frontArm-rearY*rearArm)/t.yawInertia;
 const geometricYaw=u/wheelbase*Math.tan(delta),gripYaw=(frontCap+rearCap)/Math.max(4,speed),
  stableYaw=clamp(geometricYaw,-gripYaw,gripYaw),
  slipAngle=Math.atan2(lateral,Math.max(2,speed));
 s.yawRate+=yawAcceleration*dt;
 // Selectable stability assistance damps excess rotation. It never changes
 // world velocity, and handbrake deliberately relaxes it for controlled slides.
 const stability=input.handbrake?.3:assist.stability;
 s.yawRate+=((stableYaw-s.yawRate)*.50+slipAngle*2.0)*stability*dt;
 const lowSpeed=clamp((6-speed)/4,0,1);
 s.yawRate=approach(s.yawRate,geometricYaw,lowSpeed*12,dt);
 s.yawRate=clamp(s.yawRate,-steeringYawLimit(speed),steeringYawLimit(speed));
 let nextU=u+ax*dt;
 if((braking||input.handbrake||(!rawThrottle&&!rawBrake))&&u*nextU<0)nextU=0;
 if(stopHold||(!rawThrottle&&!rawBrake&&speed<.025))nextU=0;
 nextU=clamp(nextU,-t.reverseSpeed,t.maxSpeed);
 // Integrating in world space avoids the energy gain common to explicit body
 // coordinate Coriolis updates. Rolling resistance brings an unattended car to rest.
 s.vx+=(ax*co-ay*si)*dt;s.vz+=(ax*si+ay*co)*dt;
 const correction=nextU-(s.vx*co+s.vz*si);s.vx+=correction*co;s.vz+=correction*si;
 s.yaw=angle(s.yaw+s.yawRate*dt);
 if(lowSpeed>0){
  const nc=Math.cos(s.yaw),ns=Math.sin(s.yaw),lv=-s.vx*ns+s.vz*nc;
  const damp=1-Math.exp(-lowSpeed*14*dt);s.vx+=ns*lv*damp;s.vz-=nc*lv*damp;
 }
 if(stopHold&&Math.hypot(s.vx,s.vz)<.08){s.vx=s.vz=s.yawRate=0;}
 s.speed=s.vx*Math.cos(s.yaw)+s.vz*Math.sin(s.yaw);
 s.lateralSpeed=-s.vx*Math.sin(s.yaw)+s.vz*Math.cos(s.yaw);
 s.slipAngle=Math.atan2(s.lateralSpeed,Math.max(2,Math.abs(s.speed)));
 s.longitudinalG=approach(s.longitudinalG,ax/G,10,dt);
 s.lateralG=approach(s.lateralG,ay/G,10,dt);
 s.frontSlip=clamp(Math.abs(frontAngle)/.14,0,1);s.rearSlip=clamp(Math.abs(rearAngle)/.14,0,1);
 s.slip=approach(s.slip,clamp(Math.max((Math.abs(frontAngle)-.055)/.24,(Math.abs(rearAngle)-.055)/.24,wheelspin*(assist.tc?.25:1),input.handbrake&&speed>4?.75:0),0,1),12,dt);
 s.traction=clamp(1-Math.hypot(ax,ay)/Math.max(1,frontCap+rearCap),0,1);
 let nx=s.x+s.vx*dt,nz=s.z+s.vz*dt;
 const support=(x,z)=>road.footprint?road.footprint(x,z,s.y,s.yaw,s.dimensions):((h)=>h===null?null:{y:h,pitch:0,roll:0})(road.sample(x,z,s.y,1.6));
 let ground=support(nx,nz);
 if(s.contact){s.contact.impact*=Math.exp(-10*dt);if(s.contact.impact<.05)s.contact=null;}
 if(collision){
  const result=collision.resolve({x:s.x,y:s.y,z:s.z,yaw:previousYaw},{x:nx,y:ground?.y??s.y,z:nz,yaw:s.yaw},s.dimensions);
  nx=result.x;nz=result.z;
  if(Math.abs(angle(result.yaw-s.yaw))>.001)s.yawRate*=.4;
  s.yaw=angle(result.yaw);
  for(const contact of result.contacts){
   const closing=s.vx*contact.nx+s.vz*contact.nz;
   if(closing<0){
    s.vx-=closing*contact.nx;s.vz-=closing*contact.nz;
    const severity=Math.abs(closing),drag=severity>2?.985:1;s.vx*=drag;s.vz*=drag;s.yawRate*=Math.exp(-severity*.06);
    s.speed=s.vx*Math.cos(s.yaw)+s.vz*Math.sin(s.yaw);
    if(!s.contact||severity>s.contact.impact)s.contact={nx:contact.nx,nz:contact.nz,impact:severity,kind:'wall'};
   }
  }
  ground=support(nx,nz);
 }
 if(ground===null){
  // Retain bridge/deck support semantics: do not teleport down a cliff.
  s.offroad+=dt;s.vx*=Math.exp(-3*dt);s.vz*=Math.exp(-3*dt);s.yaw=previousYaw;s.yawRate*=Math.exp(-6*dt);
  s.speed=s.vx*Math.cos(s.yaw)+s.vz*Math.sin(s.yaw);
 }else{
  s.x=nx;s.z=nz;s.y=ground.y;s.pitch=ground.pitch;s.roll=ground.roll;s.offroad=0;s.distance+=Math.hypot(s.x-previousX,s.z-previousZ);
 }
 transmission(s,t,dt);
}

export function drive(s,input={},dt,road,collision=null){
 // Equal 120 Hz substeps make 30/60/120 Hz callers share the same tire behavior.
 // A long background-tab pause must not simulate seconds of unseen driving.
 dt=clamp(finite(dt),0,.1);if(!dt)return;
 if(input.assist&&ASSIST_MODES[input.assist])s.assist=input.assist;
 if(Number.isFinite(input.wetness))s.wetness=clamp(input.wetness,0,1);
 s.wetness=clamp(finite(s.wetness,.75),0,1);
 const t=getCarTuning(s.carId),assist=ASSIST_MODES[s.assist]||ASSIST_MODES.sport,steps=Math.ceil(dt/STEP),step=dt/steps;
 for(let i=0;i<steps;i++)stepCar(s,input,step,road,collision,t,assist);
}
export class Lap {
 constructor(gates){this.gates=gates;this.reset();}
 reset(){this.next=0;this.started=false;this.finished=false;this.time=0;this.passed=0;}
 step(prev,s,dt){if(this.finished)return false;if(this.started)this.time+=dt;const g=this.gates[this.next],dx=s.x-g.x,dz=s.z-g.z;const a=(prev.x-g.x)*g.fx+(prev.z-g.z)*g.fz,b=dx*g.fx+dz*g.fz;
  if(a<=0&&b>0&&Math.abs(-dx*g.fz+dz*g.fx)<g.width&&Math.abs(s.y-g.y)<4){if(this.next===0){if(this.started){this.finished=true;this.passed=this.gates.length;return true;}this.started=true;this.time=0;}this.next=(this.next+1)%this.gates.length;this.passed=this.next===0?this.gates.length-1:this.next-1;return true;}return false;
 }
}
export const timeText=s=>{const ms=Math.floor(s*1000);return String(Math.floor(ms/60000)).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');};
