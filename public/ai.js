import {clamp,angle,makeCar,drive,Lap,steeringLock} from './driving.js?v=3.1';

export const CAR_IDS=['Porsche992','Mercedes2005','Mercedes2018','MercedesGT3'];
// Difficulty changes the driver's decisions, never the car's physics or position.
export const AI_DIFFICULTIES=Object.freeze({
 club:Object.freeze({pace:.83,cornerGrip:8.3,brakePreview:7.5,headway:1.05,overtakeHold:2.2}),
 pro:Object.freeze({pace:.94,cornerGrip:9.4,brakePreview:8.1,headway:.78,overtakeHold:1.75}),
 elite:Object.freeze({pace:1,cornerGrip:10.3,brakePreview:8.7,headway:.6,overtakeHold:1.4})
});
const finite=(value,fallback=0)=>Number.isFinite(value)?value:fallback;
const modulo=(v,n)=>(v%n+n)%n;
const squared=(a,b)=>(a.x-b.x)**2+(a.z-b.z)**2+((a.y-b.y)*.5)**2;

/** A dense loop traced through the supplied road mesh, in metres. */
export class RaceRoute {
 constructor(data){
  this.points=data.points.map(p=>({x:p[0],y:p[1],z:p[2],width:p[3]}));this.distances=[];this.length=0;
  for(let i=0;i<this.points.length;i++){this.distances.push(this.length);const a=this.points[i],b=this.points[(i+1)%this.points.length];this.length+=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);}
  this.gateDistances=data.gateDistances.slice();this.gateDistances[0]=0;
 }
 at(distance){
  const s=modulo(distance,this.length),ds=this.distances;let lo=0,hi=ds.length-1;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ds[mid]<=s)lo=mid;else hi=mid-1;}
  const a=this.points[lo],b=this.points[(lo+1)%ds.length],len=(ds[lo+1]??this.length)-ds[lo],t=(s-ds[lo])/len,dx=b.x-a.x,dz=b.z-a.z,n=Math.hypot(dx,dz);
  return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,width:a.width+(b.width-a.width)*t,fx:dx/n,fz:dz/n,s};
 }
 curvature(s,span=18){const a=this.at(s-span),b=this.at(s),c=this.at(s+span),ab=Math.hypot(b.x-a.x,b.z-a.z),bc=Math.hypot(c.x-b.x,c.z-b.z),ac=Math.hypot(c.x-a.x,c.z-a.z);return 2*((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))/Math.max(.001,ab*bc*ac);}
 project(state,around=null,range=90){
  let best=null,score=Infinity;
  // Local projection avoids jumping between adjacent arms of a hairpin.
  const min=around===null?0:around-range,max=around===null?this.length:around+range;
  const first=around===null?0:Math.floor(modulo(min,this.length)/this.length*this.points.length)-3;
  const count=around===null?this.points.length:Math.ceil((max-min)/this.length*this.points.length)+8;
  for(let j=0;j<count;j++){
   const i=modulo(first+j,this.points.length),a=this.points[i],b=this.points[(i+1)%this.points.length],dx=b.x-a.x,dz=b.z-a.z,dy=b.y-a.y,l=dx*dx+dz*dz+dy*dy;
   const t=clamp(((state.x-a.x)*dx+(state.z-a.z)*dz+(state.y-a.y)*dy)/Math.max(.001,l),0,1),p={x:a.x+dx*t,y:a.y+dy*t,z:a.z+dz*t},d=squared(state,p);
   if(d<score){let s=this.distances[i]+Math.sqrt(l)*t;if(around!==null)s+=Math.round((around-s)/this.length)*this.length;score=d;best={...p,s,error:Math.sqrt(d),fx:dx/Math.hypot(dx,dz),fz:dz/Math.hypot(dx,dz)};}
  }
  return best;
 }
 legalProgress(state,lap){
  if(lap.finished)return this.length;
  if(!lap.started){const p=this.project(state,0,55);return clamp(p.s,-50,0);}
  const previous=lap.next===0?this.gateDistances.length-1:lap.next-1,a=this.gateDistances[previous],b=lap.next===0?this.length:this.gateDistances[lap.next];
  const p=this.project(state,(a+b)/2,(b-a)/2+15);return clamp(p.s,a,b-.001);
 }
}

/** Same inputs, acceleration, grip and collision system as the player's car. */
export class RivalRace {
 constructor({route,gates,road,playerId='Porsche992',spawn,collision=null,carDimensions={},difficulty='pro',wetness=1}){
  this.route=route instanceof RaceRoute?route:new RaceRoute(route);this.gates=gates;this.road=road;this.spawn=spawn;this.collision=collision;this.carDimensions=carDimensions;this.setDifficulty(difficulty);this.setWetness(wetness);this.reset(playerId);
 }
 setDifficulty(name){this.difficulty=Object.hasOwn(AI_DIFFICULTIES,name)?name:'pro';return this.difficulty;}
 setWetness(value){this.wetness=clamp(finite(Number(value),1),0,1);for(const racer of this.racers||[])racer.state.wetness=this.wetness;return this.wetness;}
 reset(playerId=this.playerId){
  this.playerId=playerId;this.time=0;this.playerFinishTime=null;this.pendingStep=null;
  this.racers=CAR_IDS.filter(id=>id!==playerId).map((id,i)=>{
   const g=this.gates[0],back=22+i*7,lane=(i%2?1:-1)*1.55,x=g.x-g.fx*back-g.fz*lane,z=g.z-g.fz*back+g.fx*lane,y=this.road.sample(x,z,g.y)??g.y;
   const state=makeCar({x,y,z,yaw:Math.atan2(g.fz,g.fx),carId:id,wetness:this.wetness,dimensions:this.carDimensions[id]||{halfLength:2.48,halfWidth:1.04,height:1.3}}),projection=this.route.project(state,0,60);
   return {id,state,lap:new Lap(this.gates),index:i,routeS:projection.s,lane,desiredLane:lane,laneHold:0,stalled:0,recoveries:0,finished:false,finishTime:null,elapsed:0,input:{throttle:0,brake:0,steer:0},topSpeed:[67,66,65][i],targetSpeed:0};
  });
 }
 recover(racer,reason='stuck'){
  const lap=racer.lap,previous=lap.next===0?this.gates.length-1:lap.next-1,s=lap.started?this.route.gateDistances[previous]+6:-22-racer.index*7,p=this.route.at(s);
  const y=this.road.sample(p.x,p.z,p.y)??p.y;
  Object.assign(racer.state,makeCar({x:p.x,y,z:p.z,yaw:Math.atan2(p.fz,p.fx),carId:racer.id,wetness:this.wetness,dimensions:racer.state.dimensions}));racer.routeS=s;racer.lane=0;racer.desiredLane=0;racer.laneHold=0;racer.stalled=0;racer.recoveries++;racer.recoveryFlash=1.2;racer.recoveryReason=reason;
 }
 controls(racer,traffic,dt){
  dt=clamp(finite(dt,1/120),0,.1);traffic=traffic||[];
  const s=racer.state,v=Math.max(0,finite(s.speed)),route=this.route,profile=AI_DIFFICULTIES[this.difficulty]||AI_DIFFICULTIES.pro;
  const projection=route.project(s,finite(racer.routeS),Math.max(55,v*1.5));racer.routeS=projection.s;
  const curve=route.curvature(projection.s+12),here=route.at(projection.s),halfWidth=s.dimensions?.halfWidth||1.04;
  const laneLimit=Math.max(0,Math.min(2.65,here.width-halfWidth-.5,route.at(projection.s+30).width-halfWidth-.5));
  const lateral=(s.x-here.x)*-here.fz+(s.z-here.z)*here.fx,nearby=[];
  let blocked=null;
  for(const other of traffic){
   if(other===s||Math.abs(other.y-s.y)>3||Math.hypot(other.x-s.x,other.z-s.z)>100)continue;
   const p=route.project(other,projection.s,100),ahead=p.s-projection.s;
   // Project onto the route to avoid braking for cars on the opposite hairpin.
   const otherLane=(other.x-p.x)*-p.fz+(other.z-p.z)*p.fx,clearance=halfWidth+(other.dimensions?.halfWidth||1.04)+.45;
   if(p.error>here.width+2)continue;
   const info={state:other,ahead,lane:otherLane,clearance,speed:Math.max(0,finite(other.speed))};nearby.push(info);
   if(ahead>0&&ahead<Math.max(42,v*1.6)&&Math.abs(otherLane-lateral)<clearance&&(!blocked||ahead<blocked.ahead))blocked=info;
  }
  racer.lane=finite(racer.lane,lateral);racer.desiredLane=finite(racer.desiredLane,racer.lane);racer.laneHold=Math.max(0,finite(racer.laneHold)-dt);
  const free=lane=>nearby.every(other=>{
   const rearGap=7+Math.max(0,other.speed-v)*1.5,frontGap=12+v*.6;
   if(other.ahead< -rearGap||other.ahead>frontGap)return true;
   // Check the whole merge path for vehicles alongside or closing from behind.
   const low=Math.min(lateral,lane)-other.clearance,high=Math.max(lateral,lane)+other.clearance;
   return other.ahead>8?Math.abs(other.lane-lane)>=other.clearance:other.lane<low||other.lane>high;
  });
  const apex=clamp(curve*28,-.7,.7),neutral=apex+(finite(racer.index,1)-1)*.12;
  let desired=racer.laneHold>0?racer.desiredLane:neutral;
  if(blocked&&laneLimit>1.2&&Math.abs(curve)<.035){
   const preferred=racer.desiredLane<0?-laneLimit:laneLimit;
   if(free(preferred))desired=preferred;else if(free(-preferred))desired=-preferred;else desired=racer.lane;
   if(Math.abs(desired-racer.desiredLane)>.5)racer.laneHold=profile.overtakeHold;
  }else if(racer.laneHold===0&&!free(desired))desired=racer.lane;
  racer.desiredLane=clamp(desired,-laneLimit,laneLimit);racer.lane+=clamp((racer.desiredLane-racer.lane)*1.6,-1.7,1.7)*dt;
  const look=clamp(7+v*.3,8,25),target=route.at(projection.s+look),offset=clamp(racer.lane,-Math.max(0,target.width-halfWidth-.4),Math.max(0,target.width-halfWidth-.4));
  const tx=target.x-target.fz*offset,tz=target.z+target.fx*offset,heading=Math.atan2(tz-(s.z+finite(s.vz)*.1),tx-(s.x+finite(s.vx)*.1)),alpha=angle(heading-s.yaw),distance=Math.hypot(tx-s.x,tz-s.z);
  const wheelAngle=Math.atan2(2*(s.dimensions?.wheelbase||2.8)*Math.sin(alpha),Math.max(3,distance)),lock=steeringLock(v),steer=clamp(wheelAngle/lock,-1,1);
  const wetGrip=1-clamp(finite(this.wetness,1),0,1)*.27,topSpeed=finite(racer.topSpeed,66)*profile.pace;
  // The physical brakes reach 11–13 m/s²; preview reserves grip for steering,
  // pedal ramp and wet roads instead of assuming maximum straight-line braking.
  const grip=Math.min(finite(racer.cornerGrip,profile.cornerGrip),profile.cornerGrip)*wetGrip,decel=profile.brakePreview*wetGrip;
  let targetSpeed=topSpeed;
  for(let d=0;d<=Math.max(90,v*v/(2*decel)+35);d+=6){const k=Math.abs(route.curvature(projection.s+d));const cornerSpeed=Math.min(topSpeed,Math.sqrt(grip/Math.max(.001,k)));targetSpeed=Math.min(targetSpeed,Math.sqrt(cornerSpeed*cornerSpeed+2*decel*Math.max(0,d-14)));}
  if(Math.abs(alpha)>.4)targetSpeed=Math.min(targetSpeed,Math.max(9,20/Math.abs(alpha)));
  if(projection.error>3.5)targetSpeed=Math.min(targetSpeed,16);
  if(blocked&&Math.abs(blocked.lane-lateral)<blocked.clearance){
   const length=(s.dimensions?.halfLength||2.4)+(blocked.state.dimensions?.halfLength||2.4),gap=Math.max(0,blocked.ahead-length),closing=Math.max(0,v-blocked.speed);
   const safeGap=2.5+v*profile.headway+closing*closing/(2*decel);
   targetSpeed=Math.min(targetSpeed,Math.max(0,blocked.speed+(gap-safeGap)*.7));
   if(gap<3||closing>0&&gap/closing<.75)targetSpeed=0;
  }
  racer.targetSpeed=targetSpeed;
  return {steer,throttle:v<targetSpeed+.3?clamp((targetSpeed-v)*.5,0,1):0,brake:v>targetSpeed+.5?clamp((v-targetSpeed)*.35,0,1):0,handbrake:false,canReverse:false};
 }
 step(dt,playerState,playerLap,{deferGates=false}={}){
  // Standalone callers retain the original all-in-one step. The renderer defers
  // gate checks until every vehicle has moved and car contacts are resolved.
  if(this.pendingStep)this.finalizeStep();
  this.time+=dt;
  if(playerLap?.finished&&this.playerFinishTime===null)this.playerFinishTime=this.time;
  const traffic=[...this.racers.filter(r=>!r.finished).map(r=>r.state),...(playerState?[playerState]:[])];
  const pending=[];
  for(const racer of this.racers){
   racer.recoveryFlash=Math.max(0,(racer.recoveryFlash||0)-dt);
   if(racer.finished){racer.input={throttle:0,brake:1,steer:0,canReverse:false};if(Math.abs(racer.state.speed)>.05)drive(racer.state,racer.input,dt,this.road,this.collision);else{racer.state.speed=0;racer.state.vx=0;racer.state.vz=0;}continue;}
   racer.state.wetness=this.wetness;
   const previous={x:racer.state.x,y:racer.state.y,z:racer.state.z};racer.input=this.controls(racer,traffic,dt);drive(racer.state,racer.input,dt,this.road,this.collision);racer.elapsed+=dt;
   pending.push({racer,previous});
  }
  this.pendingStep={dt,racers:pending};
  if(!deferGates)this.finalizeStep();
 }
 finalizeStep(){
  const pending=this.pendingStep;if(!pending)return;this.pendingStep=null;
  const {dt}=pending;
  for(const {racer,previous} of pending.racers){
   racer.lap.step(previous,racer.state,dt);
   if(racer.lap.finished){racer.finished=true;racer.finishTime=this.time;continue;}
   racer.stalled=Math.abs(racer.state.speed)<2&&racer.elapsed>5?racer.stalled+dt:0;
   const nextGate=!racer.lap.started?0:racer.lap.next===0?this.route.length:this.route.gateDistances[racer.lap.next];
   // A collision can push a car around a timing gate. Return behind that gate,
   // never let it circulate forever or award unearned checkpoint progress.
   if(racer.routeS>nextGate+35)this.recover(racer,'missed-checkpoint');
   else if(racer.state.offroad>1.1||racer.stalled>4.5)this.recover(racer);
  }
 }
 standings(playerState,playerLap){
  if(playerLap?.finished&&this.playerFinishTime===null)this.playerFinishTime=this.time;
  const entries=this.racers.map(r=>({id:r.id,player:false,finished:r.finished,finishTime:r.finishTime,progress:this.route.legalProgress(r.state,r.lap),time:r.lap.time}));
  entries.push({id:this.playerId,player:true,finished:playerLap.finished,finishTime:this.playerFinishTime,progress:this.route.legalProgress(playerState,playerLap),time:playerLap.time});
  entries.sort((a,b)=>a.finished&&b.finished?(a.finishTime-b.finishTime):(a.finished?-1:b.finished?1:b.progress-a.progress)||(a.player?-1:b.player?1:a.id.localeCompare(b.id)));
  return entries.map((entry,index)=>({...entry,rank:index+1}));
 }
}
