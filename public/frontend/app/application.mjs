const REQUIRED_METHODS=Object.freeze({router:["start","currentRoute"],featureRegistry:["enter","leave","notifyState","resetSession","stop"],session:["resetSession"],state:["start","subscribe","snapshot","resetSession","stop"],sync:["start","resetSession","stop"],shell:["start","resetSession","stop"]});
function assertPort(name,port){if(!port||typeof port!=="object")throw new TypeError(`${name} port is required`);for(const method of REQUIRED_METHODS[name])if(typeof port[method]!=="function")throw new TypeError(`${name}.${method} must be a function`)}
function routeView(route){const view=route?.view;if(typeof view!=="string"||!view)throw new TypeError("router route must provide a non-empty view");return view}
function captureOutcome(operation){try{return Promise.resolve(operation()).then(()=>null,error=>error)}catch(error){return Promise.resolve(error)}}
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return{promise,resolve,reject}}
async function collectOutcome(errors,outcome) {
const error=await outcome;
if(error) errors.push(error);
}
function aggregateFailure(message,errors,cause) {
if(!errors.length) return null;
return new AggregateError(errors,message,cause?{cause} : undefined);
}
function withCleanupFailure(primary,cleanupErrors,message) {
if(!cleanupErrors.length) return primary;
return aggregateFailure(message,[primary,...cleanupErrors],primary);
}
function lifecycleInvalidated() {
const error=new Error("Browser application lifecycle changed during start");
error.name="AbortError";
return error;
}
function lifecycleStopped() {
return new Error("Browser application has stopped");
}
function lifecycleLocked(cause) {
return new Error("Browser application is locked after cleanup failure",{cause});
}
function lifecyclePortTimedOut(label,timeoutMs) {
const error=new Error(`Browser application lifecycle port timed out after ${timeoutMs}ms: ${label}`);
error.name="LifecyclePortTimeoutError";
return error;
}
export function createBrowserApplication({
router,
featureRegistry,
session,
state,
sync,
shell,
lifecyclePortTimeoutMs=5000
}={}) {
const ports={router,featureRegistry,session,state,sync,shell};
for(const name of Object.keys(REQUIRED_METHODS)) assertPort(name,ports[name]);
if(!Number.isFinite(lifecyclePortTimeoutMs)
|| lifecyclePortTimeoutMs <= 0
|| lifecyclePortTimeoutMs > 2_147_483_647) {
throw new TypeError("lifecyclePortTimeoutMs must be a positive finite timer delay");
}
let phase="idle";
let generation=0;
let cycle=null;
let startPromise=null;
let resetPromise=null;
let stopPromise=null;
let lockCause=null;
const guardLifecycleReference=(candidate,value,label)=>{
const thenable=value != null
&& (typeof value==="object"||typeof value==="function")
&& typeof value.then==="function";
if(!thenable) return value;
const references=[
[candidate?.resetPromise,"candidate reset"],
[startPromise,"start"],
[resetPromise,"reset"],
[stopPromise,"stop"]
];
const reference=references.find(([promise])=>promise&&value===promise);
if(!reference) return value;
const error=new Error(
`Browser application lifecycle self-reference: ${label} returned the current ${reference[1]} promise`
);
error.name="LifecycleSelfReferenceError";
throw error;
};
const settlePort=(candidate,value,label,onLateValue)=>{
const guarded=guardLifecycleReference(candidate,value,label);
if(guarded == null
|| (typeof guarded!=="object"&&typeof guarded!=="function")
|| typeof guarded.then!=="function") return guarded;
let timeoutId;
let timedOut=false;
const pending=Promise.resolve(guarded);
pending.then(
result=>timedOut&&onLateValue?.(result),
()=>{}
).catch(()=>{});
const timeout=new Promise((_,reject)=>{
timeoutId=setTimeout(
()=>{
timedOut=true;
reject(lifecyclePortTimedOut(label,lifecyclePortTimeoutMs));
},
lifecyclePortTimeoutMs
);
});
return Promise.race([pending,timeout]).finally(()=>clearTimeout(timeoutId));
};
const callPort=(candidate,label,operation,onLateValue)=>(
settlePort(candidate,operation(),label,onLateValue)
);
const portOutcome=(candidate,label,operation)=>(
captureOutcome(()=>callPort(candidate,label,operation))
);
const collectPortOperation=async (errors,candidate,label,operation)=>{
await collectOutcome(errors,portOutcome(candidate,label,operation));
};
const isCurrent=candidate=>(
cycle===candidate
&& generation===candidate.generation
&& !candidate.invalidated
&& (phase==="starting"||phase==="started")
);
const invalidateCandidate=candidate=>{
if(!candidate||candidate.invalidated) return;
candidate.invalidated=true;
candidate.controller.abort();
};
const lockApplication=failure=>{
if(lockCause) return lockCause;
lockCause=failure;
if(!stopPromise&&phase!=="stopped") {
generation += 1;
phase="locked";
invalidateCandidate(cycle);
}
return lockCause;
};
const invokeDisposer=registration=>{
registration.outcome ||= portOutcome(
registration.candidate,
`${registration.label} disposer`,
registration.dispose
);
return registration.outcome;
};
const saveDisposer=async (candidate,value,label)=>{
if(value == null) return;
if(typeof value!=="function") {
throw new TypeError(`${label} must return a disposer function or undefined`);
}
const registration={
candidate,
dispose: value,
label,
outcome: null
};
if(!candidate.invalidated) {
candidate.disposers.push(registration);
return;
}
const error=await invokeDisposer(registration);
if(error) {
lockApplication(aggregateFailure(
"Browser application disposer cleanup failed",
[error]
));
throw error;
}
};
const callDisposerPort=async (candidate,label,operation)=>{
const value=await callPort(
candidate,
label,
operation,
lateValue=>saveDisposer(candidate,lateValue,label)
);
await saveDisposer(candidate,value,label);
};
const disposeCycle=async candidate=>{
const errors=[];
if(!candidate) return errors;
const pending=candidate.disposers.splice(0).reverse();
for(const registration of pending) {
await collectOutcome(errors,invokeDisposer(registration));
}
return errors;
};
const runResetCycle=async candidate=>{
const errors=[];
const sessionOutcome=candidate.sessionOutcome
||= portOutcome(candidate,"session.resetSession",()=>session.resetSession());
await collectOutcome(errors,sessionOutcome);
errors.push(...await disposeCycle(candidate));
const resetPorts=[
[candidate.syncTouched,"sync.resetSession",()=>sync.resetSession()],
[candidate.featureTouched,"featureRegistry.resetSession",()=>featureRegistry.resetSession()],
[candidate.stateTouched,"state.resetSession",()=>state.resetSession()],
[candidate.shellTouched,"shell.resetSession",()=>shell.resetSession()]
];
for(const [touched,label,operation] of resetPorts) {
if(touched) await collectPortOperation(errors,candidate,label,operation);
}
return errors;
};
const resetCycle=candidate=>{
if(candidate.resetPromise) return candidate.resetPromise;
const operation=deferred();
candidate.resetPromise=operation.promise;
Promise.resolve()
.then(()=>runResetCycle(candidate))
.then(operation.resolve,operation.reject);
return operation.promise;
};
const resetCycleFailure=(candidate,errors)=>{
if(!errors.length) return null;
candidate.cleanupFailure ||= aggregateFailure(
"Browser application session reset failed",
errors
);
return candidate.cleanupFailure;
};
const guardedRouteHandlers=candidate=>Object.freeze({
enter(nextRoute) {
if(!isCurrent(candidate)) return Promise.resolve(false);
return featureRegistry.enter(routeView(nextRoute),nextRoute);
},
leave(previousRoute) {
if(!isCurrent(candidate)) return Promise.resolve(false);
return featureRegistry.leave(routeView(previousRoute));
}
});
const runStart=async (candidate,initial)=>{
try {
const signal=candidate.controller.signal;
await callDisposerPort(
candidate,
"router.start",
()=>router.start(guardedRouteHandlers(candidate),signal)
);
if(!isCurrent(candidate)) throw lifecycleInvalidated();
const initialRoute=router.currentRoute();
candidate.featureTouched=true;
await callPort(
candidate,
"featureRegistry.enter",
()=>featureRegistry.enter(routeView(initialRoute),initialRoute)
);
if(!isCurrent(candidate)) throw lifecycleInvalidated();
candidate.stateTouched=true;
await callDisposerPort(
candidate,
"state.start",
()=>state.start(initial?.state,signal)
);
if(!isCurrent(candidate)) throw lifecycleInvalidated();
await callDisposerPort(
candidate,
"state.subscribe",
()=>state.subscribe((snapshot,changedDomains)=>{
if(isCurrent(candidate)) {
featureRegistry.notifyState(snapshot,changedDomains);
}
})
);
if(!isCurrent(candidate)) throw lifecycleInvalidated();
featureRegistry.notifyState(state.snapshot());
candidate.syncTouched=true;
await callDisposerPort(
candidate,"sync.start",()=>sync.start(initial?.sync,signal)
);
if(!isCurrent(candidate)) throw lifecycleInvalidated();
candidate.shellTouched=true;
await callDisposerPort(
candidate,"shell.start",()=>shell.start(initial?.shell,signal)
);
if(!isCurrent(candidate)) throw lifecycleInvalidated();
phase="started";
} catch(error) {
if(candidate.invalidated) throw error;
if(cycle===candidate) {
generation += 1;
phase="resetting";
startPromise=null;
}
const cleanupPromise=resetCycle(candidate);
invalidateCandidate(candidate);
const cleanupErrors=await cleanupPromise;
const cleanupFailure=resetCycleFailure(candidate,cleanupErrors);
if(cleanupFailure) {
lockApplication(cleanupFailure);
} else if(cycle===candidate) {
cycle=null;
phase=stopPromise?"stopping" : "idle";
}
throw withCleanupFailure(
error,
cleanupErrors,
"Browser application start failed and cleanup reported errors"
);
}
};
const launchStart=(operation,initial)=>{
resetPromise=null;
const candidate={
generation: ++generation,
controller: new AbortController(),
invalidated: false,
disposers: [],
featureTouched: false,
stateTouched: false,
syncTouched: false,
shellTouched: false,
sessionOutcome: null,
resetPromise: null,
cleanupFailure: null
};
cycle=candidate;
phase="starting";
runStart(candidate,initial).then(operation.resolve,operation.reject);
};
const queueStart=(initial,pendingReset,pendingCandidate)=>{
const operation=deferred();
startPromise=operation.promise;
startPromise.catch(()=>{});
(async ()=>{
const resetErrors=await pendingReset;
if(Array.isArray(resetErrors)) {
const failure=pendingCandidate
? resetCycleFailure(pendingCandidate,resetErrors)
: aggregateFailure("Browser application session reset failed",resetErrors);
if(failure) {
lockApplication(failure);
throw failure;
}
}
if(stopPromise||phase==="stopped") throw lifecycleStopped();
if(lockCause) throw lifecycleLocked(lockCause);
launchStart(operation,initial);
})().catch(error=>{
if(startPromise===operation.promise) startPromise=null;
operation.reject(error);
});
return operation.promise;
};
function start(initial={}) {
if(stopPromise||phase==="stopped") {
return Promise.reject(lifecycleStopped());
}
if(lockCause) {
return Promise.reject(lifecycleLocked(lockCause));
}
if(phase==="resetting") {
if(startPromise) return startPromise;
const pendingReset=resetPromise||cycle?.resetPromise;
if(!pendingReset) {
return Promise.reject(new Error("Browser application reset is unavailable"));
}
return queueStart(initial,pendingReset,cycle);
}
if(startPromise) return startPromise;
const operation=deferred();
startPromise=operation.promise;
startPromise.catch(()=>{});
launchStart(operation,initial);
return operation.promise;
}
function resetSession() {
if(stopPromise||phase==="stopped") return stopPromise||Promise.resolve();
if(resetPromise) return resetPromise;
if(lockCause) return Promise.reject(lifecycleLocked(lockCause));
const candidate=cycle||{
generation,
controller: new AbortController(),
invalidated: false,
disposers: [],
featureTouched: true,
stateTouched: true,
syncTouched: true,
shellTouched: true,
sessionOutcome: null,
resetPromise: null,
cleanupFailure: null
};
if(!cycle) cycle=candidate;
const wasResetting=phase==="resetting";
const pendingStart=startPromise;
const operation=deferred();
resetPromise=operation.promise;
if(!wasResetting) startPromise=null;
generation += 1;
phase="resetting";
const cleanupPromise=resetCycle(candidate);
invalidateCandidate(candidate);
pendingStart?.catch(()=>{});
(async ()=>{
const errors=await cleanupPromise;
const failure=resetCycleFailure(candidate,errors);
if(failure) {
lockApplication(failure);
throw failure;
}
if(cycle===candidate) {
cycle=null;
if(!stopPromise) phase="idle";
}
})().then(operation.resolve,operation.reject);
return operation.promise;
}
function stop() {
if(stopPromise) return stopPromise;
const wasResetting=phase==="resetting";
const candidate=cycle;
const activeReset=wasResetting?candidate?.resetPromise : null;
const pendingStart=startPromise;
const operation=deferred();
stopPromise=operation.promise;
generation += 1;
phase="stopping";
invalidateCandidate(candidate);
pendingStart?.catch(()=>{});
(async ()=>{
const errors=[];
if(activeReset) {
try {
errors.push(...await activeReset);
} catch(error) {
errors.push(error);
}
} else {
const sessionOutcome=candidate
? candidate.sessionOutcome ||= portOutcome(
candidate,
"session.resetSession",
()=>session.resetSession()
)
: portOutcome(null,"session.resetSession",()=>session.resetSession());
await collectOutcome(errors,sessionOutcome);
errors.push(...await disposeCycle(candidate));
}
for(const [label,operation] of [
["shell.stop",()=>shell.stop()],
["sync.stop",()=>sync.stop()],
["state.stop",()=>state.stop()],
["featureRegistry.stop",()=>featureRegistry.stop()]
]) {
await collectPortOperation(errors,candidate,label,operation);
}
cycle=null;
if(startPromise===pendingStart) startPromise=null;
phase="stopped";
const failure=aggregateFailure("Browser application stop failed",errors);
if(failure) throw failure;
})().then(operation.resolve,operation.reject);
return operation.promise;
}
return Object.freeze({start,resetSession,stop});
}
