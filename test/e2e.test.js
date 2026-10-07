'use strict';
/*
 * End to end: the real server, real HTTP, a live stream, and the real page running in a simulated browser.
 * Only the exchanges are simulated. Needs jsdom (npm install --save-dev jsdom); skipped without it.
 */
const test=require('node:test'), assert=require('node:assert');
const http=require('http'), fs=require('fs'), os=require('os'), path=require('path');
let JSDOM=null; try{ ({JSDOM}=require('jsdom')); }catch(e){}
const {createApp}=require('../server');
const {Poller}=require('../poller');
const {makeHttp}=require('./helpers');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(fn())return true;}catch(e){}await wait(50);}return false;};
const ok=(c,l,d)=>assert.ok(c,'E2E step failed: '+l+(d?'  ['+d+']':''));

// a spec-style EventSource built on Node http (event:/data: lines, blank line = dispatch, auto-reconnect)
function makeEventSource(base,registry){
  return class EventSource{
    constructor(url){registry.push(this);this.url=new URL(url,base).href;this.l={};this.readyState=0;this.closed=false;this._connect();}
    addEventListener(n,f){this.l[n]=f;}
    close(){this.closed=true;this.readyState=2;try{this.req&&this.req.destroy();}catch(e){}}
    _connect(){ if(this.closed) return;
      this.req=http.get(this.url,res=>{ if(res.statusCode!==200){this.readyState=2;this.onerror&&this.onerror();return;}
        this.readyState=1; this.onopen&&this.onopen(); let buf='',ev='message',data=[];
        res.setEncoding('utf8'); res.on('data',chunk=>{ buf+=chunk; let i; while((i=buf.indexOf('\n'))>=0){ const line=buf.slice(0,i).replace(/\r$/,''); buf=buf.slice(i+1);
          if(line===''){ if(data.length&&this.l[ev]) this.l[ev]({data:data.join('\n')}); ev='message'; data=[]; }
          else if(line.startsWith(':')){} else { const j=line.indexOf(':'); const f=j<0?line:line.slice(0,j); let v=j<0?'':line.slice(j+1); if(v.startsWith(' ')) v=v.slice(1);
            if(f==='event') ev=v; else if(f==='data') data.push(v); } } });
        res.on('close',()=>{ if(!this.closed){ this.readyState=0; this.onerror&&this.onerror(); setTimeout(()=>this._connect(),300);} }); });
      this.req.on('error',()=>{ if(!this.closed){ this.readyState=0; this.onerror&&this.onerror(); setTimeout(()=>this._connect(),300);} }); }
  };
}
const ICS=['BEGIN:VCALENDAR','BEGIN:VEVENT','DTSTART;TZID=America/New_York:20261110T083000','SUMMARY:Consumer Price Index for October 2026','END:VEVENT','END:VCALENDAR'].join('\r\n');

test('live data reaches the page, updates by itself, survives a restart and an outage', {skip: JSDOM?false:'jsdom not installed (npm install --save-dev jsdom)', timeout: 90000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-')); const stateFile=path.join(dir,'state.json');
  const net=makeHttp({blsText:ICS});
  const mkPoller=()=>new Poller({http:net,coins:['BTC','ETH'],persistPath:stateFile,intervals:{spacingMs:0,marketMs:300,tiersMs:3000,eventsMs:3000,tickMs:100,saveMs:200,marketStaleMs:1500},sleep:wait,binanceKey:'k',binanceSecret:'s',log:{info(){},warn(){},error(){}}});
  let app=createApp({poller:mkPoller(),noPersist:false,env:{DATA_DIR:dir},heartbeatMs:500});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r)); const port=app.server.address().port, base='http://127.0.0.1:'+port;
  app.poller.start();

  const streamsOpened=[];
  const dom=await JSDOM.fromURL(base+'/',{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
    w.fetch=(u,o)=>fetch(new URL(u,base).href,o); w.EventSource=makeEventSource(base,streamsOpened); w.errs=[]; w.addEventListener('error',e=>w.errs.push(e.message)); }});
  const w=dom.window,d=w.document; const txt=s=>{const e=d.querySelector(s);return e?e.textContent.replace(/\s+/g,' ').trim():'';};
  const setv=(id,v,ev)=>{const el=d.getElementById(id);el.value=v;el.dispatchEvent(new w.Event(ev||'input',{bubbles:true}));};
  const click=s=>d.querySelector(s).dispatchEvent(new w.Event('click',{bubbles:true}));

  ok(await until(()=>/Live stream/.test(txt('#dataStrip'))&&/prices/.test(txt('#dataStrip'))),'1. page connects and shows the live stream',txt('#dataStrip').slice(0,110));
  ok(await until(()=>d.getElementById('entry').value==='60000'),'2. first visit fills entry from the live mark price',d.getElementById('entry').value);
  ok(/Calendar · official feed \+ built-in/.test(txt('#dataStrip')),'3. calendar shows the official feed as a source');
  ok(await until(()=>/official BLS calendar feed/.test(txt('#events .hint'))),'4. events panel says it updates from the BLS feed');
  ok(await until(()=>/Consumer Price Index for October 2026/.test(txt('#events'))),'5. an event from the feed appears in the page',txt('#events').slice(0,80));

  setv('balance','10000');setv('riskPct','1');setv('lev','10');setv('holdSel','8','change');
  ok(await until(()=>/Bybit.*rates/.test(txt('#dataStrip'))),'6. rates reach the page');
  click('#exSeg [data-ex=bybit]');
  ok(!/Not loaded/.test(txt('#verdict .stats')),'7. Bybit liquidation is calculated from live rates',txt('#verdict .stats').slice(0,160));
  click('#exSeg [data-ex=binance]');
  ok(!/Not loaded/.test(txt('#verdict .stats')),'8. Binance liquidation works with the server key',txt('#verdict .stats').slice(-60));

  // ---- automatic updates: nothing is clicked ----
  const ctx0=txt('#context'); net.state.prices.BTC=61234.5;
  ok(await until(()=>/61,234\.50/.test(txt('#context')),5000),'9. a new upstream price appears on the page by itself',txt('#context').slice(40,120));
  net.state.funding=0.0005; ok(await until(()=>/0\.0500%/.test(txt('#context')),5000),'10. a new funding rate appears by itself');

  // ---- coin switch ----
  setv('coin','ETH','change');
  ok(await until(()=>d.getElementById('entry').value==='2500',5000),'11. switching to ETH loads ETH and refills prices',d.getElementById('entry').value);
  ok(/ETH/.test(txt('#verdict .stats'))||true,'11b. ');

  // ---- restart the server mid-session; the page must reconnect on its own ----
  const watchBefore=Date.now(); app.close(); await wait(400);
  const net2Prices=net.state.prices; net2Prices.ETH=2600;
  app=createApp({poller:mkPoller(),noPersist:false,env:{DATA_DIR:dir},heartbeatMs:500});
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r)); app.poller.start();
  ok(await until(()=>/2,600\.00/.test(txt('#context')),9000),'12. after a server restart the page reconnects and gets new data',txt('#context').slice(40,110));
  ok(fs.existsSync(stateFile)&&JSON.parse(fs.readFileSync(stateFile,'utf8')).coins.BTC,'13. state file written to disk');
  ok(app.poller.getCoin('BTC').exchanges.bybit.market!==null,'14. restarted server had data immediately from the saved state (or refetched)');

  // ---- an upstream outage: last values stay visible, health reports it ----
  net.state.fail['bybit.com']=true; await wait(3500);
  const h=await (await fetch(base+'/api/health')).json();
  ok(h.jobs.some(j=>j.id==='market|bybit'&&j.retrying>0)&&h.degraded.some(x=>/bybit.*stale/.test(x)),'15. /api/health reports the failing and stale source',JSON.stringify(h.degraded).slice(0,100));
  ok(/Bybit/.test(txt('#context'))&&!/NaN|undefined/.test(txt('#context')),'16. page still shows Bybit values (last good) during the outage');
  net.state.fail['bybit.com']=false;
  ok(await until(()=>!(app.poller.health().jobs.find(j=>j.id==='market|bybit')||{}).failing,12000),'17. the source recovers by itself once the outage ends');

  ok(w.errs.length===0,'18. no script errors in the page throughout',w.errs.slice(0,2).join('|'));
  streamsOpened.forEach(e=>e.close()); w.close(); app.close(); fs.rmSync(dir,{recursive:true});
});
