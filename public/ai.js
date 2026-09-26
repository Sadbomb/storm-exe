import {clamp,angle,makeCar,drive,Lap,steeringLock} from './driving.js';

export const CAR_IDS=['Porsche992','Mercedes2005','Mercedes2018','MercedesGT3'];
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
 constructor({route,gates,road,playerId='Porsche992',spawn,collision=null,carDimensions={}}){
  this.route=route instanceof RaceRoute?route:new RaceRoute(route);this.gates=gates;this.road=road;this.spawn=spawn;this.collision=collision;this.carDimensions=carDimensions;this.reset(playerId);
 }
 reset(playerId=this.playerId){
  this.playerId=playerId;this.time=0;this.playerFinishTime=null;this.pendingStep=null;
  this.racers=CAR_IDS.filter(id=>id!==playerId).map((id,i)=>{
   const g=this.gates[0],back=22+i*7,lane=(i%2?1:-1)*1.55,x=g.x-g.fx*back-g.fz*lane,z=g.z-g.fz*back+g.fx*lane,y=this.road.sample(x,z,g.y)??g.y;
   const state=makeCar({x,y,z,yaw:Math.atan2(g.fz,g.fx),dimensions:this.carDimensions[id]||{halfLength:2.48,halfWidth:1.04,height:1.3}}),projection=this.route.project(state,0,60);
   return {id,state,lap:new Lap(this.gates),index:i,routeS:projection.s,lane,desiredLane:lane,stalled:0,recoveries:0,finished:false,finishTime:null,elapsed:0,input:{throttle:0,brake:0,steer:0},topSpeed:[66,64,63][i],cornerGrip:[11.8,11.4,11.0][i],targetSpeed:0};
  });
 }
 recover(racer){
  const lap=racer.lap,previous=lap.next===0?this.gates.length-1:lap.next-1,s=lap.started?this.route.gateDistances[previous]+6:-22-racer.index*7,p=this.route.at(s);
  const y=this.road.sample(p.x,p.z,p.y)??p.y;
  Object.assign(racer.state,makeCar({x:p.x,y,z:p.z,yaw:Math.atan2(p.fz,p.fx),dimensions:racer.state.dimensions}));racer.routeS=s;racer.lane=0;racer.desiredLane=0;racer.stalled=0;racer.recoveries++;racer.recoveryFlash=1.2;
 }
 controls(racer,traffic,dt){
  const s=racer.state,v=Math.max(0,s.speed),route=this.route,projection=route.project(s,racer.routeS,55);racer.routeS=projection.s;
  const curve=route.curvature(projection.s+12),here=route.at(projection.s),laneLimit=Math.max(0,Math.min(2.25,here.width-1.55,route.at(projection.s+30).width-1.55));
  let desired=(racer.index-1)*.35,blocked=null;
  for(const other of traffic){
   if(other===s||Math.abs(other.y-s.y)>3)continue;
   const dx=other.x-s.x,dz=other.z-s.z,ahead=dx*projection.fx+dz*projection.fz,lateral=-dx*projection.fz+dz*projection.fx;
   if(ahead>0&&ahead<38+v*.25&&Math.abs(lateral)<2.4&&(!blocked||ahead<blocked.ahead))blocked={state:other,ahead,lateral};
  }
  if(blocked&&laneLimit>1.2){
   const left=-laneLimit,right=laneLimit;
   const free=lane=>traffic.every(other=>{if(other===s||Math.abs(other.y-s.y)>3)return true;const dx=other.x-here.x,dz=other.z-here.z,ahead=dx*here.fx+dz*here.fz,lateral=-dx*here.fz+dz*here.fx;return ahead< -8||ahead>42||Math.abs(lateral-lane)>=2.18;});
   const preferred=racer.desiredLane<0?left:right;
   if(free(preferred))desired=preferred;else if(free(-preferred))desired=-preferred;else desired=racer.lane;
  }
  if(Math.abs(curve)>.045)desired*=.25;
  racer.desiredLane=clamp(desired,-laneLimit,laneLimit);racer.lane+=(racer.desiredLane-racer.lane)*(1-Math.exp(-1.6*dt));
  const look=clamp(7+v*.3,8,25),target=route.at(projection.s+look),offset=clamp(racer.lane,-Math.max(0,target.width-1.45),Math.max(0,target.width-1.45));
  const tx=target.x-target.fz*offset,tz=target.z+target.fx*offset,heading=Math.atan2(tz-(s.z+s.vz*.08),tx-(s.x+s.vx*.08)),alpha=angle(heading-s.yaw),distance=Math.hypot(tx-s.x,tz-s.z);
  const wheelAngle=Math.atan2(2*2.8*Math.sin(alpha),Math.max(3,distance)),lock=steeringLock(v),steer=clamp(wheelAngle/lock,-1,1);
  let targetSpeed=racer.topSpeed;
  for(let d=0;d<=Math.max(90,v*v/15+30);d+=8){const k=Math.abs(route.curvature(projection.s+d));const cornerSpeed=Math.min(racer.topSpeed,Math.sqrt(racer.cornerGrip/Math.max(.001,k)));targetSpeed=Math.min(targetSpeed,Math.sqrt(cornerSpeed*cornerSpeed+2*7*Math.max(0,d-12)));}
  if(Math.abs(alpha)>.4)targetSpeed=Math.min(targetSpeed,Math.max(9,20/Math.abs(alpha)));
  if(projection.error>3.5)targetSpeed=Math.min(targetSpeed,16);
  if(blocked){const clearance=Math.abs(blocked.lateral);if(clearance<2.12||blocked.ahead<8)targetSpeed=Math.min(targetSpeed,Math.max(0,blocked.state.speed+(blocked.ahead-7-v*.2)*.55));}
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
   if(racer.state.offroad>1.1||racer.stalled>4.5)this.recover(racer);
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
