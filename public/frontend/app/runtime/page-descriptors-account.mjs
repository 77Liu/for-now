import { rotateSession, sessionSerial } from "../../session/index.mjs";
import { publishDomains, state } from "../../state/index.mjs";

export function installAccountDescriptors(descriptors, ports) {
  const {
    runtime,runtimeFeatureLoaders,$,showToast,request,resolvePersonalizedTask,featureRequestV1,
    withFeatureScope,refreshState,contentState,renderLatex,renderAccountIdentity,
    formatCny,compactNumber,formatDate,shiftLocalDateKey,openCommercialSource,
    switchView,openThoughtDetail,renderDate,renderSliders,renderStateChart,
    renderHomeMood,renderChat,dailyTypeMeta,plainPreview,
    escapeHtml,renderMarkdown,authRequest,showAuthGate,logout,apiClient,
    pageAudioCoordinator,localTestScopeLoads,load,invalidatePageLoads,hasCapability,
    ownerConsoleFeatureControllers,accountSettingsFeatureControllers
  } = ports;
  const loadMineShellPage=view=>runtimeFeatureLoaders.mineShell().then(module=>module.createMineShellFeatureController({
    view,
    getUser:()=>runtime.currentUser,
    getSnapshot:()=>state,
    getNotificationUnreadCount:()=>runtime.notificationUnreadCount,
    getSyncHealth:()=>runtime.syncHealth,
    getGovernanceUrl:()=>runtime.governanceUrl,
    getReleaseVersion:()=>runtime.releaseVersion,
    setShellVersion:value=>{const version=$("#sidebar-app-version");if(version)version.textContent=value},
    getDeniedAccess:()=>runtime.deniedAccess
  }));
  descriptors.mine={root:()=>$("#view-mine"),load:()=>loadMineShellPage("mine")};
  descriptors.permission={root:()=>$("#view-permission"),load:()=>loadMineShellPage("permission")};
  descriptors.about={root:()=>$("#view-about"),load:()=>loadMineShellPage("about")};
  descriptors["personal-context"]={
    root:()=>$("#view-personal-context"),
    load:()=>runtimeFeatureLoaders.personalContext().then(module=>module.createPersonalContextFeatureController({
      data:{
        getSnapshot:()=>state,
        getAccountId:()=>runtime.currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        requestV1:(url,options,coordination)=>featureRequestV1("personal-context",url,options,coordination),
        resolvePersonalizedTask
      },
      navigation:{
        activateDate:(date,dailyType)=>{
          runtime.activeDate=date;
          if(dailyType&&dailyTypeMeta[dailyType])runtime.activeDailyType=dailyType;
          renderDate();renderSliders();publishDomains(new Set(["thoughts","activeDate"]));renderStateChart();renderHomeMood();renderChat()
        },
        switchView,
        openThoughtDetail
      },
      view:{contentState,escapeMarkup:escapeHtml,plainPreview,formatDate},
      platform:{
        requestFrame:callback=>requestAnimationFrame(callback),
        queryDestination:selector=>document.querySelector(selector),
        escapeSelector:value=>CSS.escape(value),
        isDetailsElement:value=>value instanceof HTMLDetailsElement,
        confirm:message=>globalThis.confirm(message),
        createRequestId:()=>crypto.randomUUID()
      }
    }))
  };
  const loadOwnerConsolePage=view=>runtimeFeatureLoaders.ownerConsole().then(module=>{
    const controller=module.createOwnerConsoleFeatureController({
      view,
      request:(url,options)=>withFeatureScope(view,()=>request(url,options)),
      requestWithMetadata:(url,options)=>withFeatureScope(view,()=>apiClient.requestWithMetadata(url,options)),
      settings:{snapshot:()=>runtime.llmSettings,currentDate:()=>runtime.currentLocalDate},
      capability:{has:hasCapability,accountId:()=>runtime.currentUser?.id||"",sessionGeneration:()=>sessionSerial},
      format:{
        escapeMarkup:escapeHtml,
        escapeSelector:value=>CSS.escape(value),
        cny:formatCny,
        compactNumber,
        date:formatDate,
        shiftDateKey:shiftLocalDateKey
      },
      navigation:{openView:viewName=>switchView(viewName),openSource:source=>openCommercialSource(source.view,source.id,source.date)},
      toast:showToast,
      confirm:message=>globalThis.confirm(message),
      timer:{schedule:(callback,delay)=>setTimeout(callback,delay),cancel:timer=>clearTimeout(timer)}
    });
    ownerConsoleFeatureControllers.add(controller);
    return controller
  });
  for(const view of["ai-cost","architecture","commercialization"]){
    descriptors[view]={root:()=>$(`#view-${view}`),load:()=>loadOwnerConsolePage(view)}
  }
  const loadAccountSettingsPage=view=>runtimeFeatureLoaders.accountSettings().then(module=>{
    const controller=module.createAccountSettingsFeatureController({
      view,
      auth:{request:authRequest,reset:showAuthGate,logout},
      request:{
        json:(url,options)=>request(url,options),
        blob:(url,options,config)=>apiClient.requestBlob(url,options,config)
      },
      currentUser:{
        get:()=>runtime.currentUser,
        set:user=>{runtime.currentUser=user;renderAccountIdentity()}
      },
      settings:{get:()=>runtime.llmSettings,set:value=>{runtime.llmSettings=value}},
      speech:{get:()=>state.speech||{}},
      localTest:{
        get:()=>runtime.localTestConfig,
        set:value=>{runtime.localTestConfig=value},
        clearScopes:()=>localTestScopeLoads.clear(),
        reload:()=>load(),
        navigate:viewName=>switchView(viewName),
        setSummary:value=>{const summary=$("#mine-settings-summary");if(summary)summary.textContent=value}
      },
      session:{reset:()=>{
        rotateSession();
        invalidatePageLoads();
        for(const ownerController of ownerConsoleFeatureControllers)ownerController.resetSession()
      }},
      pageAudio:pageAudioCoordinator,
      hasCapability,
      showToast,
      confirmAction:message=>globalThis.confirm(message)
    });
    accountSettingsFeatureControllers.add(controller);
    return controller
  });
  descriptors.account={root:()=>$("#view-account"),load:()=>loadAccountSettingsPage("account")};
  descriptors.settings={root:()=>$("#view-settings"),load:()=>loadAccountSettingsPage("settings")};
  descriptors.trash={
    root:()=>$("#view-trash"),
    load:()=>runtimeFeatureLoaders.trash().then(module=>module.createTrashFeatureController({
      data:{
        getAccountId:()=>runtime.currentUser?.id||"",
        getSessionSerial:()=>sessionSerial,
        request:(url,options)=>withFeatureScope("trash",()=>request(url,options)),
        refresh:(domains,options)=>refreshState(domains,options)
      },
      view:{
        formatDate,
        contentState,
        escapeMarkup:escapeHtml,
        plainPreview,
        renderMarkdown,
        renderLatex,
        showToast
      },
      platform:{
        confirm:message=>globalThis.confirm(message),
        prompt:message=>globalThis.prompt(message)
      }
    }))
  };
}
