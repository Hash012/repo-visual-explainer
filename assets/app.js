'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const statusLabels = {verified:'已验证', inferred:'推断', planned:'规划', blocked:'阻塞'};
  const statusColors = {verified:'#258676', inferred:'#537db6', planned:'#b48632', blocked:'#ba6155'};
  const kindLabels = {'public-interface':'公开接口','mutable-state':'可变状态',artifact:'产物',execution:'执行',ownership:'归属',data:'数据',call:'调用',invalidation:'失效'};
  const palette = ['#6397a9','#8d85b7','#75a293','#ba9970','#7993bd','#b9859d'];
  let atlas = null, view = null, selected = new Set(), box = null, baseBox = null;
  let busy = false, serverBusy = false, localBusy = false, polling = false, changed = new Set(), dragging = null, activeJob = null;
  let storedJob = null, sourceRequest = 0;
  try { storedJob = JSON.parse(sessionStorage.getItem('atlas-job') || 'null'); } catch (_) {}
  const svg = $('graph');
  const measurement = document.createElement('canvas').getContext('2d');
  function el(tag, className, content) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (content !== undefined) item.textContent = content;
    return item;
  }
  function shape(tag, attributes = {}, text) {
    const item = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function notify(text, error = false) {
    $('notice').textContent = text;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !text;
  }
  async function request(path, body) {
    const options = body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Atlas-Token':window.ATLAS_TOKEN}, body:JSON.stringify(body)};
    const response = await fetch(path, {...options, cache:'no-store'});
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) {
      throw new Error(`服务响应无法读取（HTTP ${response.status}）：${raw.slice(0, 240) || '空响应'}`);
    }
    if (!response.ok) {
      const reason = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : JSON.stringify(data);
      const error = new Error(`${response.status === 409 ? '版本已更新或有任务正在执行，请重新加载后重试。' : ''}${reason}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function setBusy(value, label) {
    busy = Boolean(value) || localBusy;
    $('submit').disabled = busy || !atlas;
    $('undo').disabled = busy || !atlas || atlas.revision === 0;
    $('modes').disabled = busy;
    $('job-status').textContent = label || (busy ? '任务执行中 · 可以继续浏览' : '就绪');
    // Drafts and browsing remain available; each request uses a frozen snapshot.
  }
  function hashState() {
    const params = new URLSearchParams(location.hash.slice(1));
    return {view:params.get('view'), elements:params.getAll('element')};
  }
  function writeHash(replace = false) {
    const params = new URLSearchParams({view:view.id});
    for (const id of selected) params.append('element', id);
    const hash = '#' + params.toString();
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  }
  function elements() { return [...view.nodes, ...view.edges]; }
  function navigate(viewId, ids = [], push = true, focus = true) {
    if (!atlas) return;
    const target = atlas.views.find(v => v.id === viewId) || atlas.views[0];
    const switching = !view || view.id !== target.id;
    view = target;
    const valid = new Set(elements().map(e => e.id));
    selected = new Set(ids.filter(id => valid.has(id)));
    renderGraph(switching);
    renderViews();
    renderInspector();
    if (focus && selected.size) focusSelection();
    if (push) writeHash();
  }
  function renderViews() {
    $('views').replaceChildren();
    atlas.views.forEach((v, index) => {
      const button = el('button','view-button' + (v.id === view.id ? ' active' : ''), v.title);
      button.type = 'button';
      button.setAttribute('aria-current', v.id === view.id ? 'page' : 'false');
      button.append(el('small','', `${String(index + 1).padStart(2,'0')} · ${v.nodes.length} 个节点 / ${v.edges.length} 条关系`));
      button.addEventListener('click', () => navigate(v.id));
      $('views').append(button);
    });
  }
  function color(kind) {
    let hash = 0;
    for (const c of kind) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
    return palette[(hash >>> 0) % palette.length];
  }
  function borderPoint(node, toward) {
    const center = {x:node.x + node.width / 2, y:node.y + node.height / 2};
    const dx = toward.x - center.x, dy = toward.y - center.y;
    const scale = Math.max(Math.abs(dx) / (node.width / 2), Math.abs(dy) / (node.height / 2));
    return scale ? {x:center.x + dx / scale, y:center.y + dy / scale} : center;
  }
  function route(edge) {
    const a = view.nodes.find(n => n.id === edge.source), b = view.nodes.find(n => n.id === edge.target);
    if (!a || !b) return [];
    const ac = {x:a.x+a.width/2,y:a.y+a.height/2}, bc = {x:b.x+b.width/2,y:b.y+b.height/2};
    if (edge.points.length) return [borderPoint(a,edge.points[0]), ...edge.points, borderPoint(b,edge.points.at(-1))];
    if (a.id === b.id) return [{x:a.x+a.width,y:ac.y},{x:a.x+a.width+22,y:ac.y},{x:a.x+a.width+22,y:a.y-18},{x:ac.x,y:a.y-18},{x:ac.x,y:a.y}];
    if (Math.abs(bc.x-ac.x) >= Math.abs(bc.y-ac.y)) {
      const leftToRight = bc.x >= ac.x;
      const start = {x:a.x+(leftToRight?a.width:0),y:ac.y}, end = {x:b.x+(leftToRight?0:b.width),y:bc.y};
      const middle = (start.x+end.x)/2;
      return [start,{x:middle,y:start.y},{x:middle,y:end.y},end];
    }
    const downward = bc.y >= ac.y;
    const start = {x:ac.x,y:a.y+(downward?a.height:0)}, end = {x:bc.x,y:b.y+(downward?0:b.height)};
    const middle = (start.y+end.y)/2;
    return [start,{x:start.x,y:middle},{x:end.x,y:middle},end];
  }
  // Fixed readable sizes; abbreviated visible text is available in full in the inspector.
  function readableLines(value,width,size,maxLines,weight=400) {
    measurement.font=`${weight} ${size}px system-ui`;
    if(maxLines<1 || measurement.measureText('…').width>width)return [];
    const lines=[];let line='';let truncated=false;
    for(const char of [...value.replace(/\s+/g,' ').trim()]) {
      if(measurement.measureText(line+char).width>width){
        if(!line || lines.length>=maxLines-1){truncated=true;break;}
        lines.push(line);line=char;
      }else line+=char;
    }
    if(truncated){while(line && measurement.measureText(line+'…').width>width)line=[...line].slice(0,-1).join('');line+='…';}
    lines.push(line);return lines;
  }
  function bindSelection(group, item) {
    group.setAttribute('tabindex', '0');
    group.setAttribute('role','button');
    group.setAttribute('aria-label', `${item.label || item.id}，${kindLabels[item.kind] || item.kind}，${statusLabels[item.status]}`);
    group.prepend(shape('title',{},item.label + (item.summary?' — '+item.summary:'')));
    group.dataset.element = item.id;
    group.classList.toggle('selected', selected.has(item.id));
    group.classList.toggle('changed', changed.has(`${view.id}:${item.id}`));
    group.setAttribute('aria-pressed', String(selected.has(item.id)));
    group.addEventListener('click', event => { event.stopPropagation(); select(item.id, event); });
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(item.id,event); }
    });
  }
  function select(id, event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
    } else selected = new Set([id]);
    updateSelection();
    renderInspector();
    writeHash();
  }
  function updateSelection() {
    svg.querySelectorAll('[data-element]').forEach(item => {
      item.classList.toggle('selected',selected.has(item.dataset.element));
      item.setAttribute('aria-pressed',String(selected.has(item.dataset.element)));
    });
    $('selection-count').textContent = selected.size ? `已选择 ${selected.size} 项` : '未选择';
  }
  function renderGraph(resetBox = false) {
    svg.replaceChildren();
    const defs = shape('defs');
    for (const [status,fill] of Object.entries(statusColors)) {
      const marker = shape('marker',{id:'arrow-'+status,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});
      marker.append(shape('path',{d:'M 0 0 L 10 5 L 0 10 z',fill}));defs.append(marker);
    }
    svg.append(defs);
    for (const g of view.groups) {
      const group = shape('g');
      group.append(shape('rect',{x:g.x,y:g.y,width:g.width,height:g.height,rx:12,fill:'#f5f8fa','fill-opacity':.7,stroke:'#dbe5eb','stroke-dasharray':'5 4'}));
      const lines = readableLines(g.label, Math.max(1,g.width-24),11,Math.min(2,Math.floor((g.height-8)/15)));
      const text = shape('text',{class:'group-label',style:'font-size:11px'});
      lines.forEach((line,i)=>text.append(shape('tspan',{x:g.x+12,y:g.y+17+i*15},line)));
      group.prepend(shape('title',{},g.label));
      group.append(text); svg.append(group);
    }
    for (const edge of view.edges) {
      const points = route(edge); if (points.length < 2) continue;
      const d = points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ');
      const group = shape('g',{class:'graph-edge'});
      group.append(shape('path',{d,class:'edge-visible',stroke:color(edge.kind),'marker-end':`url(#arrow-${edge.status})`,'stroke-dasharray':edge.status==='verified'?'':edge.status==='blocked'?'3 4':edge.status==='planned'?'8 3 2 3':'7 4'}));
      group.append(shape('path',{d,class:'edge-hit'}));
      // Put labels at the midpoint of the longest routed segment.
      let length = -1, mid = points[0];
      points.slice(1).forEach((p,i)=>{const prev=points[i], n=Math.hypot(p.x-prev.x,p.y-prev.y);if(n>length){length=n;mid={x:(p.x+prev.x)/2,y:(p.y+prev.y)/2};}});
      const lines = readableLines(edge.label,Math.max(1,Math.min(220,length-12)),11,2);
      const text = shape('text',{'text-anchor':'middle',style:`font-size:11px;fill:${color(edge.kind)}`});
      lines.forEach((line,i)=>text.append(shape('tspan',{x:mid.x,y:mid.y-7-(lines.length-1-i)*15},line)));
      group.append(text);
      bindSelection(group,edge);svg.append(group);
    }
    for (const node of view.nodes) {
      const group = shape('g',{class:'graph-node'});
      group.append(shape('rect',{x:node.x,y:node.y,width:node.width,height:node.height,rx:Math.min(10,node.height/5),fill:'#fff',stroke:color(node.kind),'stroke-width':1.6}));
      group.append(shape('circle',{cx:node.x+node.width-9,cy:node.y+9,r:3,fill:statusColors[node.status]}));
      const contentWidth=Math.max(1,node.width-28);
      const showSummary=Boolean(node.summary) && node.width>=130 && node.height>=88;
      const titleHeight=showSummary?Math.min(44,node.height*.4):Math.max(1,node.height-22);
      const titleMaxLines=Math.max(1,Math.floor(titleHeight/19));
      const titleLines=readableLines(node.label,contentWidth,14,titleMaxLines,600);
      const text=shape('text',{'font-size':14,'font-weight':600,'text-anchor':showSummary?'start':'middle'});
      const titleTop=showSummary?node.y+25:node.y+node.height/2-(titleLines.length-1)*19/2+5;
      titleLines.forEach((line,i)=>text.append(shape('tspan',{x:showSummary?node.x+14:node.x+node.width/2,y:titleTop+i*19},line)));
      if(showSummary){
        const summaryTop=titleTop+(titleLines.length-1)*19+25;
        const maxLines=Math.min(4,Math.floor((node.y+node.height-12-summaryTop)/17)+1);
        if(maxLines>0){
          const summary=shape('text',{'font-size':11.5,'font-weight':400,style:'fill:#687e8b'});
          readableLines(node.summary,contentWidth,11.5,maxLines).forEach((line,i)=>summary.append(shape('tspan',{x:node.x+14,y:summaryTop+i*17},line)));
          group.append(summary);
        }
      }
      group.append(text); bindSelection(group,node); svg.append(group);
    }
    $('view-title').textContent = view.title; $('view-question').textContent = view.question;
    $('view-summary').textContent = view.summary;
    $('view-notes').replaceChildren(...view.notes.map(note=>el('p','',note)));
    $('empty').hidden = view.nodes.length > 0;
    $('empty').textContent = '此视图还没有节点。可在“修改图谱”模式中提出补充要求。';
    $('legend').replaceChildren();
    for (const [status,label] of Object.entries(statusLabels)) {
      const item=el('span','legend-item');const dot=el('span','legend-dot');dot.style.background=statusColors[status];item.append(dot,el('span','',label));$('legend').append(item);
    }
    for(const kind of new Set(elements().map(e=>e.kind))) {const chip=el('span','legend-kind',kindLabels[kind]||kind);chip.style.borderColor=color(kind);$('legend').append(chip);}
    if(changed.size) $('legend').append(el('span','legend-kind','金色虚线 · 本次修改'));
    baseBox = {x:-24,y:-24,w:view.width+48,h:view.height+48};
    if (resetBox || !box) box={...baseBox};
    applyBox();updateSelection();
  }
  function applyBox() {
    if (!box) return;
    svg.setAttribute('viewBox',`${box.x} ${box.y} ${box.w} ${box.h}`);
    $('zoom-label').textContent = `${Math.round(baseBox.w/box.w*100)}%`;
  }
  function graphPoint(event) {
    const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    const matrix=svg.getScreenCTM();return matrix?point.matrixTransform(matrix.inverse()):{x:0,y:0};
  }
  function zoom(factor, anchor) {
    if(!box)return;
    const ratio=Math.max(.1,Math.min(16,baseBox.w/(box.w*factor)));
    factor=baseBox.w/ratio/box.w;
    const point=anchor||{x:box.x+box.w/2,y:box.y+box.h/2};
    box={x:point.x-(point.x-box.x)*factor,y:point.y-(point.y-box.y)*factor,w:box.w*factor,h:box.h*factor};applyBox();
  }
  function focusSelection() {
    const points=[];
    for(const item of elements().filter(e=>selected.has(e.id))) {
      if('x' in item) points.push({x:item.x,y:item.y},{x:item.x+item.width,y:item.y+item.height});else points.push(...route(item));
    }
    if(!points.length)return;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),minY=Math.min(...ys);
    const w=Math.max(240,Math.max(...xs)-minX+120),h=Math.max(180,Math.max(...ys)-minY+120);
    box={x:(minX+Math.max(...xs)-w)/2,y:(minY+Math.max(...ys)-h)/2,w,h};applyBox();
  }
  function renderInspector() {
    const content=$('inspector-content');content.replaceChildren();
    if(!selected.size){content.append(el('p','muted','点击节点或连线，阅读说明与源码依据。'));return;}
    for(const item of elements().filter(e=>selected.has(e.id))) {
      const card=el('article','detail-card');card.append(el('h3','',item.label||item.id));
      const meta=el('div','detail-meta');meta.append(el('span','',kindLabels[item.kind]||item.kind),el('span','',statusLabels[item.status]),el('span','',item.id));card.append(meta);
      if(item.summary)card.append(el('p','',item.summary));
      card.append(el('p','',item.detail||'暂无详细说明。'));
      if(item.source)card.append(el('p','muted',`${item.source} → ${item.target}`));
      item.evidence.forEach(evidence=>{
        const button=el('button','evidence-button',evidence.claim||'查看源码依据');button.append(el('span','',`${evidence.path}:${evidence.start}–${evidence.end}`));button.addEventListener('click',()=>showSource(evidence));card.append(button);
      });
      if(!item.evidence.length)card.append(el('p','muted','暂无源码引用；请结合事实状态判断。'));
      (item.links||[]).forEach(link=>{const button=el('button','cross-link',`↗ ${link.label}`);button.addEventListener('click',()=>navigate(link.view,link.element?[link.element]:[]));card.append(button);});
      content.append(card);
    }
  }
  async function showSource(evidence) {
    const serial=++sourceRequest;
    $('source-title').textContent=`${evidence.path}:${evidence.start}–${evidence.end}`;
    $('source-claim').textContent=evidence.claim;$('source-text').textContent='正在读取已引用的源码范围…';
    if(!$('source-dialog').open)$('source-dialog').showModal();
    try { const data=await request('/api/source?'+new URLSearchParams({path:evidence.path,start:evidence.start,end:evidence.end}));if(serial===sourceRequest)$('source-text').textContent=data.text; }
    catch(error){if(serial===sourceRequest)$('source-text').textContent=error.message;}
  }
  function renderMessages(messages) {
    const log=$('messages');const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<70;
    log.replaceChildren();
    if(!messages.length)log.append(el('p','muted','从一个节点、一条关系，或当前视图开始提问。回答会保留在这里。'));
    for(const message of messages)appendMessage(message,false);
    if(nearBottom)log.scrollTop=log.scrollHeight;
  }
  function appendMessage(message, scroll=true) {
    const entry=el('article','message '+(message.role==='user'?'user':message.role==='error'?'error':''));
    const who=message.role==='user'?'你':message.role==='error'?'任务错误':'Codex';
    const selection=message.selection;
    const ids=Array.isArray(selection)?selection:selection?.elements||[];
    const target=selection?.view||message.view;
    const meta=el('div','message-meta',`${who} · ${message.mode==='edit'?'修改图谱':'问答'}${message.revision!==undefined?` · r${message.revision}`:''}${ids.length?` · ${ids.length} 项选择`:''}`);
    entry.append(meta,el('div','',message.content||''));
    if(target){const button=el('button','quiet','定位提问上下文 ↗');button.addEventListener('click',()=>navigate(target,ids));entry.append(button);}
    if(message.role==='error' && message.question){
      const retry=el('button','quiet','重试此请求 ↗');
      retry.addEventListener('click',()=>{
        if(busy){notify('请等待当前任务完成后重试。');return;}
        navigate(message.view,message.elements||[]);
        const mode=document.querySelector(`input[name=mode][value=${message.mode==='edit'?'edit':'qa'}]`);mode.checked=true;
        $('modes').dispatchEvent(new Event('change'));$('question').value=message.question;$('question').focus();
      });entry.append(retry);
    }
    $('messages').append(entry);if(scroll)$('messages').scrollTop=$('messages').scrollHeight;
  }
  function compare(previous,next) {
    const result=new Set();
    if(!previous)return result;
    for(const v of next.views){const old=previous.views.find(x=>x.id===v.id);const before=new Map(old?[...old.nodes,...old.edges].map(x=>[x.id,JSON.stringify(x)]):[]);for(const item of [...v.nodes,...v.edges])if(before.get(item.id)!==JSON.stringify(item))result.add(`${v.id}:${item.id}`);}
    return result;
  }
  async function loadState({baseline=null, focus=false}={}) {
    const state=await request('/api/state');
    if(!state.atlas || !state.atlas.views?.length)throw new Error('服务没有返回可用图谱。');
    const prior=atlas;atlas=state.atlas;
    if(baseline)changed=compare(baseline,atlas);else if(prior && prior.revision!==atlas.revision)changed=compare(prior,atlas);
    $('atlas-title').textContent=atlas.title;$('atlas-summary').textContent=atlas.summary;document.title=atlas.title+' · 代码图谱';
    $('revision').textContent=`修订 r${atlas.revision}`;$('backend').textContent=`本地 · ${state.backend||'Codex'}`;
    $('export-json').disabled=false;$('export-svg').disabled=false;
    renderMessages(state.messages||[]);
    const hash=hashState();navigate(hash.view||view?.id||atlas.views[0].id,hash.elements,false,focus||!prior);
    writeHash(true);
    const job=typeof state.busy==='string'?state.busy:state.busy?.job;
    serverBusy=Boolean(state.busy);setBusy(serverBusy);
    return {state,job};
  }
  function saveJob(job) {storedJob=job;try{if(job)sessionStorage.setItem('atlas-job',JSON.stringify(job));else sessionStorage.removeItem('atlas-job');}catch(_) {}}
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function pollJob(job, snapshot) {
    if(polling)return;polling=true;activeJob=job;localBusy=true;setBusy(true);
    let failures=0;
    try{
      while(true){
        let result;
        try{result=await request('/api/jobs/'+encodeURIComponent(job));failures=0;}catch(error){
          if(error.status===404){saveJob(null);await loadState();throw error;}
          failures++;notify(`任务连接暂时中断，将自动重试：${error.message}`,true);await pause(Math.min(10000,1500*failures));continue;
        }
        if(result.status==='done'){
          await loadState({baseline:snapshot?.mode==='edit'?snapshot.baseline:null});
          // The canonical log is authoritative; append a fallback only if needed.
          if(result.answer && ![...$('messages').querySelectorAll('.message > div:not(.message-meta)')].some(n=>n.textContent===result.answer))appendMessage({role:'assistant',content:result.answer,...snapshot,revision:result.revision});
          notify(snapshot?.mode==='edit'?'图谱已更新；金色虚线标出新增或变化的元素。':'回答已完成。');saveJob(null);break;
        }
        if(result.status==='error'){
          await loadState();const errorText=typeof result.error==='string'?result.error:JSON.stringify(result.error||'任务失败');
          appendMessage({role:'error',content:errorText,...snapshot});notify(errorText,true);saveJob(null);break;
        }
        setBusy(true,result.status==='queued'?'任务已排队 · 可以继续浏览':'Codex 正在分析 · 可以继续浏览');await pause(1000);
      }
    }catch(error){notify(error.message,true);appendMessage({role:'error',content:error.message,...snapshot});}
    finally{polling=false;activeJob=null;localBusy=false;setBusy(serverBusy);if(serverBusy)watchBusy();}
  }
  async function watchBusy() {
    if(polling)return;
    try{const {state,job}=await loadState();if(job)await pollJob(job,storedJob?.job===job?storedJob.snapshot:undefined);else if(state.busy)setTimeout(watchBusy,1500);}catch(error){notify(error.message,true);setTimeout(watchBusy,3000);}
  }
  $('ask-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!atlas)return;
    const question=$('question').value.trim();if(!question)return;
    const snapshot={mode:document.querySelector('input[name=mode]:checked').value,view:view.id,elements:[...selected],question,revision:atlas.revision};
    const baseline=snapshot.mode==='edit'?structuredClone(atlas):null;
    localBusy=true;setBusy(true,'正在提交…');notify('');
    try{
      const {job}=await request('/api/ask',snapshot);if(!job)throw new Error('服务未返回任务编号。');
      const frozen={...snapshot,baseline};saveJob({job,snapshot:frozen});
      appendMessage({role:'user',content:question,...snapshot,selection:{view:snapshot.view,elements:snapshot.elements}});
      if($('question').value.trim()===question){$('question').value='';try{sessionStorage.removeItem('atlas-draft');}catch(_){}}
      await pollJob(job,frozen);
    }catch(error){notify(error.message,true);appendMessage({role:'error',content:error.message,...snapshot});localBusy=false;setBusy(false);if(error.status===409){const {state,job}=await loadState().catch(()=>({state:{}}));if(job)pollJob(job);else if(state.busy)watchBusy();}}
  });
  $('modes').addEventListener('change',()=>{$('mode-hint').textContent=document.querySelector('input[name=mode]:checked').value==='edit'?'修改当前视图；提交时冻结选择与修订版本。':'只解释，不改变图谱。';});
  $('undo').addEventListener('click',async()=>{
    if(busy||!atlas)return;localBusy=true;setBusy(true,'正在撤销…');
    try{await request('/api/undo',{revision:atlas.revision});await loadState();notify('已恢复上一版图谱，并生成新的修订。');}catch(error){notify(error.message,true);if(error.status===409)await loadState().catch(()=>{});}finally{localBusy=false;setBusy(serverBusy);if(serverBusy)watchBusy();}
  });
  function download(blob,filename){const url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('export-json').addEventListener('click',async()=>{try{const data=await request('/api/export');download(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}),'atlas.json');}catch(error){notify(error.message,true);}});
  $('export-svg').addEventListener('click',()=>{
    if(!view)return;const clone=svg.cloneNode(true);clone.setAttribute('xmlns',NS);clone.setAttribute('width',view.width+48);clone.setAttribute('height',view.height+48);clone.setAttribute('viewBox',`${baseBox.x} ${baseBox.y} ${baseBox.w} ${baseBox.h}`);
    clone.removeAttribute('id');clone.removeAttribute('class');
    const style=shape('style',{},'.edge-visible{fill:none;stroke-width:1.8}.edge-hit{display:none}.graph-edge text{font:11px system-ui;paint-order:stroke;stroke:#fff;stroke-width:5px}.graph-node text{font-family:system-ui,sans-serif;fill:#263d4d}.group-label{font:12px system-ui;fill:#8094a2}.selected rect,.selected .edge-visible{stroke:#087582;stroke-width:3}.changed rect,.changed .edge-visible{stroke:#bd7a19;stroke-width:3;stroke-dasharray:6 3}');clone.prepend(style);
    clone.querySelectorAll('[tabindex]').forEach(n=>n.removeAttribute('tabindex'));
    download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml'}),'atlas-view.svg');
  });
  $('close-source').addEventListener('click',()=>{$('source-dialog').close();sourceRequest++;});
  $('source-dialog').addEventListener('close',()=>sourceRequest++);
  $('clear-selection').addEventListener('click',()=>{if(!view)return;selected.clear();updateSelection();renderInspector();writeHash();});
  $('zoom-in').addEventListener('click',()=>zoom(.8));$('zoom-out').addEventListener('click',()=>zoom(1.25));
  $('fit').addEventListener('click',()=>{if(baseBox){box={...baseBox};applyBox();}});
  $('reset').addEventListener('click',()=>{if(view){selected.clear();box={...baseBox};applyBox();updateSelection();renderInspector();writeHash();}});
  svg.addEventListener('wheel',event=>{if(!box)return;event.preventDefault();zoom(Math.exp(event.deltaY*.001),graphPoint(event));},{passive:false});
  svg.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest('[data-element]')||!box)return;
    dragging={id:event.pointerId,point:graphPoint(event),initial:{...box},moved:false,startX:event.clientX,startY:event.clientY};svg.setPointerCapture(event.pointerId);svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove',event=>{if(!dragging||dragging.id!==event.pointerId)return;const p=graphPoint(event);dragging.moved ||= Math.hypot(event.clientX-dragging.startX,event.clientY-dragging.startY)>4;box.x+=dragging.point.x-p.x;box.y+=dragging.point.y-p.y;applyBox();});
  function stopDrag(event){if(!dragging||dragging.id!==event.pointerId)return;const clear=!dragging.moved&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.type!=='pointercancel';dragging=null;svg.classList.remove('dragging');if(clear){selected.clear();updateSelection();renderInspector();writeHash();}}
  svg.addEventListener('pointerup',stopDrag);svg.addEventListener('pointercancel',stopDrag);
  window.addEventListener('popstate',()=>{const h=hashState();navigate(h.view,h.elements,false);});
  window.addEventListener('hashchange',()=>{const h=hashState();navigate(h.view,h.elements,false);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('source-dialog').open&&view&&!['TEXTAREA','INPUT'].includes(event.target.tagName)){selected.clear();updateSelection();renderInspector();writeHash();}});
  let draftTimer;
  try{$('question').value=sessionStorage.getItem('atlas-draft')||'';}catch(_){}
  $('question').addEventListener('input',()=>{clearTimeout(draftTimer);draftTimer=setTimeout(()=>{try{sessionStorage.setItem('atlas-draft',$('question').value);}catch(_){}},200);});
  async function start(){try{const {state,job}=await loadState();const recovery=job||storedJob?.job;if(recovery)await pollJob(recovery,storedJob?.job===recovery?storedJob.snapshot:undefined);else if(state.busy)watchBusy();}catch(error){notify(error.message,true);$('view-title').textContent='连接失败';$('view-summary').textContent='请确认本地服务仍在运行；页面将在几秒后重试。';setTimeout(start,3000);}}
  start();
})();
