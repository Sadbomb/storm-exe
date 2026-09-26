import {CAR_DIMENSIONS} from './collision.js';
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const angle=x=>Math.atan2(Math.sin(x),Math.cos(x));
export const SERVICE_BRAKE_DECEL=28;
export const REVERSE_HOLD_SECONDS=.45;
// Shared by player physics, AI inverse steering and visible front wheels.
// The speed cap keeps keyboard steering stable without forcing wide-radius
// corners at normal racing speeds (about 32 m at 100 km/h).
export const steeringLock=speed=>.65/(1+Math.abs(speed)/23);
export const steeringYawLimit=speed=>Math.min(1.55,24/Math.max(10,Math.abs(speed)));
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
export function makeCar(spawn){return {...spawn,speed:0,vx:0,vz:0,steer:0,offroad:0,distance:0,pitch:0,roll:0,contact:null,reverseHold:0};}
export function drive(s,input,dt,road,collision=null){
 dt=clamp(dt,0,1/30);const v=Math.abs(s.speed), throttle=clamp(input.throttle||0,0,1),brake=clamp(input.brake||0,0,1);
 const old=s.speed;
 let accel=0,serviceBraking=false,stopHold=false;
 if(brake){
  // Brake always wins over the accelerator. AI uses a brake-only pedal.
  if(old>0||throttle||input.canReverse===false){
   serviceBraking=true;accel=-Math.sign(old)*SERVICE_BRAKE_DECEL*brake;s.reverseHold=0;
   if(old===0)stopHold=true;
  }else if(old<-.02){
   accel=-4*(1+Math.min(old,0)/10)*brake;
  }else{
   // Holding S first holds a complete stop, then deliberately selects reverse.
   s.reverseHold=Math.min(REVERSE_HOLD_SECONDS,(s.reverseHold||0)+dt);
   stopHold=s.reverseHold+1e-8<REVERSE_HOLD_SECONDS;
   if(!stopHold)accel=-4*brake;
  }
 }else{
  s.reverseHold=0;
  if(throttle){
   serviceBraking=old<0;
   accel=(old<0?SERVICE_BRAKE_DECEL:8.8*(1-Math.max(0,old)/78))*throttle;
  }else accel=-Math.sign(old)*(0.65+v*v*.00065);
 }
 if(input.handbrake){accel-=Math.sign(old)*18;if(v<.02)stopHold=true;}
 s.speed=stopHold?0:clamp(old+accel*dt,-10,78);
 if(old*s.speed<0&&(serviceBraking||input.handbrake||(!throttle&&!brake)))s.speed=0;
 // Decelerate the actual travel velocity too; a zero speedometer must not
 // leave the car sliding forwards through the old velocity smoothing tail.
 if(serviceBraking||input.handbrake||stopHold){
  const ratio=v>.0001?Math.min(1,Math.abs(s.speed)/v):0;
  s.vx*=ratio;s.vz*=ratio;
 }
 const requestedSteer=clamp(input.steer||0,-1,1),returning=requestedSteer===0||(requestedSteer*s.steer>=0&&Math.abs(requestedSteer)<Math.abs(s.steer));
 s.steer+=(requestedSteer-s.steer)*(1-Math.exp(-(returning?18:13)*dt));
 const lock=steeringLock(v),yawLimit=steeringYawLimit(v),yawRate=clamp(s.speed/2.8*Math.tan(s.steer*lock),-yawLimit,yawLimit);
 const previousYaw=s.yaw,previousX=s.x,previousZ=s.z;
 s.yaw=angle(s.yaw+yawRate*dt*(input.handbrake?1.35:1));
 const grip=1-Math.exp(-(serviceBraking?24:input.handbrake?2.6:10)*dt);
 s.vx+=(Math.cos(s.yaw)*s.speed-s.vx)*grip;s.vz+=(Math.sin(s.yaw)*s.speed-s.vz)*grip;
 let nx=s.x+s.vx*dt,nz=s.z+s.vz*dt;
 const support=(x,z)=>road.footprint?road.footprint(x,z,s.y,s.yaw,s.dimensions):((h)=>h===null?null:{y:h,pitch:0,roll:0})(road.sample(x,z,s.y,1.6));
 let ground=support(nx,nz);
 if(s.contact){s.contact.impact*=Math.exp(-10*dt);if(s.contact.impact<.05)s.contact=null;}
 if(collision){
  const result=collision.resolve({x:s.x,y:s.y,z:s.z,yaw:previousYaw},{x:nx,y:ground?.y??s.y,z:nz,yaw:s.yaw},s.dimensions);
  nx=result.x;nz=result.z;s.yaw=angle(result.yaw);
  for(const contact of result.contacts){
   const closing=s.vx*contact.nx+s.vz*contact.nz;
   if(closing<0){
    s.vx-=closing*contact.nx;s.vz-=closing*contact.nz;
    const severity=Math.abs(closing),drag=severity>2?.985:1;s.vx*=drag;s.vz*=drag;
    s.speed=s.vx*Math.cos(s.yaw)+s.vz*Math.sin(s.yaw);
    if(!s.contact||severity>s.contact.impact)s.contact={nx:contact.nx,nz:contact.nz,impact:severity,kind:'wall'};
   }
  }
  ground=support(nx,nz);
 }
 if(ground===null){
  // Hold the last supported footprint while slowing; the caller may recover
  // after sustained loss of support. Never snap down onto a lower bridge deck.
  s.offroad+=dt;s.speed*=Math.exp(-2.4*dt);s.vx*=Math.exp(-3*dt);s.vz*=Math.exp(-3*dt);s.yaw=previousYaw;
 }else{
  s.x=nx;s.z=nz;s.y=ground.y;s.pitch=ground.pitch;s.roll=ground.roll;s.offroad=0;s.distance+=Math.hypot(s.x-previousX,s.z-previousZ);
 }
}
export class Lap {
 constructor(gates){this.gates=gates;this.reset();}
 reset(){this.next=0;this.started=false;this.finished=false;this.time=0;this.passed=0;}
 step(prev,s,dt){if(this.finished)return false;if(this.started)this.time+=dt;const g=this.gates[this.next],dx=s.x-g.x,dz=s.z-g.z;const a=(prev.x-g.x)*g.fx+(prev.z-g.z)*g.fz,b=dx*g.fx+dz*g.fz;
  if(a<=0&&b>0&&Math.abs(-dx*g.fz+dz*g.fx)<g.width&&Math.abs(s.y-g.y)<4){if(this.next===0){if(this.started){this.finished=true;this.passed=this.gates.length;return true;}this.started=true;this.time=0;}this.next=(this.next+1)%this.gates.length;this.passed=this.next===0?this.gates.length-1:this.next-1;return true;}return false;
 }
}
export const timeText=s=>{const ms=Math.floor(s*1000);return String(Math.floor(ms/60000)).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');};
