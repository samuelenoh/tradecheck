let JSDOM=null; try{ ({JSDOM}=require('jsdom')); }catch(e){}
const fs=require('fs');
const HTML=JSDOM?fs.readFileSync(require('path').join(__dirname,'..','public','index.html'),'utf8').replace(/<link[^>]*>/g,''):'';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function slot(price,fund,tiers,o){o=o||{};return {market:price==null?null:{mark:price,funding:fund},marketAt:1,marketAgeMs:o.marketAge??1000,marketStale:false,
  tiers:tiers?{unit:o.unit||'notional',tiers:tiers.map(t=>({...t,cap:t.cap===Infinity?null:t.cap}))}:null,tiersAt:1,tiersAgeMs:tiers?(o.tiersAge??1000):null,
  errors:o.errors||{market:null,tiers:tiers?null:'needs_api_key'},flags:[],attempted:{market:true,tiers:true}};}
function payload(coin,ex,spread){return {coin,now:Date.now(),exchanges:ex,spread:spread||{pct:0.01,mismatch:false}};}
async function buildPage(opts){
  opts=opts||{};
  const NOW=opts.now||Date.parse('2026-10-06T16:00:00Z');
  const st={es:[],nowRef:{t:NOW},errs:[],fetchLog:[]};
  const dom=new JSDOM(HTML,{runScripts:'dangerously',url:'https://x.test/',pretendToBeVisual:true,
    beforeParse(w){
      w.Date.now=()=>st.nowRef.t;
      const mode=opts.mode||'stream';
      w.fetch=async(url)=>{ const u=String(url); st.fetchLog.push(u);
        if(mode==='offline') throw new Error('blocked');
        const resp=b=>({ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>JSON.parse(JSON.stringify(b))});
        if(u.startsWith('api/health')) return resp({ok:true,binanceTiers:!!opts.binanceTiers,degraded:opts.degraded||[]});
        if(opts.fetchHandler) return opts.fetchHandler(u,resp);
        throw new Error('no handler '+u); };
      if(mode==='stream'){
        w.EventSource=class{constructor(url){this.url=url;this.l={};this.readyState=1;st.es.push(this);setTimeout(()=>this.onopen&&this.onopen(),0);}
          addEventListener(n,f){this.l[n]=f;} emit(n,d){this.l[n]&&this.l[n]({data:JSON.stringify(d,(k,v)=>v===Infinity?null:v)});} close(){this.readyState=2;}};
      }
      if(opts.preScript) opts.preScript(w);
      w.addEventListener('error',e=>st.errs.push(e.message));
    }});
  const w=dom.window,d=w.document;
  const api={dom,w,d,st,wait,
    txt:s=>{const e=d.querySelector(s);return e?e.textContent.replace(/\s+/g,' ').trim():null;},
    click:sel=>d.querySelector(sel).dispatchEvent(new w.Event('click',{bubbles:true})),
    setv:(id,v,ev)=>{const el=d.getElementById(id);el.value=v;el.dispatchEvent(new w.Event(ev||'input',{bubbles:true}));},
    emit:(n,data)=>st.es[st.es.length-1].emit(n,data),
    stats:()=>{const o={};d.querySelectorAll('#verdict .stats > div').forEach(x=>{o[x.querySelector('dt').textContent.trim()]=x.querySelector('dd').textContent.replace(/\s+/g,' ').trim();});return o;},
    cmpRow:label=>{const rows=[...d.querySelectorAll('#compare tbody tr')];const r=rows.find(x=>x.querySelector('th').textContent.trim()===label);return r?[...r.querySelectorAll('td')].map(x=>x.textContent.trim()):null;},
    checks:()=>[...d.querySelectorAll('#checks .check')].map(c=>({s:[...c.classList].find(x=>x.startsWith('s-')).slice(2),title:c.querySelector('h3').childNodes[0].textContent,msg:c.querySelector('.msg').textContent})),
    close:()=>w.close()};
  await wait(opts.settle??150);
  return api;
}
module.exports={buildPage,slot,payload,wait,get hasJsdom(){return !!JSDOM;}};
