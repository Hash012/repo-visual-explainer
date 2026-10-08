'use strict';
// Pure geometry: routing never writes node positions or persisted manual points.
globalThis.AtlasRouting = (() => {
  let signature = '', cache = new Map(), diagnostics = new Map();
  const center = n => ({x:n.x+n.width/2,y:n.y+n.height/2});
  function segmentClear(a,b,rects) {
    return !rects.some(r => {
      if(a.x===b.x)return a.x>r.x && a.x<r.right && Math.max(a.y,b.y)>r.y && Math.min(a.y,b.y)<r.bottom;
      if(a.y===b.y)return a.y>r.y && a.y<r.bottom && Math.max(a.x,b.x)>r.x && Math.min(a.x,b.x)<r.right;
      // Slab intersection for manually supplied diagonal segments.
      let lo=0,hi=1;
      for(const [p,d,min,max] of [[a.x,b.x-a.x,r.x,r.right],[a.y,b.y-a.y,r.y,r.bottom]]) {
        if(!d){if(p<=min || p>=max)return false;continue;}
        const t1=(min-p)/d,t2=(max-p)/d;lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));
      }
      return lo<hi && hi>0 && lo<1;
    });
  }
  function border(n,p) {
    const c=center(n),dx=p.x-c.x,dy=p.y-c.y,s=Math.max(Math.abs(dx)/(n.width/2),Math.abs(dy)/(n.height/2));
    return s?{x:c.x+dx/s,y:c.y+dy/s}:c;
  }
  function simplify(points) {
    const out=[];
    for(const p of points){const a=out.at(-2),b=out.at(-1);if(b && b.x===p.x && b.y===p.y)continue;if(a && ((a.x===b.x && b.x===p.x)||(a.y===b.y && b.y===p.y)))out.pop();out.push(p);}
    return out;
  }
  function route(view,edge) {
    const key=JSON.stringify([view.id,view.nodes.map(n=>[n.id,n.x,n.y,n.width,n.height]),view.edges.map(e=>[e.id,e.source,e.target,e.points])]);
    if(key!==signature){signature=key;cache.clear();diagnostics.clear();}if(cache.has(edge.id))return cache.get(edge.id);
    const a=view.nodes.find(n=>n.id===edge.source),b=view.nodes.find(n=>n.id===edge.target);if(!a||!b)return [];
    const raw=view.nodes.filter(n=>n.id!==a.id && n.id!==b.id).map(n=>({x:n.x,y:n.y,right:n.x+n.width,bottom:n.y+n.height}));
    const allRects=view.nodes.map(n=>({x:n.x,y:n.y,right:n.x+n.width,bottom:n.y+n.height}));
    const manual=edge.points||[];
    if(manual.length){const p=[border(a,manual[0]),...manual,border(b,manual.at(-1))];if(p.slice(1).every((v,i)=>segmentClear(p[i],v,allRects))){cache.set(edge.id,p);return p;}}
    const peers=view.edges.filter(e=>(e.source===a.id&&e.target===b.id)||(e.source===b.id&&e.target===a.id)).sort((x,y)=>x.id.localeCompare(y.id));
    const lane=(peers.findIndex(e=>e.id===edge.id)-(peers.length-1)/2)*8;
    function ports(n){const c=center(n),dx=Math.max(-n.width/2+4,Math.min(n.width/2-4,lane)),dy=Math.max(-n.height/2+4,Math.min(n.height/2-4,lane));return [{p:{x:n.x+n.width,y:c.y+dy},q:{x:n.x+n.width+12,y:c.y+dy},dir:1},{p:{x:n.x,y:c.y+dy},q:{x:n.x-12,y:c.y+dy},dir:1},{p:{x:c.x+dx,y:n.y+n.height},q:{x:c.x+dx,y:n.y+n.height+12},dir:2},{p:{x:c.x+dx,y:n.y},q:{x:c.x+dx,y:n.y-12},dir:2}];}
    const starts=a.id===b.id?ports(a).slice(0,1):ports(a),ends=a.id===b.id?ports(b).slice(3):ports(b),rects=view.nodes.map(n=>({x:n.x-10,y:n.y-10,right:n.x+n.width+10,bottom:n.y+n.height+10}));
    const xs=[...new Set([...rects.flatMap(r=>[r.x-2,r.right+2]),...starts.map(p=>p.q.x),...ends.map(p=>p.q.x)])].sort((a,b)=>a-b);
    const ys=[...new Set([...rects.flatMap(r=>[r.y-2,r.bottom+2]),...starts.map(p=>p.q.y),...ends.map(p=>p.q.y)])].sort((a,b)=>a-b);
    function fallback(reason){
      diagnostics.set(edge.id,reason);
      const ac=center(a),bc=center(b),p=[border(a,bc),border(b,ac)];
      const result=a.id!==b.id && segmentClear(p[0],p[1],allRects)?p:[];
      cache.set(edge.id,result);return result;
    }
    if(xs.length*ys.length>10000)return fallback('连线 '+edge.id+' 的路由网格超过上限；请提供可用的手动控制点或简化当前视图。');
    const point=i=>({x:xs[i%xs.length],y:ys[Math.floor(i/xs.length)]});
    const index=p=>ys.indexOf(p.y)*xs.length+xs.indexOf(p.x);
    const dist=new Map(),prev=new Map(),origin=new Map(),queue=[];
    // Binary heap keeps bounded searches responsive on larger synthetic views.
    function push(k,cost){let i=queue.length;queue.push({k,cost});while(i){const parent=(i-1)>>1;if(queue[parent].cost<cost || (queue[parent].cost===cost&&queue[parent].k<=k))break;queue[i]=queue[parent];i=parent;}queue[i]={k,cost};}
    function pop(){const top=queue[0],last=queue.pop();if(queue.length){let i=0;while(i*2+1<queue.length){let j=i*2+1;if(j+1<queue.length&&(queue[j+1].cost<queue[j].cost||(queue[j+1].cost===queue[j].cost&&queue[j+1].k<queue[j].k)))j++;if(last.cost<queue[j].cost||(last.cost===queue[j].cost&&last.k<=queue[j].k))break;queue[i]=queue[j];i=j;}queue[i]=last;}return top;}
    starts.forEach((p,i)=>{if(!segmentClear(p.p,p.q,allRects))return;const k=index(p.q)*3+p.dir;dist.set(k,12);origin.set(k,i);push(k,12);});
    let goal=null,endPort=null;
    let iterations=0;
    while(queue.length){
      if(++iterations>24000)return fallback('连线 '+edge.id+' 的路由搜索超过上限；请提供手动控制点。');const entry=pop(),k=entry.k;if(entry.cost!==dist.get(k))continue;const i=Math.floor(k/3),direction=k%3,p=point(i);
      const end=ends.find(e=>index(e.q)===i && segmentClear(e.q,e.p,allRects));
      if(end){goal=k;endPort=end;break;}
      const x=i%xs.length,y=Math.floor(i/xs.length);
      for(const j of [x>0?i-1:-1,x<xs.length-1?i+1:-1,y>0?i-xs.length:-1,y<ys.length-1?i+xs.length:-1]){
        if(j<0)continue;const q=point(j);if(!segmentClear(p,q,rects))continue;
        const d=p.x===q.x?2:1,next=j*3+d,cost=dist.get(k)+Math.abs(p.x-q.x)+Math.abs(p.y-q.y)+(direction!==d?18:0);
        if(cost<(dist.get(next)??Infinity)){dist.set(next,cost);prev.set(next,k);origin.set(next,origin.get(k));push(next,cost);}
      }
    }
    let result=[];
    if(goal!==null){let k=goal;while(k!==undefined){result.unshift(point(Math.floor(k/3)));k=prev.get(k);}result=simplify([starts[origin.get(goal)].p,...result,endPort.p]);}
    // Overlapping nodes can have no free ports. Keep a visible minimal connection.
    else return fallback('连线 '+edge.id+' 没有可用的避障路径；节点可能重叠。无法安全绘制的连线暂时隐藏，可在对象详情查看。');
    cache.set(edge.id,result);return result;
  }
  return {route,getDiagnostics:()=>[...diagnostics].map(([edge,message])=>({edge,message}))};
})();
