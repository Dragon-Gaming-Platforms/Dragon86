const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./cloud-DTkzjJPs.js","./index-DodomcQW.js","./index-C8mbEF3v.css","./zip-BegHlIFd.js","./bytes--DnyINbG.js"])))=>i.map(i=>d[i]);
import{J as k,_ as v,c as O,h as C,bW as j,fD as I,fG as L,fI as M,fJ as _,fH as A}from"./index-DodomcQW.js";import{S as T}from"./host-CCr_WSEs.js";/* empty css                  */const P=`// Script runtime: the \`studio\` API as a script sees it. This file runs inside
// the script sandbox (a dedicated worker started by an iframe with an opaque
// origin and a content security policy without network access), followed by
// the user's script wrapped in an async function. Every call becomes a
// structured-clone message to Photo Studio, which checks it and answers.
// Plain JavaScript: it is inserted as text, not bundled.
const __studioRegister = (() => {
  'use strict';
  let port = null;
  let main = null;
  let info = { lineOffset: 0, script: { id: '', name: '' }, event: null };
  let next = 0;
  let cancelled = false;
  const pending = new Map();

  class ScriptCancelled extends Error {
    constructor() {
      super('The script was stopped.');
      this.name = 'ScriptCancelled';
    }
  }
  const send = (message) => port.postMessage(message);
  function call(method, ...args) {
    if (cancelled) return Promise.reject(new ScriptCancelled());
    const id = ++next;
    // The call site, so an error reports the script's line rather than the runtime's.
    const site = new Error();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, site });
      send({ type: 'call', id, method, args });
    });
  }
  function receive(ev) {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') return send({ type: 'pong' });
    if (m.type === 'cancel') {
      cancelled = true;
      for (const p of pending.values()) p.reject(new ScriptCancelled());
      pending.clear();
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'result') p.resolve(m.value);
    else if (m.name === 'ScriptCancelled') p.reject(new ScriptCancelled());
    else {
      const error = new Error(m.message);
      error.name = m.name || 'Error';
      error.stack = \`\${error.name}: \${error.message}\\n\${String(p.site.stack || '').split('\\n').slice(1).join('\\n')}\`;
      p.reject(error);
    }
  }

  // console.* goes to the Scripts panel output.
  const show = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return \`\${v.name}: \${v.message}\`;
    try {
      return JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? \`[\${x.constructor.name} \${x.length}]\` : x));
    } catch {
      return String(v);
    }
  };
  const log = (level) => (...args) => send({ type: 'log', level, text: args.map(show).join(' ').slice(0, 4000) });
  const scriptConsole = Object.freeze({ log: log('log'), info: log('info'), debug: log('log'), warn: log('warn'), error: log('error') });

  const idOf = (layer) => (layer && typeof layer === 'object' ? layer.id : layer);
  const layer = (info) => (info ? new Layer(info) : null);

  class Layer {
    constructor(data) {
      Object.assign(this, data);
    }
    refresh() { return call('layers.get', this.documentId, this.id).then(layer); }
    set(props) { return call('layers.set', this.documentId, this.id, props).then(layer); }
    rename(name) { return this.set({ name }); }
    show() { return this.set({ visible: true }); }
    hide() { return this.set({ visible: false }); }
    move(dx, dy) { return call('layers.translate', this.documentId, this.id, dx, dy).then(layer); }
    moveTo(x, y) {
      const b = this.bounds || { x: 0, y: 0 };
      return this.move(x - b.x, y - b.y);
    }
    arrange(where) {
      const w = where && typeof where === 'object' ? Object.fromEntries(Object.entries(where).map(([k, v]) => [k, idOf(v)])) : where;
      return call('layers.arrange', this.documentId, this.id, w).then(layer);
    }
    duplicate() { return call('layers.duplicate', this.documentId, this.id).then(layer); }
    remove() { return call('layers.remove', this.documentId, this.id); }
    select() { return call('layers.select', this.documentId, [this.id]); }
    pixels(rect) { return call('layers.getPixels', this.documentId, this.id, rect); }
    setPixels(image, x, y) {
      const img = x === undefined ? image : { ...image, x, y };
      return call('layers.setPixels', this.documentId, this.id, img).then(layer);
    }
    getText() { return call('layers.getText', this.documentId, this.id); }
    setText(textOrOptions) { return call('layers.setText', this.documentId, this.id, textOrOptions).then(layer); }
    setStyle(style) { return call('layers.setStyle', this.documentId, this.id, style).then(layer); }
    async children() {
      const all = await call('layers.list', this.documentId);
      return all.filter((l) => l.parentId === this.id).map(layer);
    }
    export(options = {}) { return call('documents.export', this.documentId, { ...options, layer: this.id }); }
  }

  const doc = (info) => (info ? new Document(info) : null);
  class Document {
    constructor(data) {
      Object.assign(this, data);
    }
    refresh() { return call('documents.get', this.id).then(doc); }
    activate() { return call('documents.activate', this.id).then(doc); }
    async layers() { return (await call('layers.list', this.id)).map(layer); }
    async layer(idOrName) {
      const all = await call('layers.list', this.id);
      return layer(all.find((l) => l.id === idOrName) || all.find((l) => l.name === idOrName));
    }
    async selectedLayers() { return (await call('layers.selected', this.id)).map(layer); }
    selectLayers(layers) { return call('layers.select', this.id, [].concat(layers).map(idOf)); }
    addLayer(options = {}) {
      const o = { ...options };
      for (const k of ['above', 'inside']) if (o[k] !== undefined) o[k] = idOf(o[k]);
      return call('layers.create', this.id, o).then(layer);
    }
    composite(rect) { return call('documents.composite', this.id, rect); }
    selection() { return call('selection.get', this.id); }
    select(shape, operation) { return call('selection.set', this.id, shape, operation); }
    selectAll() { return call('selection.all', this.id); }
    deselect() { return call('selection.clear', this.id); }
    invertSelection() { return call('selection.invert', this.id); }
    selectionMask() { return call('selection.getMask', this.id); }
    setSelectionMask(mask, operation) { return call('selection.setMask', this.id, mask, operation); }
    run(command, arg) { return call('commands.run', command, arg, this.id); }
    export(options = {}) { return call('documents.export', this.id, options); }
    save() { return call('documents.save', this.id); }
    close(options = {}) { return call('documents.close', this.id, options); }
    undo() { return call('documents.undo', this.id); }
    redo() { return call('documents.redo', this.id); }
  }

  const studio = Object.freeze({
    apiVersion: 1,
    get script() { return { ...info.script }; },
    // Set when the script runs for a Script Events Manager event.
    get event() { return info.event ? { ...info.event } : null; },
    get cancelled() { return cancelled; },
    checkCancelled() {
      if (cancelled) throw new ScriptCancelled();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60000, Number(ms) || 0)))),
    app: Object.freeze({
      info: () => call('app.info'),
      message: (text) => call('app.message', String(text)),
    }),
    documents: Object.freeze({
      list: async () => (await call('documents.list')).map(doc),
      active: () => call('documents.active').then(doc),
      get: (id) => call('documents.get', id).then(doc),
      create: (options = {}) => call('documents.create', options).then(doc),
      open: async (options = {}) => (await call('documents.open', options)).map(doc),
    }),
    commands: Object.freeze({
      run: (id, arg) => call('commands.run', id, arg),
      list: () => call('commands.list'),
    }),
    history: Object.freeze({
      checkpoint: (label) => call('history.checkpoint', label),
      setGrouping: (on) => call('history.grouping', !!on),
    }),
    ui: Object.freeze({
      alert: (message, title) => call('ui.alert', String(message), title),
      confirm: (message, title) => call('ui.confirm', String(message), title),
      prompt: (message, value, title) => call('ui.prompt', String(message), value === undefined ? '' : String(value), title),
      form: (title, fields, options) => call('ui.form', String(title), fields, options),
      progress: (fraction, message) => call('ui.progress', fraction === undefined ? null : fraction, message),
    }),
    files: Object.freeze({
      open: (options = {}) => call('files.open', options),
      save: (name, data, type) => call('files.save', name, data, type),
      saveAll: (files, zipName) => call('files.saveAll', files, zipName),
    }),
    image: Object.freeze({
      create(width, height, fill) {
        const data = new Uint8ClampedArray(width * height * 4);
        if (fill) {
          const [r, g, b, a = 255] = typeof fill === 'string' ? [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16)) : fill;
          for (let i = 0; i < data.length; i += 4) {
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
          }
        }
        return { width, height, data };
      },
      encode: (image, options) => call('image.encode', image, options),
    }),
  });

  // The script's own line number of an error, from the worker's stack.
  function lineOf(error) {
    const stack = String((error && error.stack) || '');
    for (const m of stack.matchAll(/blob:[^\\s)]*?:(\\d+):\\d+/g)) {
      const line = Number(m[1]) - info.lineOffset;
      if (line > 0) return line;
    }
    return 0;
  }
  async function run() {
    try {
      if (!main) throw new Error('The script did not load.');
      await main(studio, scriptConsole);
      send({ type: 'done' });
    } catch (error) {
      if (cancelled || (error && error.name === 'ScriptCancelled')) return send({ type: 'done', cancelled: true });
      send({ type: 'failed', name: (error && error.name) || 'Error', message: String((error && error.message) || error), line: lineOf(error) });
    }
  }
  self.addEventListener('unhandledrejection', (ev) => {
    ev.preventDefault();
    if (port && !(ev.reason && ev.reason.name === 'ScriptCancelled')) scriptConsole.error('Unhandled rejection:', ev.reason);
  });
  self.onmessage = (ev) => {
    if (port || !ev.data || ev.data.type !== 'start' || !ev.ports[0]) return;
    port = ev.ports[0];
    info = ev.data.info;
    port.onmessage = receive;
    void run();
  };
  return (fn) => {
    main = fn;
  };
})();
`,q="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:",D=`let started = false;
addEventListener('message', (ev) => {
  if (started || ev.source !== parent || !ev.data || ev.data.type !== 'start' || !ev.ports[0]) return;
  started = true;
  const url = URL.createObjectURL(new Blob([ev.data.code], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'script' });
  worker.onerror = (e) => {
    e.preventDefault();
    parent.postMessage({ type: 'worker-error', message: String(e.message || 'The script could not run.'), line: e.lineno || 0 }, '*');
  };
  worker.postMessage({ type: 'start', info: ev.data.info }, [ev.ports[0]]);
});`;function z(){return`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${q}"><script>${D}<\/script></head><body></body></html>`}function N(n){const e=`${P}
__studioRegister(async function (studio, console) {
`;return{code:`${e}${n}
});
`,lineOffset:e.split(`
`).length-1}}const R=1e3;class F{constructor(e,a,t,r=30){this.source=e,this.info=a,this.handlers=t,this.timeoutSeconds=r}source;info;handlers;timeoutSeconds;frame;port;finish;watchdog=0;heard=0;queue=Promise.resolve();stopping=0;inCall=0;onWindowMessage=e=>{if(!this.frame||e.source!==this.frame.contentWindow)return;const a=e.data;a?.type==="worker-error"&&this.end({status:"failed",message:String(a.message??"The script could not run.").replace(/^Uncaught /,""),line:Math.max(0,Number(a.line)-this.lineOffset)})};lineOffset=0;run(){return new Promise(e=>{this.finish=e;const{code:a,lineOffset:t}=N(this.source);this.lineOffset=t;const r=document.createElement("iframe");r.setAttribute("sandbox","allow-scripts"),r.setAttribute("aria-hidden","true"),r.tabIndex=-1,r.className="script-sandbox",r.title="Script sandbox",r.srcdoc=z(),this.frame=r,window.addEventListener("message",this.onWindowMessage),r.addEventListener("load",()=>{const s=new MessageChannel;this.port=s.port1,this.port.onmessage=o=>this.receive(o.data),this.heard=performance.now(),r.contentWindow.postMessage({type:"start",code:a,info:{...this.info,lineOffset:t}},"*",[s.port2]),this.watchdog=window.setInterval(()=>this.tick(),R)},{once:!0}),document.body.append(r)})}cancel(){!this.finish||this.stopping||(this.port?.postMessage({type:"cancel"}),this.stopping=window.setTimeout(()=>this.end({status:"cancelled"}),2e3))}tick(){this.port?.postMessage({type:"ping"}),this.inCall&&(this.heard=performance.now()),(performance.now()-this.heard)/1e3>this.timeoutSeconds&&this.end({status:"timeout",seconds:this.timeoutSeconds})}receive(e){if(this.heard=performance.now(),!(!e||typeof e!="object"))if(e.type==="call"&&typeof e.id=="number"&&typeof e.method=="string"){const{id:a,method:t}=e,r=Array.isArray(e.args)?e.args:[];this.queue=this.queue.then(async()=>{if(this.finish){this.inCall++;try{const s=await this.handlers.call(t,r);this.port?.postMessage({type:"result",id:a,value:s},B(s))}catch(s){const o=s instanceof Error?s:new Error(String(s));this.port?.postMessage({type:"error",id:a,name:o.name==="ScriptError"?"Error":o.name,message:o.message})}finally{this.inCall--,this.heard=performance.now()}}})}else e.type==="log"?this.handlers.log(String(e.level??"log"),String(e.text??"")):e.type==="done"?this.end({status:e.cancelled?"cancelled":"done"}):e.type==="failed"&&this.end({status:"failed",message:String(e.message??"The script failed."),line:Number(e.line)||0})}end(e){const a=this.finish;a&&(this.finish=void 0,this.queue.then(()=>{this.dispose(),a(this.stopping&&e.status==="done"?{status:"cancelled"}:e)}))}dispose(){clearInterval(this.watchdog),clearTimeout(this.stopping),window.removeEventListener("message",this.onWindowMessage),this.port?.close(),this.port=void 0,this.frame?.remove(),this.frame=void 0}}function B(n){const e=new Set,a=t=>{ArrayBuffer.isView(t)&&t.buffer instanceof ArrayBuffer&&t.byteLength===t.buffer.byteLength&&e.add(t.buffer)};if(n&&typeof n=="object"){a(n);for(const t of Object.values(n))a(t)}return[...e]}const p=n=>O(String(n));function g(n,e,a,t,r){const s=document.createElement("dialog");s.className="files-dialog script-dialog",s.setAttribute("aria-label",e);const o=t.at(-1);s.innerHTML=`<form method="dialog"><p class="script-origin" title="This window comes from a script you installed">${k("square-code",13)}<span>Script: ${p(n)}</span></p><h2>${p(e)}</h2>${a}<div class="dialog-actions">${t.slice(0,-1).map(([u,l])=>`<button type="button" data-act="${u}">${p(l)}</button>`).join("")}<button type="submit" class="primary" data-act="${o[0]}">${p(o[1])}</button></div></form>`,document.body.append(s);const d=s.querySelector("form");return new Promise(u=>{const l=c=>{s.close(),s.remove(),u(c===null?null:{action:c,form:d})};s.addEventListener("cancel",c=>{c.preventDefault(),l(null)}),d.addEventListener("submit",c=>{c.preventDefault(),d.reportValidity()&&l(o[0])});for(const[c,,m]of t.slice(0,-1))m||s.querySelector(`button[data-act="${c}"]`).addEventListener("click",()=>l(c==="cancel"?null:c));r?.(s),s.showModal()})}const w=n=>n.split(/\n{2,}/).map(e=>`<p class="script-message">${p(e).replace(/\n/g,"<br>")}</p>`).join("");function U(n,e){const a=`script-field-${e}`,t=o=>n[o]!==void 0?`${o}="${n[o]}"`:"",r=`name="${p(n.name)}" id="${a}"`;let s;return n.type==="checkbox"?`<label class="dialog-field checkbox-field" for="${a}">${p(n.label)}<input type="checkbox" ${r} ${n.value===!0||n.value==="yes"?"checked":""}></label>`:(n.type==="select"?s=`<select ${r}>${(n.options??[]).map(([o,d])=>`<option value="${p(o)}" ${String(n.value)===o?"selected":""}>${p(d)}</option>`).join("")}</select>`:n.type==="textarea"?s=`<textarea ${r} rows="4">${p(n.value)}</textarea>`:n.type==="range"?s=`<span class="script-range"><input type="range" ${r} ${t("min")} ${t("max")} ${t("step")} value="${p(n.value)}"><output for="${a}">${p(n.value)}</output></span>`:n.type==="number"?s=`<input type="number" ${r} ${t("min")} ${t("max")} ${n.step!==void 0?t("step"):'step="any"'} value="${p(n.value)}" required>`:n.type==="color"?s=`<input type="color" ${r} value="${/^#[0-9a-f]{6}$/i.test(String(n.value))?p(n.value):"#000000"}">`:s=`<input type="text" ${r} value="${p(n.value)}" autocomplete="off">`,`<label class="dialog-field" for="${a}">${p(n.label)}${s}</label>`)}function V(n,e,a){return{async alert(t,r){await g(e,r,w(t),[["ok","OK"]])},async confirm(t,r){return(await g(e,r,w(t),[["cancel","Cancel"],["ok","OK"]]))?.action==="ok"},async prompt(t,r,s){const o=await g(e,s,`${w(t)}<label class="dialog-field"><input type="text" name="answer" value="${p(r)}" autocomplete="off" aria-label="Answer"></label>`,[["cancel","Cancel"],["ok","OK"]]);return o?o.form.elements.namedItem("answer").value:null},async form(t,r,s,o){const d=await g(e,t,`${o?w(o):""}<div class="script-form">${r.map(U).join("")}</div>`,[["cancel","Cancel"],["ok",s]],l=>{for(const c of l.querySelectorAll('input[type="range"]'))c.addEventListener("input",()=>c.nextElementSibling.textContent=c.value)});if(!d)return null;const u={};return r.forEach((l,c)=>{const m=d.form.querySelector(`#script-field-${c}`);u[l.name]=l.type==="checkbox"?m.checked:l.type==="number"||l.type==="range"?Number(m.value):m.value}),u},progress:a,async openFiles(t){const r=t.accept==="image"||!t.accept?document.querySelector("#file-input")?.accept??"image/*":t.accept;let s=null;return await g(e,t.multiple?"Choose Files":"Choose a File",`<p class="script-message">The script asks to read ${t.multiple?"files":"a file"}. It receives only what you choose.</p><p class="script-picked muted" aria-live="polite">Nothing chosen yet.</p>`,[["cancel","Cancel"],["device","From this device…","stay"],["puter","From Puter…","stay"],["ok","Use"]],d=>{const u=d.querySelector('button[type="submit"]');u.disabled=!0;const l=d.querySelector(".script-picked"),c=i=>{s=i,u.disabled=!i.length,l.textContent=i.length?i.map(h=>h.name).join(", "):"Nothing chosen yet."},m=async i=>c(await Promise.all(i.map(async h=>{const f=await h.read();return{name:h.name,type:f.type||h.type||"",data:new Uint8Array(await f.arrayBuffer())}})));d.querySelector('[data-act="device"]').addEventListener("click",()=>{const i=document.createElement("input");i.type="file",i.accept=r,i.multiple=t.multiple,i.onchange=()=>{m(Array.from(i.files??[]).map(h=>({name:h.name,type:h.type,read:async()=>h})))},i.click()}),d.querySelector('[data-act="puter"]').addEventListener("click",()=>{v(async()=>{const{pickCloudFiles:i}=await import("./cloud-DTkzjJPs.js");return{pickCloudFiles:i}},__vite__mapDeps([0,1,2]),import.meta.url).then(({pickCloudFiles:i})=>i(t.multiple,r)).then(i=>m(i.map(h=>({name:h.name,read:()=>h.read()})))).catch(i=>l.textContent=String(i instanceof Error?i.message:i))})})?s??[]:[]},async saveFiles(t,r){const s=t.reduce((m,i)=>m+i.data.length,0),o=s<1024*1024?`${Math.max(1,Math.round(s/1024))} KB`:`${(s/1048576).toFixed(1)} MB`,d=t.length===1?`“${t[0].name}”`:`${t.length} files as “${r}”`,u=await g(e,"Save Files",`<p class="script-message">The script wants to save ${p(d)} (${o}).</p>`,[["cancel","Cancel"],["puter","Save to Puter…"],["download","Download"]]);if(!u)return!1;let l,c;if(t.length===1)l=new Blob([t[0].data],{type:t[0].type}),c=t[0].name;else{const{uniqueName:m,zipStore:i}=await v(async()=>{const{uniqueName:f,zipStore:E}=await import("./zip-BegHlIFd.js");return{uniqueName:f,zipStore:E}},__vite__mapDeps([3,4]),import.meta.url),h=new Set;l=new Blob([i(t.map(f=>({name:m(f.name,h),data:f.data})))],{type:"application/zip"}),c=r??"files.zip"}if(u.action==="puter"){const{cloudSaveAs:m}=await v(async()=>{const{cloudSaveAs:i}=await import("./cloud-DTkzjJPs.js");return{cloudSaveAs:i}},__vite__mapDeps([0,1,2]),import.meta.url);m(l,c).then(i=>n.message(`Saved ${i.name} to Puter`)).catch(i=>n.message(String(i instanceof Error?i.message:i)))}else{const{download:m}=await v(async()=>{const{download:i}=await import("./index-DodomcQW.js").then(h=>h.o4);return{download:i}},__vite__mapDeps([1,2]),import.meta.url);m(l,c)}return!0}}}function W(n,e,a){const t=document.createElement("div");t.className="script-run",t.setAttribute("role","status"),t.hidden=!0,t.innerHTML=`${k("square-code",14)}<span class="script-run-name">${p(e)}</span><span class="script-run-message"></span><progress max="1" aria-label="Script progress"></progress><button type="button" class="script-run-stop" title="Stop the script (its changes so far stay as one undo step)">Stop</button>`,t.querySelector("button").addEventListener("click",a),n.root.append(t);const r=window.setTimeout(()=>t.hidden=!1,400),s=t.querySelector("progress");return s.removeAttribute("value"),{progress(o,d){o===null?s.removeAttribute("value"):s.value=o,t.querySelector(".script-run-message").textContent=d,(d||o!==null)&&(t.hidden=!1)},stopping(){t.querySelector("button").disabled=!0,t.querySelector(".script-run-message").textContent="Stopping…"},remove(){clearTimeout(r),t.remove()}}}const x=500,y=[],S=new Set;function Q(n){return S.add(n),()=>S.delete(n)}function $(n,e,a){y.push({time:Date.now(),script:n,level:e,text:a}),y.length>x&&y.splice(0,y.length-x),S.forEach(t=>t())}function Y(){y.length=0,S.forEach(n=>n())}let b;const Z=()=>!!b;async function H(n,e){const a=await C({title:"Run Script?",className:"script-confirm",body:`<p>“${O(n)}” is a script: a small program that can change your open documents, create and close documents, and ask you to open or save files.</p><p class="muted">It runs separately from Photo Studio, without network access and without access to your Puter account or this site's storage. Run it only if you trust where it came from.</p>${e.offerInstall?'<label class="dialog-field checkbox-field">Add it to File → Scripts<input type="checkbox" name="install"></label>':""}`,submit:"Run Script"});if(!a)return null;const t=e.offerInstall&&j(a.form,"install");return a.close(),{install:t}}async function ee(n,e){if(b)return n.message("Another script is running. Stop it first."),!1;let a=e.trusted??(e.id?!!I(e.id)?.trusted:!1);if(!a){if(e.event)return n.message(`“${e.name}” was not run for ${e.event.name}: run it once from File → Scripts first.`),!1;const u=await H(e.name,{offerInstall:!e.id});if(!u)return!1;if(a=!0,e.id)await L(e.id,{trusted:!0});else if(u.install){const l=M(e.source,e.name,{trusted:!0});await _(l),e={...e,id:l.id}}}const t=`${e.name} (script)`;let r;const s=new F(e.source,{script:{id:e.id??"",name:e.name},event:e.event??null},{call:(u,l)=>o.call(u,l),log:(u,l)=>$(e.name,u,l)},A(e.source).timeout??30);r=W(n,e.name,()=>{r?.stopping(),s.cancel()});const o=new T(n,V(n,e.name,(u,l)=>r?.progress(u,l)),t);b=s;let d;try{d=await s.run()}finally{b=void 0,r.remove(),o.finish()}return G(n,e.name,d),!0}function G(n,e,a){if(a.status==="done"){$(e,"info","Finished.");return}const t=a.status==="cancelled"?`Stopped “${e}”. Changes it made so far can be undone in one step.`:a.status==="timeout"?`Stopped “${e}”: it did not respond for ${a.seconds} seconds.`:`“${e}” failed${a.line?` at line ${a.line}`:""}: ${a.message}`;$(e,a.status==="cancelled"?"info":"error",t),n.message(t)}export{Y as clearScriptLog,H as confirmScript,Q as onScriptLog,ee as runScript,y as scriptLog,Z as scriptRunning};
