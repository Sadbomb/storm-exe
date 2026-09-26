// Continuous, two-sided scenery collision in metres. Rendering and physics share
// the imported track triangles; no invisible centreline or artificial road rails.
const EPS=1e-7,SKIN=.018;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
export const CAR_DIMENSIONS=Object.freeze({halfLength:2.2,halfWidth:.94,bottom:.19,height:1.2,wheelbase:2.65,trackWidth:1.62});
const dimensions=s=>({...CAR_DIMENSIONS,...s?.dimensions});

function clipHeight(poly,height,above){
 const out=[];
 for(let i=0;i<poly.length;i++){
  const a=poly[i],b=poly[(i+1)%poly.length],ia=above?a[1]>=height:a[1]<=height,ib=above?b[1]>=height:b[1]<=height;
  if(ia)out.push(a);
  if(ia!==ib){const t=(height-a[1])/(b[1]-a[1]);out.push([a[0]+(b[0]-a[0])*t,height,a[2]+(b[2]-a[2])*t]);}
 }
 return out;
}
function slabPolygon(t,bottom,top){
 if(t.maxY<=bottom+EPS||t.minY>=top-EPS)return null;
 let p=t.points;
 if(t.minY<bottom)p=clipHeight(p,bottom,true);
 if(t.maxY>top)p=clipHeight(p,top,false);
 return p.length>=2?p:null;
}
function axesFor(poly,co,si){
 const axes=[[co,si],[-si,co]];
 for(let i=0;i<poly.length;i++){
  const a=poly[i],b=poly[(i+1)%poly.length],dx=b[0]-a[0],dz=b[2]-a[2],len=Math.hypot(dx,dz);
  if(len<EPS)continue;
  const nx=-dz/len,nz=dx/len;
  if(!axes.some(a=>Math.abs(a[0]*nx+a[1]*nz)>.99999))axes.push([nx,nz]);
 }
 return axes;
}
// Sweep an oriented box against the polygon produced by a triangle/height-slab
// intersection. Continuous separating-axis times also catch zero-thickness walls.
function sweepPolygon(x,z,dx,dz,yaw,d,poly){
 const co=Math.cos(yaw),si=Math.sin(yaw),axes=axesFor(poly,co,si);
 let enter=-Infinity,leave=Infinity,hitNormal=null,inside=true,depth=Infinity,pushNormal=null;
 for(const [nx,nz] of axes){
  let lo=Infinity,hi=-Infinity;
  for(const v of poly){const p=v[0]*nx+v[2]*nz;lo=Math.min(lo,p);hi=Math.max(hi,p);}
  const radius=Math.abs(co*nx+si*nz)*d.halfLength+Math.abs(-si*nx+co*nz)*d.halfWidth;
  lo-=radius;hi+=radius;
  const p=x*nx+z*nz,v=dx*nx+dz*nz,a=p-lo,b=hi-p;
  if(a<0||b<0)inside=false;
  const penetration=Math.min(a,b);
  if(penetration<depth){depth=penetration;pushNormal=a<b?[-nx,-nz]:[nx,nz];}
  if(Math.abs(v)<EPS){if(p<lo-EPS||p>hi+EPS)return null;continue;}
  let t0=(lo-p)/v,t1=(hi-p)/v,normal=[-nx,-nz];
  if(t0>t1){[t0,t1]=[t1,t0];normal=[nx,nz];}
  if(t0>enter){enter=t0;hitNormal=normal;}
  leave=Math.min(leave,t1);
  if(enter>leave+EPS)return null;
 }
 if(inside&&depth>EPS)return {t:0,nx:pushNormal[0],nz:pushNormal[1],depth};
 if(enter< -EPS||enter>1+EPS||leave<0||!hitNormal)return null;
 if(dx*hitNormal[0]+dz*hitNormal[1]>=-EPS)return null;
 return {t:Math.max(0,enter),nx:hitNormal[0],nz:hitNormal[1],depth:0};
}

function segmentTriangle(a,delta,t){
 const [p,b,c]=t.points,e1=[b[0]-p[0],b[1]-p[1],b[2]-p[2]],e2=[c[0]-p[0],c[1]-p[1],c[2]-p[2]];
 const h=[delta[1]*e2[2]-delta[2]*e2[1],delta[2]*e2[0]-delta[0]*e2[2],delta[0]*e2[1]-delta[1]*e2[0]],det=e1[0]*h[0]+e1[1]*h[1]+e1[2]*h[2];
 if(Math.abs(det)<EPS)return null;
 const inv=1/det,s=[a[0]-p[0],a[1]-p[1],a[2]-p[2]],u=(s[0]*h[0]+s[1]*h[1]+s[2]*h[2])*inv;
 if(u<0||u>1)return null;
 const q=[s[1]*e1[2]-s[2]*e1[1],s[2]*e1[0]-s[0]*e1[2],s[0]*e1[1]-s[1]*e1[0]],v=(delta[0]*q[0]+delta[1]*q[1]+delta[2]*q[2])*inv;
 if(v<0||u+v>1)return null;
 const time=(e2[0]*q[0]+e2[1]*q[1]+e2[2]*q[2])*inv;
 return time>=0&&time<=1?time:null;
}

export class CollisionWorld {
 constructor(triangles=[],{cellSize=16,maxDriveableNormalY=.7}={}){
  this.size=cellSize;this.cells=new Map();this.triangles=[];this.wallCount=0;
  for(const points of triangles){
   if(points.length!==3||points.some(p=>p.length<3||p.some(v=>!Number.isFinite(v))))continue;
   const [a,b,c]=points,ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
   const nx=ab[1]*ac[2]-ab[2]*ac[1],ny=ab[2]*ac[0]-ab[0]*ac[2],nz=ab[0]*ac[1]-ab[1]*ac[0],len=Math.hypot(nx,ny,nz);
   if(len<1e-8)continue;
   const t={points,minX:Math.min(a[0],b[0],c[0]),maxX:Math.max(a[0],b[0],c[0]),minY:Math.min(a[1],b[1],c[1]),maxY:Math.max(a[1],b[1],c[1]),minZ:Math.min(a[2],b[2],c[2]),maxZ:Math.max(a[2],b[2],c[2]),wall:Math.abs(ny/len)<maxDriveableNormalY};
   const index=this.triangles.push(t)-1;if(t.wall)this.wallCount++;
   for(let x=Math.floor(t.minX/this.size);x<=Math.floor(t.maxX/this.size);x++)for(let z=Math.floor(t.minZ/this.size);z<=Math.floor(t.maxZ/this.size);z++){
    const key=x+','+z;if(!this.cells.has(key))this.cells.set(key,[]);this.cells.get(key).push(index);
   }
  }
 }
 query(minX,minZ,maxX,maxZ){
  const seen=new Set(),out=[];
  for(let x=Math.floor(minX/this.size);x<=Math.floor(maxX/this.size);x++)for(let z=Math.floor(minZ/this.size);z<=Math.floor(maxZ/this.size);z++)for(const i of this.cells.get(x+','+z)||[]){
   if(seen.has(i))continue;seen.add(i);const t=this.triangles[i];if(t.maxX>=minX&&t.minX<=maxX&&t.maxZ>=minZ&&t.minZ<=maxZ)out.push(t);
  }
  return out;
 }
 resolve(from,to,options={}){
  const d={...CAR_DIMENSIONS,...options},rotation=wrap((to.yaw??from.yaw??0)-(from.yaw??0)),steps=Math.max(1,Math.ceil(Math.abs(rotation)/.025));
  const dx=(to.x-from.x)/steps,dz=(to.z-from.z)/steps,radius=Math.hypot(d.halfLength,d.halfWidth)+SKIN;
  let x=from.x,z=from.z,yaw=from.yaw??0;const contacts=[];
  for(let s=0;s<steps;s++){
   const stepYaw=(from.yaw??0)+rotation*(s+1)/steps,bottom=Math.min(from.y,to.y)+d.bottom,top=Math.max(from.y,to.y)+d.height;
   const candidates=this.query(Math.min(x,x+dx)-radius,Math.min(z,z+dz)-radius,Math.max(x,x+dx)+radius,Math.max(z,z+dz)+radius).filter(t=>t.wall&&t.maxY>bottom&&t.minY<top);
   const polygons=candidates.map(t=>slabPolygon(t,bottom,top)).filter(Boolean);
   let remainingX=dx,remainingZ=dz,rotationBlocked=false;
   // Rotating into a wall must not teleport a stationary car sideways. Keep the
   // last safe heading, then sweep the requested translation at that heading.
   if(polygons.some(p=>{const h=sweepPolygon(x,z,0,0,stepYaw,d,p);return h&&h.depth>SKIN;}))rotationBlocked=true;
   if(!rotationBlocked)yaw=stepYaw;
   for(let iteration=0;iteration<5;iteration++){
    let earliest=null;
    for(const p of polygons){const h=sweepPolygon(x,z,remainingX,remainingZ,yaw,d,p);if(h&&(!earliest||h.t<earliest.t-EPS||(h.t===earliest.t&&h.depth>earliest.depth)))earliest=h;}
    if(!earliest){x+=remainingX;z+=remainingZ;break;}
    const h=earliest;
    if(h.depth>EPS){x+=h.nx*(h.depth+SKIN);z+=h.nz*(h.depth+SKIN);}
    else{x+=remainingX*h.t+h.nx*SKIN;z+=remainingZ*h.t+h.nz*SKIN;remainingX*=1-h.t;remainingZ*=1-h.t;}
    const closing=Math.min(0,remainingX*h.nx+remainingZ*h.nz);
    contacts.push({nx:h.nx,nz:h.nz,depth:h.depth});
    remainingX-=closing*h.nx;remainingZ-=closing*h.nz;
    if(Math.hypot(remainingX,remainingZ)<EPS&&h.depth<EPS)break;
   }
  }
  return {x,z,y:to.y,yaw,collided:contacts.length>0||Math.abs(wrap(yaw-(to.yaw??yaw)))>.001,contacts};
 }
 constrainCamera(from,to,radius=.25){
  const a=[from.x,from.y,from.z],delta=[to.x-from.x,to.y-from.y,to.z-from.z],length=Math.hypot(...delta);if(length<EPS)return {...to};
  const candidates=this.query(Math.min(a[0],to.x)-radius,Math.min(a[2],to.z)-radius,Math.max(a[0],to.x)+radius,Math.max(a[2],to.z)+radius);
  let time=1;
  for(const offset of [[0,0,0],[radius,0,0],[-radius,0,0],[0,radius,0],[0,-radius,0],[0,0,radius],[0,0,-radius]]){
   const origin=a.map((v,i)=>v+offset[i]);
   for(const triangle of candidates){const t=segmentTriangle(origin,delta,triangle);if(t!==null)time=Math.min(time,Math.max(0,t-radius/length));}
  }
  return {x:a[0]+delta[0]*time,y:a[1]+delta[1]*time,z:a[2]+delta[2]*time};
 }
}

function boxPolygon(s,d){const co=Math.cos(s.yaw),si=Math.sin(s.yaw);return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z])=>[s.x+co*x*d.halfLength-si*z*d.halfWidth,s.y,s.z+si*x*d.halfLength+co*z*d.halfWidth]);}
// Equal-mass, inelastic racer contact. Scenery is checked during separation so
// another car cannot push the player through an adjacent wall.
export function resolveCars(states,world=null){
 let count=0;
 for(let pass=0;pass<2;pass++)for(let i=0;i<states.length;i++)for(let j=i+1;j<states.length;j++){
  const a=states[i],b=states[j];if(!a||!b||Math.abs(a.y-b.y)>1.1)continue;
  const da=dimensions(a),db=dimensions(b),reach=Math.hypot(da.halfLength,da.halfWidth)+Math.hypot(db.halfLength,db.halfWidth);
  if(Math.hypot(a.x-b.x,a.z-b.z)>reach)continue;
  const h=sweepPolygon(a.x,a.z,0,0,a.yaw,da,boxPolygon(b,db));if(!h||h.depth<=.001)continue;
  const correction=(h.depth+SKIN)*.5;
  for(const [car,sign,d] of [[a,1,da],[b,-1,db]]){
   const target={...car,x:car.x+h.nx*correction*sign,z:car.z+h.nz*correction*sign},resolved=world?world.resolve(car,target,d):target;
   car.x=resolved.x;car.z=resolved.z;
  }
  const relative=(a.vx-b.vx)*h.nx+(a.vz-b.vz)*h.nz,impulse=Math.max(0,-relative)*.53;
  a.vx+=h.nx*impulse;a.vz+=h.nz*impulse;b.vx-=h.nx*impulse;b.vz-=h.nz*impulse;
  for(const [car,sign] of [[a,1],[b,-1]]){
   car.speed=car.vx*Math.cos(car.yaw)+car.vz*Math.sin(car.yaw);
   car.contact={nx:h.nx*sign,nz:h.nz*sign,impact:Math.max(car.contact?.impact||0,-relative),kind:'car'};
  }
  count++;
 }
 return count;
}
