// Matches the two BoxGeometry(.25,6,.25) posts and the
// BoxGeometry(.3,.45,width*2+1.5) crossbar in gateDecor().
// Coordinates share its rotation.y = -atan2(g.fz,g.fx), then world translation.
export function gateCollisionTriangles(g){
 const yaw=Math.atan2(g.fz,g.fx),co=Math.cos(yaw),si=Math.sin(yaw),triangles=[];
 const faces=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
 function box(cx,cy,cz,width,height,depth){
  const corners=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(([sx,sy,sz])=>{
   const x=cx+sx*width/2,y=cy+sy*height/2,z=cz+sz*depth/2;
   return [g.x+co*x-si*z,g.y+y,g.z+si*x+co*z];
  });
  for(const face of faces)triangles.push(face.map(i=>corners[i]));
 }
 for(const side of [-1,1])box(0,3,side*(g.width+.6),.25,6,.25);
 box(0,6,0,.3,.45,g.width*2+1.5);
 return triangles;
}
