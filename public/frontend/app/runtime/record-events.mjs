import { state } from "../../state/index.mjs";

export function installRecordSubmissionEvents({
  runtime,$,showToast,requestV1,refreshState,applyPendingProjection,
  clearDurableDraft,resetOccurrenceInput,occurrenceFields,
  contentImagePaths,imageRecordPayload,captureRecordPayload,publishDomains,
  clearSubmittedContentImageDraft,discardContentImageUploads,
  renderTagComposer,closeHomeEditors,request,runAnswerInModal,requestStream,
  startBackgroundChainAnswer,commitDraftTags,chainRecordKind,syncChainRecordKind
} = {}) {
  $("#thought-prompt-button").addEventListener("click",async event=>{
    const button=event.currentTarget;
    const question=$("#chain-question");
    const status=$("#thought-prompt-status");
    const selectedDate=runtime.activeDate;
    const owner=runtime.currentUser?.id;
    const requestId=crypto.randomUUID();
    const targetId=$("#chain-form").dataset.draftId||crypto.randomUUID();
    const inputVersion=runtime.chainDraftVersion;
    $("#chain-form").dataset.draftId=targetId;
    if(question.value.trim()){
      status.textContent="问题框已有内容，清空后再生成新的引子。";
      question.focus();
      return
    }

    let changed=false;
    const markChanged=()=>{changed=true};
    question.addEventListener("input",markChanged);
    $("#chain-form").addEventListener("reset",markChanged);
    button.disabled=true;
    button.textContent="正在想…";
    status.textContent="正在找一个可以接住的开头…";
    try{
      const result=await request("/api/thought-prompts",{
        method:"POST",
        body:JSON.stringify({requestId,targetId,inputVersion,...occurrenceFields($("#chain-datetime"))})
      });
      const inputChanged=changed||question.value.trim()||runtime.activeDate!==selectedDate
        ||runtime.currentUser?.id!==owner||(result.requestId&&result.requestId!==requestId);
      if(inputChanged){
        status.textContent="引子已生成；当前输入已变化，请继续你的思考。";
        return
      }
      question.value=result.prompt||"";
      question.focus();
      question.setSelectionRange(question.value.length,question.value.length);
      status.textContent=result.hasHistory
        ?"从之前的记录接了一步；它只是引子，可以随手改。"
        :"先抛来一个轻巧的问题；它只是引子，可以随手改。"
    }catch(error){
      status.textContent=`生成失败：${error.message}`
    }finally{
      question.removeEventListener("input",markChanged);
      $("#chain-form").removeEventListener("reset",markChanged);
      button.disabled=false;
      button.textContent="✦ 给个引子"
    }
  });

  $("#draft-answer-button").addEventListener("click",async event=>{
    const button=event.currentTarget;
    const form=$("#chain-form");
    const question=$("#chain-question");
    const idea=$("#chain-idea");
    const questionText=question.value.trim();
    if(!questionText){
      $("#chain-status").textContent="先写下问题，我才能结合你的记录回答。";
      question.focus();
      return
    }
    const targetId=form.dataset.draftId||crypto.randomUUID();
    const requestId=crypto.randomUUID();
    const inputVersion=runtime.chainDraftVersion;
    const owner=runtime.currentUser?.id;
    const session=runtime.sessionSerial;
    const ideaSnapshot=idea.value;
    form.dataset.draftId=targetId;
    let applied=false;
    const isCurrent=()=>runtime.chainDraftVersion===inputVersion
      &&runtime.currentUser?.id===owner
      &&runtime.sessionSerial===session
      &&question.value.trim()===questionText
      &&idea.value===ideaSnapshot;
    button.disabled=true;
    try{
      await runAnswerInModal({
        title:"生成可编辑回答草稿",
        scene:"thoughtDraft",
        isCurrent,
        requestCall:onEvent=>requestStream("/api/answer-drafts",{
          method:"POST",
          body:JSON.stringify({requestId,targetId,inputVersion,question:questionText,idea:ideaSnapshot})
        },onEvent),
        onDone:result=>{
          if(result.requestId!==requestId||result.targetId!==targetId||Number(result.inputVersion)!==inputVersion)return;
          applied=true;
          runtime.answerDraft=result.draft;
          runtime.answerReasoningDraft=result.reasoningContent||"";
          $("#chain-answer").value=result.draft;
          $("#chain-status").textContent="草稿已填入回答框。请按你的判断修改，再提交整套思考。"
        }
      });
      showToast(
        applied?"回答草稿已生成，可直接修改":"旧草稿已完成，但没有覆盖当前输入",
        applied?"success":"error"
      )
    }catch(error){
      $("#chain-status").textContent=error.message
    }finally{
      button.disabled=false
    }
  });

  $("#chain-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector('[type="submit"]');
    if(button.disabled)return;
    if($("#chain-tags").value.trim())commitDraftTags();
    const recordKind=chainRecordKind();
    const requestId=form.dataset.requestId||crypto.randomUUID();
    const temporaryId=`pending:${requestId}`;
    const answer=$("#chain-answer").value;
    const sourceCaptureId=form.elements.sourceCaptureId.value;
    const sourceCaptureVersion=Number(form.elements.sourceCaptureVersion.value)||0;
    let uploadedPaths=[];
    form.dataset.requestId=requestId;
    button.disabled=true;
    button.textContent="正在保存…";
    $("#chain-status").textContent=recordKind==="capture"?"正在收进念起…":"正在保存整套思考…";
    try{
      const submission=await contentImagePaths("thoughtRoot");
      uploadedPaths=submission.uploadedPaths;
      const eventTime=occurrenceFields($("#chain-datetime"));
      const original=imageRecordPayload({
        content:$("#chain-question").value,
        attachmentPaths:submission.attachmentPaths
      });
      if(recordKind==="capture"){
        const payload={...eventTime,...captureRecordPayload(original),tags:runtime.draftTags};
        const result=(await requestV1("/api/v1/captures",{
          method:"POST",
          headers:{"idempotency-key":requestId},
          body:JSON.stringify(payload)
        },{
          domains:["captures"],
          projection:{kind:"capture.create",temporaryId,payload},
          onQueued:record=>applyPendingProjection(record)
        })).data;
        state.captures=(state.captures||[]).map(item=>item.id===temporaryId?result:item);
        publishDomains(new Set(["captures"]));
        await clearSubmittedContentImageDraft("thoughtRoot");
        runtime.chainDraftVersion+=1;
        form.reset();
        clearDurableDraft("chain-form");
        resetOccurrenceInput($("#chain-datetime"));
        runtime.draftTags=[];
        renderTagComposer();
        runtime.answerDraft="";
        runtime.answerReasoningDraft="";
        delete form.dataset.requestId;
        delete form.dataset.draftId;
        $("#chain-status").textContent="已收进念起。";
        closeHomeEditors();
        void refreshState("captures")
          .catch(error=>showToast(`念起已保存，但页面刷新失败：${error.message}`,"error"));
        showToast("已收进念起");
        return
      }

      const needsAnswer=Boolean(original.content.trim()||original.attachmentPaths.length)
        &&!answer.trim()&&runtime.llmSettings.automaticAnswers?.thoughtAnswer===true;
      const payload={
        ...eventTime,
        question:original.content,
        attachmentPaths:original.attachmentPaths,
        idea:$("#chain-idea").value,
        answer,
        modelDraft:runtime.answerDraft,
        modelReasoning:runtime.answerReasoningDraft,
        tags:runtime.draftTags,
        generateAnswer:needsAnswer,
        ...(sourceCaptureId?{sourceRef:{type:"capture",id:sourceCaptureId,version:sourceCaptureVersion}}:{})
      };
      const result=(await requestV1("/api/v1/thought-chains",{
        method:"POST",
        headers:{"idempotency-key":requestId},
        body:JSON.stringify(payload)
      },{
        domains:["thoughts","aiTasks","notifications"],
        projection:{kind:"thought.chain.create",temporaryId,payload},
        onQueued:record=>applyPendingProjection(record)
      })).data;
      const question=result.items.find(item=>item.type==="question");
      state.thoughts=[
        ...result.items,
        ...(state.thoughts||[]).filter(item=>!String(item.id).startsWith(`${temporaryId}:`))
      ];
      publishDomains(new Set(["thoughts"]));
      await clearSubmittedContentImageDraft("thoughtRoot");
      runtime.chainDraftVersion+=1;
      form.reset();
      clearDurableDraft("chain-form");
      resetOccurrenceInput($("#chain-datetime"));
      runtime.draftTags=[];
      renderTagComposer();
      runtime.answerDraft="";
      runtime.answerReasoningDraft="";
      delete form.dataset.requestId;
      delete form.dataset.draftId;
      $("#chain-status").textContent=needsAnswer
        ?"思考已保存，后台生成一条图文合并回答。"
        :answer.trim()?"已保存为一套完整思考。":"思考已保存，未自动调用 AI。";
      closeHomeEditors();
      void refreshState(["thoughts","review","notifications"],{chainId:question?.id})
        .catch(error=>showToast(`记录已保存，但页面刷新失败：${error.message}`,"error"));
      if(needsAnswer&&question)void startBackgroundChainAnswer(question,result.task);
      showToast(needsAnswer?"思考已保存，可继续记录":"整套思考已保存，不会重复记录")
    }catch(error){
      if(error.syncStatus==="pending"){
        await clearSubmittedContentImageDraft("thoughtRoot");
        runtime.chainDraftVersion+=1;
        form.reset();
        clearDurableDraft("chain-form");
        resetOccurrenceInput($("#chain-datetime"));
        runtime.draftTags=[];
        renderTagComposer();
        runtime.answerDraft="";
        runtime.answerReasoningDraft="";
        delete form.dataset.requestId;
        delete form.dataset.draftId;
        $("#chain-status").textContent=recordKind==="capture"
          ?"念起已留存，网络恢复后自动同步。"
          :"思考已留存，网络恢复后自动同步。";
        closeHomeEditors();
        showToast(recordKind==="capture"?"念起已进入待同步队列":"思考已进入待同步队列")
      }else{
        await discardContentImageUploads("thoughtRoot",uploadedPaths);
        $("#chain-status").textContent=error.message
      }
    }finally{
      button.disabled=false;
      syncChainRecordKind()
    }
  });

  $("#chat-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector("button");
    const requestId=form.dataset.requestId||crypto.randomUUID();
    const payload={...occurrenceFields($("#chat-datetime")),message:$("#chat-input").value};
    form.dataset.requestId=requestId;
    button.disabled=true;
    $("#chat-status").textContent="正在结合你已保存的记录…";
    try{
      await requestV1("/api/v1/chats",{
        method:"POST",
        headers:{"idempotency-key":requestId},
        body:JSON.stringify(payload)
      },{domains:["chats"]});
      delete form.dataset.requestId;
      $("#chat-input").value="";
      resetOccurrenceInput($("#chat-datetime"));
      void refreshState("chat")
        .catch(error=>showToast(`回答已保存，但页面刷新失败：${error.message}`,"error"));
      $("#chat-status").textContent=""
    }catch(error){
      $("#chat-status").textContent=error.syncStatus==="pending"
        ?"问题已留存，网络恢复后自动处理。"
        :error.message
    }finally{
      button.disabled=false
    }
  });

}
