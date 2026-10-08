'use strict';
// Development-only comparison. All coordinates and identities are synthetic.
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
require('../assets/routing.js');
const node = (id,x,y,width=120,height=80) => ({id,x,y,width,height});
const edge = (id,source,target,points=[]) => ({id,source,target,points});
function originalRoute(v,e) {
  const a=v.nodes.find(n=>n.id===e.source),b=v.nodes.find(n=>n.id===e.target);
  const ac={x:a.x+a.width/2,y:a.y+a.height/2},bc={x:b.x+b.width/2,y:b.y+b.height/2};
  if(Math.abs(bc.x-ac.x)>=Math.abs(bc.y-ac.y)) {
    const right=bc.x>=ac.x,start={x:a.x+(right?a.width:0),y:ac.y},end={x:b.x+(right?0:b.width),y:bc.y},middle=(start.x+end.x)/2;
    return [start,{x:middle,y:start.y},{x:middle,y:end.y},end];
  }
  const down=bc.y>=ac.y,start={x:ac.x,y:a.y+(down?a.height:0)},end={x:bc.x,y:b.y+(down?0:b.height)},middle=(start.y+end.y)/2;
  return [start,{x:start.x,y:middle},{x:end.x,y:middle},end];
}
function crosses(points,n) {
  return points.slice(1).some((b,i)=> {
    const a=points[i];
    if(a.x===b.x)return a.x>n.x&&a.x<n.x+n.width&&Math.max(a.y,b.y)>n.y&&Math.min(a.y,b.y)<n.y+n.height;
    if(a.y===b.y)return a.y>n.y&&a.y<n.y+n.height&&Math.max(a.x,b.x)>n.x&&Math.min(a.x,b.x)<n.x+n.width;
    throw new Error('Default route must be orthogonal');
  });
}
const fixtures = [
  {id:'horizontal-obstacle',width:850,height:450,nodes:[node('a',40,180),node('block',300,160,150,120),node('b',650,180)],edges:[edge('flow','a','b')]},
  {id:'vertical-obstacle',width:450,height:850,nodes:[node('a',160,40),node('block',140,300,180,120),node('b',160,650)],edges:[edge('flow','a','b')]},
  {id:'parallel',width:850,height:450,nodes:[node('a',40,180),node('b',650,180)],edges:[edge('first','a','b'),edge('second','a','b'),edge('self','a','a')]},
];
let oldCrossings=0,newCrossings=0;
const started=performance.now();
for(const v of fixtures)for(const e of v.edges) {
  const route=AtlasRouting.route(v,e);
  assert.ok(route.length>=2);
  assert.deepEqual(route,AtlasRouting.route(v,e),'Cached routing must be deterministic');
  for(const n of v.nodes.filter(n=>n.id!==e.source&&n.id!==e.target)) {
    oldCrossings+=Number(crosses(originalRoute(v,e),n));
    newCrossings+=Number(crosses(route,n));
  }
  if(e.source!==e.target)assert.ok(route.every(p=>p.x>=0&&p.x<=v.width&&p.y>=0&&p.y<=v.height));
}
assert.equal(newCrossings,0,'Routes must avoid unrelated fixture nodes');
assert.ok(oldCrossings>newCrossings,'Fixed fixtures must demonstrate an improvement');
const parallel=fixtures[2];
assert.notDeepEqual(AtlasRouting.route(parallel,parallel.edges[0]),AtlasRouting.route(parallel,parallel.edges[1]));
const manual={id:'manual',width:850,height:450,nodes:[node('a',40,180),node('b',650,180)],edges:[edge('manual','a','b',[{x:200,y:100},{x:600,y:100}])]};
assert.deepEqual(AtlasRouting.route(manual,manual.edges[0]).slice(1,-1),manual.edges[0].points,'Valid authored route must survive');
console.log(JSON.stringify({fixtures:fixtures.length,edges:fixtures.reduce((n,v)=>n+v.edges.length,0),before_node_crossings:oldCrossings,after_node_crossings:newCrossings,elapsed_ms:Number((performance.now()-started).toFixed(2))},null,2));
