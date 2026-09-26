import * as THREE from 'three';
import {loadTexture} from './asset-loading.js';

// Keep render meshes and collision in exactly the same world coordinates.
export function prepareTrack(root,scene){
 root.updateMatrixWorld(true);let correctedTriangles=0;const renderMeshes=[],sourceMeshes=[];
 root.traverse(o=>{if(o.isMesh)sourceMeshes.push(o);});const roadMaterial=sourceMeshes.map(o=>o.material).find(m=>m.name==='WetRoad');
 for(const mesh of sourceMeshes){
  const geo=mesh.geometry,positions=geo.attributes.position,normals=geo.attributes.normal,uv=geo.attributes.uv,index=geo.index,mat=mesh.material;
  const chunks=new Map(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const count=index?index.count:positions.count;
  for(let i=0;i<count;i+=3){
   const ids=[index?index.getX(i):i,index?index.getX(i+1):i+1,index?index.getX(i+2):i+2],vs=[a,b,c];
   for(let k=0;k<3;k++)vs[k].fromBufferAttribute(positions,ids[k]).applyMatrix4(mesh.matrixWorld);
   const u=(uv.getX(ids[0])+uv.getX(ids[1])+uv.getX(ids[2]))/3,t=(uv.getY(ids[0])+uv.getY(ids[1])+uv.getY(ids[2]))/3;
   const up=new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).normalize().y;
   const corrected=mat.name==='Atlas'&&up>.65&&u>.422&&u<.502&&t>.28&&t<.38;if(corrected)correctedTriangles++;const renderMaterial=corrected&&roadMaterial?roadMaterial:mat;
   const key=renderMaterial.name+'_'+Math.floor((a.x+b.x+c.x)/384)+','+Math.floor((a.z+b.z+c.z)/384);
   let chunk=chunks.get(key);if(!chunk){chunk={p:[],n:[],uv:[],material:renderMaterial};chunks.set(key,chunk);}
   for(let k=0;k<3;k++){chunk.p.push(vs[k].x,vs[k].y,vs[k].z);const n=new THREE.Vector3().fromBufferAttribute(normals,ids[k]).applyMatrix3(normalMatrix).normalize();chunk.n.push(n.x,n.y,n.z);chunk.uv.push(uv.getX(ids[k]),uv.getY(ids[k]));}
  }
  for(const [key,data] of chunks){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.p,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(data.n,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));g.computeBoundingSphere();const m=new THREE.Mesh(g,data.material);m.name='Track_'+mat.name+'_'+key;m.receiveShadow=true;scene.add(m);renderMeshes.push(m);}
  geo.dispose();
 }
 return {renderMeshes,correctedTriangles};
}

export async function loadSurfaceMaps(renderer){
 const loader=new THREE.TextureLoader(),maps={};
 await Promise.all(['asphalt','rock'].map(async kind=>{
  const results=await Promise.allSettled(['color','normal','roughness'].map(type=>loadTexture(loader,'./assets/'+kind+'-'+type+'.jpg')));
  const failed=results.filter(result=>result.status==='rejected');
  if(failed.length){
   for(const result of results)if(result.status==='fulfilled')result.value.dispose();
   maps[kind]=null;
   console.warn('Surface detail unavailable, keeping base material',kind,...failed.map(result=>result.reason.message));
   return;
  }
  maps[kind]=results.map(result=>result.value);
  maps[kind].forEach(t=>{t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());});
  maps[kind][0].colorSpace=THREE.SRGBColorSpace;
 }));
 return maps;
}

export function detailMaterial(mat,maps){
 const road=mat.name==='WetRoad',set=road?maps.asphalt:maps.rock;
 mat.side=THREE.DoubleSide;mat.roughness=road?.25:.8;mat.metalness=road?.08:0;mat.envMapIntensity=road?.55:.25;
 if(!road){mat.alphaTest=.42;mat.transparent=false;}
 // Detail textures are optional; preserve the track's embedded atlas on failure.
 if(!set)return;
 mat.onBeforeCompile=shader=>{
  shader.uniforms.detailColor={value:set[0]};shader.uniforms.detailNormal={value:set[1]};shader.uniforms.detailRough={value:set[2]};
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 stormWorld; varying vec3 stormNW;').replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nstormWorld=(modelMatrix*vec4(transformed,1.)).xyz;stormNW=normalize(mat3(modelMatrix)*objectNormal);');
  const common=`\nvarying vec3 stormWorld; varying vec3 stormNW; uniform sampler2D detailColor; uniform sampler2D detailNormal; uniform sampler2D detailRough;
   float rect(vec2 p,vec4 r){return step(r.x,p.x)*step(p.x,r.z)*step(r.y,p.y)*step(p.y,r.w);}
   vec4 triSample(sampler2D tex){vec3 w=pow(abs(stormNW),vec3(4.));w/=max(.001,w.x+w.y+w.z);return texture2D(tex,stormWorld.yz*.16)*w.x+texture2D(tex,stormWorld.xz*.16)*w.y+texture2D(tex,stormWorld.xy*.16)*w.z;}
  `;
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>'+common);
  if(road){
   shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\nfloat paint=smoothstep(.65,.86,max(diffuseColor.r,max(diffuseColor.g,diffuseColor.b)));float finishMark=rect(vMapUv,vec4(.603,.096,.702,.28));paint=max(paint,finishMark);diffuseColor.rgb=mix(diffuseColor.rgb,texture2D(detailColor,stormWorld.xz*.23).rgb*.65,.97*(1.-paint));')
    .replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nvec2 grain=texture2D(detailNormal,stormWorld.xz*.23).xy*2.-1.;normal=normalize(normal+mat3(viewMatrix)*vec3(grain.x,0.,grain.y)*.22);')
    .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nfloat puddle=sin(stormWorld.x*.72+sin(stormWorld.z*.41))*sin(stormWorld.z*.65);roughnessFactor=.13+.18*smoothstep(-.3,.55,puddle)+.16*texture2D(detailRough,stormWorld.xz*.23).r;');
  }else{
   // The original atlas mixes trees, signs, timber, rock and road. Only its rock regions receive detail.
   const mask='float rockMask=clamp(rect(vMapUv,vec4(.427,0.,.501,.28))+rect(vMapUv,vec4(.288,.476,.598,.568))+rect(vMapUv,vec4(.29,.384,.355,.475))+rect(vMapUv,vec4(.881,0.,.953,.843))+rect(vMapUv,vec4(0.,.852,.475,.913)),0.,1.);';
   shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\n'+mask+'diffuseColor.rgb=mix(diffuseColor.rgb,triSample(detailColor).rgb*.6,rockMask*.70);')
    .replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nvec3 rdetail=triSample(detailNormal).xyz*2.-1.;normal=normalize(normal+mat3(viewMatrix)*vec3(rdetail.x,rdetail.y,rdetail.x)*.17*rockMask);')
    .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.47+.4*triSample(detailRough).r,rockMask);');
  }
 };
 mat.customProgramCacheKey=()=>road?'storm-road-v2':'storm-rock-v2';
}

export class AdaptiveQuality {
 constructor(renderer){this.renderer=renderer;this.mode='balanced';this.scale=1;this.elapsed=0;this.total=0;this.frames=0;this.good=0;this.history=[];this.resetStats();}
 resetStats(){this.history=[];this.stutters=0;this.worst=0;this.runFrames=0;this.runSeconds=0;this.bins=new Uint32Array(1001);}
 set(mode){this.mode=mode;this.scale=mode==='high'?1.25:1;this.good=0;this.resize();}
 resize(){this.renderer.setPixelRatio(Math.min(devicePixelRatio,this.scale));this.renderer.setSize(innerWidth,innerHeight,false);}
 update(dt){if(!Number.isFinite(dt)||dt<=0)return;if(dt>.1)this.stutters++;this.worst=Math.max(this.worst,dt*1000);this.runFrames++;this.runSeconds+=dt;this.bins[Math.min(1000,Math.floor(dt*1000))]++;this.history.push(dt*1000);if(this.history.length>240)this.history.shift();this.elapsed+=dt;this.total+=dt;this.frames++;if(this.elapsed<2)return;
  const fps=this.frames/this.total;if(this.mode==='balanced'){if(fps<49&&this.scale>.65){this.scale=Math.max(.65,this.scale-.08);this.good=0;this.resize();}else if(fps>58){this.good+=2;if(this.good>=12&&this.scale<1){this.scale=Math.min(1,this.scale+.04);this.good=0;this.resize();}}else this.good=0;}this.elapsed=this.total=this.frames=0;
 }
 stats(){let count=0,p95=0;for(let i=0;i<this.bins.length;i++){count+=this.bins[i];if(count>=this.runFrames*.95){p95=i;break;}}return {p95,averageFps:this.runSeconds?this.runFrames/this.runSeconds:0,seconds:this.runSeconds,stutters:this.stutters,worst:this.worst,scale:this.scale,drawCalls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles};}
}
