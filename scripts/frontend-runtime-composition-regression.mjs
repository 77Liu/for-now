import { createTestSupportBridge } from "../public/frontend/app/runtime/loaders.mjs";
import { createViewScopeSupport } from "../public/generated/test-support/view-scope.mjs";
import { createBackgroundThoughtAnswerRuntime } from "../public/frontend/app/runtime/personalized-task-runtime.mjs";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHomeFeatureController } from "../public/frontend/features/home/index.mjs";
import { analyzeEntrypointSource } from "./lib/entrypoint-source-analysis.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = relativePath => fs.readFile(path.join(root, relativePath), "utf8");
const lines = source => source.trimEnd().split(/\r\n|\r|\n/u).length;

const boundaries = JSON.parse(await read("knowledge/module-boundaries.json"));
const policy = boundaries.entrypointPolicies.find(item => item.kind === "browser");
const runtime = await read(policy.path);
const analysis = analyzeEntrypointSource(runtime, policy.path, policy.forbiddenRules);

assert.ok(lines(runtime) <= policy.lineLimits.hard, "browser entrypoint exceeds the G6 hard limit");
assert.deepEqual(analysis.violations, [], "browser entrypoint contains non-composition behavior");
assert.deepEqual(
  analysis.surface.exports.map(item => item.name).sort(),
  ["startApplication"]
);
assert.equal(boundaries.entrypointMigrationExceptions.length, 0);
assert.equal(policy.pageFeatureDescriptors.length, policy.expectedPages.length);
assert.deepEqual(
  policy.pageFeatureDescriptors.map(item => item.page).sort(),
  [...policy.expectedPages].sort()
);
assert.equal(
  policy.pageFeatureDescriptors.some(item => item.feature.includes("legacy")),
  false
);

const runtimeModules = [
  "public/frontend/app/runtime/auth-events.mjs",
  "public/frontend/app/runtime/collaboration-runtime.mjs",
  "public/frontend/app/runtime/content-media-runtime.mjs",
  "public/frontend/app/runtime/data-runtime.mjs",
  "public/frontend/app/runtime/data-sync-runtime.mjs",
  "public/frontend/app/runtime/durable-form-drafts.mjs",
  "public/frontend/app/runtime/global-events.mjs",
  "public/frontend/app/runtime/checkin-events.mjs",
  "public/frontend/app/runtime/home-chat-renderer.mjs",
  "public/frontend/app/runtime/home-checkin-renderer.mjs",
  "public/frontend/app/runtime/home-formatters.mjs",
  "public/frontend/app/runtime/home-runtime.mjs",
  "public/frontend/app/runtime/home-selection-quote-modal.mjs",
  "public/frontend/app/runtime/kernel.mjs",
  "public/frontend/app/runtime/loaders.mjs",
  "public/frontend/app/runtime/onboarding-events.mjs",
  "public/frontend/app/runtime/quote-events.mjs",
  "public/frontend/app/runtime/record-events.mjs",
  "public/frontend/app/runtime/page-descriptors-account.mjs",
  "public/frontend/app/runtime/page-descriptors-insights.mjs",
  "public/frontend/app/runtime/page-descriptors-primary.mjs",
  "public/frontend/app/runtime/page-descriptors.mjs",
  "public/frontend/app/runtime/session-runtime.mjs",
  "public/frontend/app/runtime/startup-timing.mjs",
  "public/frontend/app/runtime/thought-draft-tag-composer.mjs"
];
// 使用真实动态产物路径连接适配器；非模拟配置不进入加载/会话分支。
{
  let mode="disabled", activations=0;
  const bridge=createTestSupportBridge({getControl:()=>({mode}),
    getOwner:()=>{activations+=1;return "adapter-owner"},getSession:()=>1,
    fail:error=>{throw error}});
  assert.equal(await bridge.ensureView("mine"),true);
  assert.equal(activations,0);
  mode="simulation";
  assert.equal(await bridge.ensureView("mine"),true,"真实生成适配器路径必须能加载");
  assert.equal(activations>0,true);
  bridge.reset();
}
// 隔离测试支持：非模拟模式无请求，在途复用，重置后的迟到结果不影响新任务。
{
  let owner="account-a", serial=1, control={ mode:"disabled", loadedScopes:[] }, calls=0;
  const waiting=[], effects=[], panel={busy:false,setAttribute(){this.busy=true},removeAttribute(){this.busy=false}};
  const support=createViewScopeSupport({
    getControl:()=>control,getOwner:()=>owner,getSession:()=>serial,getPanel:()=>panel,
    request:()=>{calls+=1;return new Promise(resolve=>waiting.push(resolve))},
    setControl:value=>{control=value;effects.push("control")},replaceSnapshot:()=>effects.push("replace"),
    publishSnapshot:(_,source)=>effects.push(source),setUnreadCount:value=>effects.push(value),
    markRouteLoaded:()=>effects.push("route"),render:()=>effects.push("render"),fail:()=>effects.push("failure")
  });
  assert.equal(await support.ensureView("captures"),true);
  assert.equal(calls,0);
  control={mode:"simulation",loadedScopes:[]};
  const old=support.ensureView("captures");
  assert.equal(support.ensureView("captures"),old);
  await Promise.resolve();assert.equal(calls,1);
  owner="account-b";serial+=1;support.reset();assert.equal(panel.busy,false);
  const next=support.ensureView("captures");await Promise.resolve();assert.equal(calls,2);
  waiting[0]({control:{mode:"simulation",loadedScopes:["captures"]},state:{notificationUnread:7}});
  assert.equal(await old,false);assert.equal(panel.busy,true);assert.deepEqual(effects,[]);
  waiting[1]({control:{mode:"simulation",loadedScopes:["captures"]},state:{notificationUnread:3}});
  assert.equal(await next,true);assert.equal(panel.busy,false);
  assert.deepEqual(effects,["control","replace","local-test-hydrate",3,"route","render"]);
  await support.ensureView("captures");await support.ensureView("mine");assert.equal(calls,2);
}
// 记录端响应已有任务只接入；通知失败和会话失效不得重复POST或更新新账户界面。
{
  const runtime={currentUser:{id:"record-owner-a"}};let serial=1,posts=0,refreshes=0,polls=0;
  const tasks=[],messages=[];
  const task={id:"record-existing",kind:"thoughtAnswer",targetId:"record-root",inputVersion:1,status:"queued"};
  const start=createBackgroundThoughtAnswerRuntime({runtime,getSessionSerial:()=>serial,getTasks:()=>tasks,
    request:async()=>{posts+=1;return task},refreshState:async()=>{refreshes+=1;return false},
    scheduleNotificationPoll:()=>polls+=1,setAnswerStatus:(...args)=>messages.push(args),showToast:()=>{},createRequestId:()=>"record-stable-key"});
  assert.equal(await start({id:"record-root",version:1},task),task);
  assert.equal(posts,0);assert.equal(tasks.length,1);assert.equal(refreshes,1);assert.equal(polls,1);
  assert.match(messages[0][1],/通知暂未读取成功/);
  assert.equal(await start({id:"record-root",version:1}),task);assert.equal(posts,1);assert.equal(tasks.length,1);
  const late=createBackgroundThoughtAnswerRuntime({runtime,getSessionSerial:()=>serial,getTasks:()=>tasks,
    request:async()=>{runtime.currentUser={id:"record-owner-b"};serial+=1;return task},refreshState:async()=>true,
    scheduleNotificationPoll:()=>{throw new Error("late poll")},setAnswerStatus:()=>{throw new Error("late UI")},showToast:()=>{throw new Error("late toast")},createRequestId:()=>"record-late-key"});
  assert.equal(await late({id:"record-root",version:1}),false);
}
const kernelSource=await read("public/frontend/app/runtime/kernel.mjs");
assert.doesNotMatch(kernelSource,/LOCAL_TEST_VIEW_SCOPES|api\/local-test-mode\/hydrate|enqueueThoughtAnswer/);
assert.match(kernelSource,/createBackgroundThoughtAnswerRuntime/);
for (const modulePath of runtimeModules) {
  const source = await read(modulePath);
  assert.ok(lines(source) <= 500, `${modulePath} exceeds the 500-line owner limit`);
  assert.equal(source.includes("legacy-pages"), false, `${modulePath} depends on legacy pages`);
}

const dynamicImports = analysis.surface.imports
  .filter(item => item.dynamic)
  .map(item => item.specifier)
  .sort();
assert.deepEqual(dynamicImports, [
  "../features/account-settings/loader.mjs",
  "../features/actions/controller.mjs",
  "../features/annotations/index.mjs",
  "../features/background-results/index.mjs",
  "../features/capture-journal/index.mjs",
  "../features/export/index.mjs",
  "../features/feedback/index.mjs",
  "../features/health/controller.mjs",
  "../features/keepsakes/index.mjs",
  "../features/library/index.mjs",
  "../features/mine-shell/index.mjs",
  "../features/notifications/index.mjs",
  "../features/owner-console/loader.mjs",
  "../features/personal-context/loader.mjs",
  "../features/quotes/index.mjs",
  "../features/review-insights/index.mjs",
  "../features/thought-discovery/index.mjs",
  "../features/thoughts/index.mjs",
  "../features/trash/loader.mjs",
  "./runtime/kernel.mjs"
]);

const loaderSource = await read("public/frontend/app/runtime/loaders.mjs");
for (const name of [
  "accountSettings",
  "annotations",
  "backgroundResults",
  "captureJournal",
  "health",
  "keepsakes",
  "library",
  "mineShell",
  "ownerConsole",
  "personalContext",
  "quotes",
  "reviewInsights",
  "thoughts",
  "trash"
]) {
  assert.ok(loaderSource.includes(`${name}: () => retryable("${name}")`));
}
assert.match(loaderSource, /if \(requests\[name\] === pending\) requests\[name\] = null/);

const bootstrap = await read("public/frontend/app/bootstrap.mjs");
const serviceWorker = await read("public/service-worker.js");
assert.equal(bootstrap.includes("LegacyFeature"), false);
assert.equal(serviceWorker.includes("features/legacy-pages"), false);
for (const modulePath of runtimeModules) {
  assert.ok(
    serviceWorker.includes(modulePath.replace(/^public\//u, "")),
    `service worker does not cache ${modulePath}`
  );
}

{
  const summary = { textContent: "" };
  const details = {
    open: true,
    addEventListener() {},
    removeEventListener() {}
  };
  const rootElement = {
    querySelector(selector) {
      if (selector === "#actions-summary") return summary;
      if (selector === ".home-v02-secondary") return details;
      return null;
    }
  };
  const actionSnapshot = {
    actions: [{ id: "a1" }],
    habits: [],
    habitCheckins: [],
    today: "2026-10-06"
  };
  const rendered = [];
  let allowed = false;
  let loads = 0;
  const controller = createHomeFeatureController({
    coordinator: {
      load: async () => {
        loads += 1;
        return true;
      },
      subscribe(listener) {
        listener(actionSnapshot);
        return () => {};
      },
      viewModel(snapshot) {
        return {
          summary: {
            openActions: snapshot.actions.length,
            checkedToday: snapshot.habitCheckins.length,
            activeHabits: snapshot.habits.length
          }
        };
      },
      resetSession() {}
    },
    canLoad: () => allowed,
    loadWorkspace: async () => ({
      createActionsFeatureController: () => ({
        mount() {},
        render(context) {
          rendered.push(context);
          return true;
        },
        unmount() {},
        resetSession() {}
      })
    })
  });
  const activation = new AbortController();
  await controller.mount({ root: rootElement, signal: activation.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.render({
    snapshot: { actions: [], habits: [], habitCheckins: [] },
    changedDomains: ["actions"]
  }), false);
  assert.equal(loads, 0);
  assert.equal(rendered.length, 0);
  await controller.unmount();

  allowed = true;
  await controller.mount({ root: rootElement, signal: activation.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.render({
    snapshot: { actions: [], habits: [], habitCheckins: [] },
    changedDomains: ["actions"]
  });
  assert.equal(summary.textContent, "1 项待推进 · 0/0 个习惯已打卡");
  assert.equal(loads, 1);
  assert.equal(rendered.length, 2);
  assert.equal(rendered.every(context => context?.snapshot === undefined), true);
  await controller.unmount();
}

console.log(
  `Frontend F10 composition checks passed: ${lines(runtime)}-line entrypoint, `
  + `${policy.expectedPages.length} explicit page descriptors, zero G6 exceptions, `
  + `${runtimeModules.length} bounded runtime owners.`
);
