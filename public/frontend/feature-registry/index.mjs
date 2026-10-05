function canonicalRoute(value,seen=new Set()){if(value===null||typeof value!=="object"){if(typeof value==="undefined")return["undefined"];if(typeof value==="number"&&!Number.isFinite(value))return["number",String(value)];return[typeof value,value]}if(seen.has(value))throw new TypeError("Feature routes must not contain cycles");seen.add(value);const result=Array.isArray(value)?["array",value.map(item=>canonicalRoute(item,seen))]:["object",Object.keys(value).sort().map(key=>[key,canonicalRoute(value[key],seen)])];seen.delete(value);return result}
function routeKey(route){return JSON.stringify(canonicalRoute(route))}
function descriptorRecords(descriptors){const entries=descriptors instanceof Map?descriptors.entries():Object.entries(descriptors||{}),records=new Map();for(const[view,descriptor]of entries){if(!descriptor||typeof descriptor.load!=="function")throw new TypeError(`Feature descriptor "${view}" must provide load()`);const key=String(view);if(records.has(key))throw new TypeError(`Duplicate feature view after normalization: ${key}`);records.set(key,{descriptor,feature:null,featureEpoch:-1,loadPromise:null,loadEpoch:-1})}return records}
function deferred(){let resolvePromise,rejectPromise,settled=false;const promise=new Promise((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject});return{promise,resolve(value){if(settled)return;settled=true;resolvePromise(value)},reject(error){if(settled)return;settled=true;rejectPromise(error)}}}
function loadedFeature(value){if(!value||typeof value!=="object"||typeof value.mount!=="function")throw new TypeError("Feature loader must resolve directly to a controller instance with mount()");return value}
function changedDomainList(value){if(value==null)return null;if(typeof value==="string")return[value];return[...value]}
function mergeRender(previous,snapshot,changedDomains){if(!previous)return{snapshot,changedDomains};const left=changedDomainList(previous.changedDomains),right=changedDomainList(changedDomains);return{snapshot,changedDomains:left===null||right===null?undefined:[...new Set([...left,...right])]}}
export function createFeatureRegistry({descriptors,onFailure}={}) {
const records=descriptorRecords(descriptors);
const loadedControllers=new WeakSet();
let current=null;
let generation=0;
let epoch=0;
let stopped=false;
let resetFailure=null;
let transitionTail=Promise.resolve();
let activityRevision=0;
let resetScheduledThrough=0;
let lastResetPromise=Promise.resolve();
let stopPromise=null;
const enqueue=task=>{const operation=transitionTail.then(task);transitionTail=operation.catch(()=>{});return operation};
const isCurrent=activation=>current===activation&&activation.epoch===epoch&&!activation.controller.signal.aborted&&!stopped;
const reportFailure=(activation,phase,error)=>{if(typeof onFailure!=="function")return;try{Promise.resolve(onFailure(error,Object.freeze({phase,view:activation.view,route:activation.route,generation:activation.generation}))).catch(()=>{})}catch{}};
const loadFeature=async activation=>{
const {record}=activation;
if(record.feature&&record.featureEpoch===activation.epoch) return record.feature;
if(record.loadPromise&&record.loadEpoch===activation.epoch) return record.loadPromise;
const loadEpoch=activation.epoch;
const promise=Promise.resolve().then(()=>record.descriptor.load()).then(value=>{
const feature=loadedFeature(value);
if(loadedControllers.has(feature)) {
throw new TypeError("Feature loader must return a fresh controller instance");
}
loadedControllers.add(feature);
return feature;
});
record.loadPromise=promise;
record.loadEpoch=loadEpoch;
try {
const feature=await promise;
if(record.loadPromise===promise) {
record.loadPromise=null;
if(!stopped&&epoch===loadEpoch) {
record.feature=feature;
record.featureEpoch=loadEpoch;
}
}
return feature;
} catch(error) {
if(record.loadPromise===promise) record.loadPromise=null;
throw error;
}
};
const retire=activation=>{
if(!activation) return;
activation.cancelled=true;
activation.controller.abort();
};
const discardFeature=activation=>{
if(activation.record.feature===activation.feature) {
activation.record.feature=null;
activation.record.featureEpoch=-1;
}
};
const setActivationBusy=(activation,busy)=>{const root=activation?.root;if(!root)return;if(busy)root.setAttribute?.("aria-busy","true");else root.removeAttribute?.("aria-busy");if("inert"in root)root.inert=busy};
const disposeActivation=activation=>{
if(!activation.mountStarted) return Promise.resolve();
if(activation.disposalPromise) return activation.disposalPromise;
activation.disposalPromise=Promise.resolve().then(()=>{
if(typeof activation.disposer==="function") return activation.disposer();
if(typeof activation.feature?.unmount==="function") return activation.feature.unmount();
});
return activation.disposalPromise;
};
const cleanupActivation=activation=>{
if(!activation) return Promise.resolve();
activation.controller.abort();
activation.pendingRender=null;
if(activation.cleanupPromise) return activation.cleanupPromise;
if(activation.mountPromise&&!activation.mountSettled) {
discardFeature(activation);
void activation.mountPromise.then(
()=>disposeActivation(activation),
()=>disposeActivation(activation)
).catch(error=>reportFailure(activation,"unmount",error));
activation.cleanupPromise=Promise.resolve();
} else {
activation.cleanupPromise=disposeActivation(activation);
}
activation.cleanupPromise=activation.cleanupPromise.catch(error=>{
discardFeature(activation);
throw error;
});
activation.cleanupPromise=activation.cleanupPromise.finally(()=>{
setActivationBusy(activation,false);
if(activation.cancelled&&!activation.failed) activation.ready.resolve();
});
return activation.cleanupPromise;
};
const failActivation=(activation,phase,error)=>{
if(!isCurrent(activation)) return false;
current=null;
activation.failed=true;
activation.controller.abort();
discardFeature(activation);
void enqueue(async ()=>{
try {
await cleanupActivation(activation);
} catch {}
reportFailure(activation,phase,error);
activation.ready.reject(error);
});
return true;
};
const scheduleRender=(activation,snapshot,changedDomains)=>{
if(!isCurrent(activation)) return;
activation.pendingRender=mergeRender(activation.pendingRender,snapshot,changedDomains);
if(!activation.mounted||typeof activation.feature?.render!=="function") return;
if(activation.renderTask) return;
activation.renderTask=(async ()=>{
while(isCurrent(activation)&&activation.pendingRender) {
const next=activation.pendingRender;
activation.pendingRender=null;
try {
await activation.feature.render({
...next,
signal: activation.controller.signal,
generation: activation.generation,
route: activation.route
});
} catch(error) {
failActivation(activation,"render",error);
return;
}
}
})().finally(()=>{
activation.renderTask=null;
if(isCurrent(activation)&&activation.pendingRender) {
scheduleRender(activation,activation.pendingRender.snapshot,activation.pendingRender.changedDomains);
}
});
};
const runActivation=async activation=>{
let phase="import";
try {
activation.root=typeof activation.record.descriptor.root==="function"?activation.record.descriptor.root(activation.route):activation.record.descriptor.root;
setActivationBusy(activation,true);
const feature=await loadFeature(activation);
if(!isCurrent(activation)) return;
activation.feature=feature;
phase="mount";
activation.mountStarted=true;
activation.mountPromise=Promise.resolve().then(()=>feature.mount({
root:activation.root,
route: activation.route,
signal: activation.controller.signal
})).then(
disposer=>{
activation.mountSettled=true;
if(typeof disposer==="function") activation.disposer=disposer;
},
error=>{
activation.mountSettled=true;
throw error;
}
);
await activation.mountPromise;
if(!isCurrent(activation)) return;
activation.mounted=true;
setActivationBusy(activation,false);
if(activation.pendingRender) {
const pending=activation.pendingRender;
activation.pendingRender=null;
scheduleRender(activation,pending.snapshot,pending.changedDomains);
}
activation.ready.resolve();
} catch(error) {
if(!failActivation(activation,phase,error)) {
try {
await cleanupActivation(activation);
} catch {}
activation.ready.resolve();
}
}
};
const enter=(view,route)=>{
if(stopped) return Promise.reject(new Error("Feature registry has stopped"));
if(resetFailure) {
return Promise.reject(new Error("Feature registry is locked after session reset failure",{
cause: resetFailure
}));
}
const record=records.get(String(view));
if(!record) return Promise.reject(new Error(`Unknown feature view: ${view}`));
const key=routeKey(route);
if(current?.view===String(view)&&current.routeKey===key) return current.ready.promise;
const previous=current;
retire(previous);
const activation={
view: String(view),
route,
routeKey: key,
record,
root:null,
generation: ++generation,
epoch,
controller: new AbortController(),
ready: deferred(),
feature: null,
mountStarted: false,
mounted: false,
mountPromise: null,
mountSettled: false,
disposer: null,
disposalPromise: null,
cleanupPromise: null,
renderTask: null,
pendingRender: null,
cancelled: false,
failed: false
};
current=activation;
activityRevision += 1;
void enqueue(async ()=>{
if(resetFailure) {
if(current===activation) current=null;
activation.failed=true;
retire(activation);
await cleanupActivation(activation);
activation.ready.reject(new Error("Feature registry is locked after session reset failure",{
cause: resetFailure
}));
return;
}
try {
await cleanupActivation(previous);
} catch(error) {
if(current===activation) current=null;
retire(activation);
activation.ready.reject(error);
return;
}
if(!isCurrent(activation)) {
await cleanupActivation(activation);
return;
}
void runActivation(activation);
});
return activation.ready.promise;
};
const leave=view=>{
if(stopped) return stopPromise||Promise.resolve();
if(!current||current.view!==String(view)) return Promise.resolve();
const activation=current;
current=null;
retire(activation);
return enqueue(()=>cleanupActivation(activation));
};
const notifyState=(snapshot,changedDomains)=>{
if(stopped) return;
activityRevision += 1;
if(current) scheduleRender(current,snapshot,changedDomains);
};
const resetSession=()=>{
if(stopped) return stopPromise||Promise.resolve();
if(resetFailure) {
return Promise.reject(new Error("Feature registry is locked after session reset failure",{
cause: resetFailure
}));
}
const targetRevision=activityRevision;
if(!current&&targetRevision <= resetScheduledThrough) return lastResetPromise;
resetScheduledThrough=Math.max(resetScheduledThrough,targetRevision);
epoch += 1;
const activation=current;
current=null;
retire(activation);
const features=new Set([
...[...records.values()].map(record=>record.feature).filter(Boolean),
...(activation?.feature?[activation.feature] : [])
]);
for(const record of records.values()) {
record.feature=null;
record.featureEpoch=-1;
record.loadPromise=null;
record.loadEpoch=-1;
}
lastResetPromise=enqueue(async ()=>{
if(resetFailure) {
throw new Error("Feature registry is locked after session reset failure",{
cause: resetFailure
});
}
const errors=[];
try {
await cleanupActivation(activation);
} catch(error) {
errors.push(error);
}
for(const feature of features) {
if(typeof feature.resetSession!=="function") continue;
try {
await feature.resetSession();
} catch(error) {
errors.push(error);
}
}
if(errors.length) {
resetFailure=errors[0];
throw errors[0];
}
});
return lastResetPromise;
};
const stop=()=>{
if(stopPromise) return stopPromise;
stopped=true;
epoch += 1;
const activation=current;
current=null;
retire(activation);
for(const record of records.values()) {
record.feature=null;
record.loadPromise=null;
}
stopPromise=enqueue(()=>cleanupActivation(activation));
return stopPromise;
};
return Object.freeze({enter,leave,notifyState,resetSession,stop});
}
