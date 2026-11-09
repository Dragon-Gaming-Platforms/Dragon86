import{m as i,b as l,a as r,c as h}from"./index-DodomcQW.js";function c(t){const a=(t.paths??[]).map(e=>({id:e.id,name:e.name,d:i(e.mask)}));return t.workPath?.paths.length&&a.push({id:"work-path",name:"Work Path",d:i(t.workPath)}),a.filter(e=>e.d)}function d(t,a,e,n){const s=e.map(o=>`  <path id="${h(o.id.replace(/[^A-Za-z0-9_-]/g,"_"))}" d="${o.d}"><title>${h(o.name)}</title></path>`);return`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${t}" height="${a}" viewBox="0 0 ${t} ${a}">
${n?`  <rect id="document-bounds" x="0" y="0" width="${t}" height="${a}" fill="none" stroke="#999" stroke-width="1"><title>Document bounds</title></rect>
`:""}  <g fill="none" stroke="#000" stroke-width="1">
${s.join(`
`)}
  </g>
</svg>
`}async function g(t){const a=c(t.doc);if(!a.length)return t.message("This document has no paths. Draw one with the Pen tool or save a work path first.");const e=await l("Paths to Vector File",[{name:"which",label:"Paths",value:"all",type:"select",options:[["all","All Paths"],...a.map(o=>[o.id,o.name])]},{name:"bounds",label:"Include document bounds",value:"no",type:"checkbox"}],"Export","Writes an SVG file at the document’s pixel size.");if(!e)return;const n=e.which==="all"?a:a.filter(o=>o.id===e.which),s=n.length===1&&e.which!=="all"?`${t.doc.name} - ${n[0].name}`:`${t.doc.name} paths`;r(new Blob([d(t.doc.width,t.doc.height,n,e.bounds==="yes")],{type:"image/svg+xml"}),`${s.replace(/[\\/:*?"<>|]+/g,"_")}.svg`),t.message(`Exported ${n.length} path${n.length===1?"":"s"} as SVG.`)}export{c as documentPaths,g as exportPathsDialog,d as pathsSvg};
