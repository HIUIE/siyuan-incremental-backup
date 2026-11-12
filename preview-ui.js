"use strict";
// Generates an interactive UI preview using the real plugin class and demo-only I/O.
// No SiYuan workspace or real backups are read or written.
const fs = require("fs");
const path = require("path");
const engine = require("./backup-core");
const css = fs.readFileSync(path.join(__dirname, "index.css"), "utf8");
const pluginSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const translations = { zh: require("./i18n/zh_CN.json"), en: require("./i18n/en_US.json") };
const helperNames = ["pad2", "dayString", "readable", "humanSize", "stampOf", "isPathInside", "expandHome", "contractHome", "friendlyError", "buildExcludes"];
const helpers = helperNames.map(name => `const ${name} = ${engine[name].toString()};`).join("\n");
const constants = Object.fromEntries(["PLUGIN_NAME", "SNAP_PREFIX", "MANIFEST_NAME", "INCOMPLETE_NAME", "LOG_NAME", "DEFAULT_EXCLUDES", "SOURCE_DEFS"].map(name => [name, engine[name]]));
const bootstrap = `
const translations = ${JSON.stringify(translations)};
const css = ${JSON.stringify(css)};
const module = {exports:{}};
const __dirname = '/demo/plugin';
const process = {pid:1};
const os = {homedir:()=>'/demo-user'};
const path = {
 sep:'/', isAbsolute:p=>p.startsWith('/'),
 join:(...a)=>a.filter(Boolean).join('/').replace(/\\/+/g,'/'),
 resolve:p=>p.startsWith('/')?p:'/demo/'+p,
 basename:p=>p.split('/').filter(Boolean).pop(),
 dirname:p=>p.slice(0,p.lastIndexOf('/'))||'/',
 relative:(a,b)=>{const x=a.split('/'),y=b.split('/');while(x.length&&y.length&&x[0]===y[0]){x.shift();y.shift()}return [...x.filter(Boolean).map(()=>'..'),...y].join('/')}
};
const {PLUGIN_NAME,SNAP_PREFIX,MANIFEST_NAME,INCOMPLETE_NAME,LOG_NAME,DEFAULT_EXCLUDES,SOURCE_DEFS} = ${JSON.stringify(constants)};
${helpers}
const demoSnaps = [
 {name:'snap-20261112-090000',path:'/Volumes/Backup/SiYuanBackup/snap-20261112-090000',time:new Date(2026,10,12,9).getTime(),complete:true,files:8432,copied:12,linked:8420,bytes:2684354,note:'每日首启备份'},
 {name:'snap-20261111-220000',path:'/Volumes/Backup/SiYuanBackup/snap-20261111-220000',time:new Date(2026,10,11,22).getTime(),complete:true,files:8430,copied:8,linked:8422,bytes:589824,note:'整理笔记后'},
 {name:'snap-20261111-180000',path:'/Volumes/Backup/SiYuanBackup/snap-20261111-180000',time:new Date(2026,10,11,18).getTime(),complete:true,files:8428,copied:0,linked:8428,bytes:0,note:''}
].reverse();
const demoCore = {${helperNames.join(",")},...${JSON.stringify(constants)},
 listSnapshots:async()=>new URLSearchParams(location.search).has('empty')?[]:demoSnaps,
 readManifest:async()=>({note:''}), cleanupIncomplete:async()=>0,
 withDestinationLock:async(_,fn)=>fn(), removeSnapshot:async()=>{},
 appendLog:async()=>{}, validateBackupPaths:async(workspace,destRoot)=>({workspace,destRoot}),
 verifySnapshot:async()=>({ok:true,files:8432,bytes:2684354,legacy:false}),
 restoreSnapshot:async()=>({ok:true,copied:8432}),
 runSnapshot:async(opts)=>{for(let n=0;n<=100;n+=10){if(opts.shouldStop())return {ok:false,error:'已取消'};opts.onProgress({phase:'copy',current:n,total:100});await new Promise(r=>setTimeout(r,100));}return {ok:true,files:8432,copied:12,linked:8420,bytes:2684354,ms:1000,deleted:0,snapshot:demoSnaps[demoSnaps.length-1].path};}
};
const fsp = {readFile:async()=> 'Preview log: demo data only', writeFile:async()=>{},rename:async()=>{},unlink:async()=>{},open:async()=>({writeFile:async()=>{},sync:async()=>{},close:async()=>{}})};
const messages=[];
const siyuan={
 Plugin:class {addIcons(svg){document.body.insertAdjacentHTML('afterbegin','<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs>'+svg+'</defs></svg>')} addTopBar(config){const button=document.createElement('button');button.className='preview-toolbar-icon';button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#'+config.icon+'"></use></svg>';button.addEventListener('click',config.callback);document.querySelector('.preview-tools').appendChild(button);return button} addCommand(){} async loadData(){return null} async saveData(){if(window.failSave)throw Error('Demo write denied')}},
 Dialog:class {
  constructor(options){this.options=options;this.element=document.createElement('div');this.element.className='preview-dialog-root';this.element.innerHTML='<section class="b3-dialog b3-dialog__container '+(options.containerClassName||'')+'" role="dialog" aria-modal="true"><header class="preview-dialog-title b3-dialog__header">'+options.title+'</header><div class="b3-dialog__body">'+options.content+'</div></section>';document.querySelector('#dialogs').append(this.element);}
  destroy(){this.element.remove();if(this.options.destroyCallback)this.options.destroyCallback();}
 },
 Menu:class{addItem(){} addSeparator(){} open(){}},
 showMessage:(text)=>{messages.push(text);document.querySelector('#message').textContent=text},
 confirm:(_title,text,fn)=>{if(confirm(text))fn()}
};
const require=(name)=>{if(name==='siyuan')return siyuan;if(name==='fs')return {readFileSync:()=>css,promises:fsp};if(name==='path')return path;if(name==='os')return os;if(name==='./backup-core')return demoCore;if(name==='@electron/remote')return {dialog:{showOpenDialog:async()=>({canceled:false,filePaths:['/Volumes/Export']})},shell:{openPath:()=>{}}};throw Error(name)};
window.siyuan={config:{system:{dataDir:'/demo-user/SiYuan/data'}}};
(function(module,require,__dirname){${pluginSource}\n})(module,require,__dirname);
const params=new URLSearchParams(location.search);
const plugin=new module.exports({i18n:translations[params.get('lang')||'zh']});
window.previewPlugin=plugin;
plugin.settings.destRoot='/Volumes/Backup/SiYuanBackup';
plugin.settings.lastBackupAt=params.has('empty')?0:new Date(2026,10,12,9).getTime();
if(params.has('error'))plugin.settings.lastError='目标磁盘空间不足，请释放空间后重试。历史快照已保留。';
plugin.addStyle();
plugin.registerIcons();
plugin.addTopBarButton();
function openPanel(kind){plugin.closeWindow();document.querySelector('#dialogs').replaceChildren();plugin.statusViews.clear();if(kind==='snapshots')plugin.openSnapshots();else if(kind==='restore')plugin.openRestore(demoSnaps[2].path);else plugin.openSettings(kind==='plan'||kind==='scope'?kind:'overview')}
window.openPanel=openPanel;
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',()=>openPanel(button.dataset.panel)));
document.querySelector('#theme').addEventListener('click',()=>document.documentElement.classList.toggle('dark'));
if(params.get('theme')==='dark')document.documentElement.classList.add('dark');
openPanel(params.get('panel')||'settings');
`;
const shell = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地增量备份 · 交互预览</title><style>
:root{--b3-theme-background:#fff;--b3-theme-on-background:#24272c;--b3-theme-surface:#f6f7f8;--b3-theme-on-surface:#59616d;--b3-theme-on-surface-light:#737b86;--b3-theme-primary:#2863b4;--b3-theme-on-primary:#fff;--b3-theme-primary-light:#dce9fc;--b3-theme-error:#b42318;--b3-border-color:#dfe3e8;--b3-font-family-code:ui-monospace,monospace;color-scheme:light}
:root.dark{--b3-theme-background:#24272c;--b3-theme-on-background:#e9ecf0;--b3-theme-surface:#2c3036;--b3-theme-on-surface:#b5bdc9;--b3-theme-on-surface-light:#929caa;--b3-theme-primary:#8cbaff;--b3-theme-on-primary:#202936;--b3-theme-primary-light:#344c70;--b3-theme-error:#ffa59b;--b3-border-color:#454c56;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--b3-theme-surface);color:var(--b3-theme-on-background);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}button,input,select,textarea{font:inherit}p{margin:0 0 12px}.preview-tools{max-width:1040px;margin:0 auto 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.preview-dialog-root .sibk-window-title::after{content:" · 演示数据";font-size:11px;font-weight:400;color:var(--b3-theme-on-surface)}.preview-toolbar-icon{position:relative;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);cursor:pointer}.preview-toolbar-icon svg{width:21px;height:21px}.preview-tools small{margin-right:auto;color:var(--b3-theme-on-surface)}.b3-dialog{max-width:calc(100vw - 32px);margin:0 auto;background:var(--b3-theme-background);border:1px solid var(--b3-border-color);border-radius:10px;overflow:hidden;box-shadow:0 12px 36px #00000012}.preview-dialog-title{padding:18px 24px;border-bottom:1px solid var(--b3-border-color);font-size:18px;font-weight:600}.b3-dialog__content{padding:24px}.b3-dialog__action{display:flex;align-items:center;padding:16px 24px;border-top:1px solid var(--b3-border-color)}.b3-button{border:1px solid transparent;background:var(--b3-theme-primary);color:var(--b3-theme-background);padding:7px 13px;min-height:32px;border-radius:5px;cursor:pointer;white-space:nowrap}.b3-button--text,.b3-button--cancel{background:transparent;color:var(--b3-theme-on-background);border-color:var(--b3-border-color)}.b3-button--small{padding:4px 7px;font-size:12px}.b3-button:hover{filter:brightness(.95)}.b3-text-field,.b3-select{border:1px solid var(--b3-border-color);border-radius:5px;color:var(--b3-theme-on-background);background:var(--b3-theme-background);padding:8px 10px;min-height:36px}.b3-switch{accent-color:var(--b3-theme-primary);width:16px;height:16px;flex-shrink:0}.fn__flex{display:flex;align-items:center}.fn__flex-1{flex:1}.fn__space{width:8px;display:inline-block}.fn__block{display:block}#message{max-width:860px;margin:16px auto;color:var(--b3-theme-on-surface)}@media(max-width:680px){body{padding:12px}.preview-tools{gap:8px}.preview-dialog-title{padding:14px 16px}}
</style><nav class="preview-tools"><small>交互预览 · 演示数据，不连接真实笔记</small><button class="b3-button b3-button--text" data-panel="settings">备份工作台</button><button class="b3-button b3-button--text" data-panel="snapshots">快照管理</button><button class="b3-button b3-button--text" data-panel="restore">恢复向导</button><button class="b3-button b3-button--text" id="theme">浅色 / 深色</button></nav><main id="dialogs"></main><div id="message" role="status"></div><script>${bootstrap.replace(/<\/script/gi, "<\\/script")}</script></html>`;
const out = path.join(__dirname, "artifacts");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "ui-preview.html"), shell);
console.log("Generated artifacts/ui-preview.html (demo data only)");
