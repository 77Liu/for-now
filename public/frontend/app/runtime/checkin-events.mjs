import { state } from "../../state/index.mjs";

export function installCheckinSubmissionEvent({
  $,$$,showToast,requestV1,refreshState,
  localDateKey,metricConfig,splitTags,clearDurableDraft,resetOccurrenceInput,
  occurrenceFields,renderStateChart,renderHomeMood,renderSliders,closeHomeEditors
} = {}) {
  $("#checkin-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector('[type="submit"]');
    const missing=$$('[data-metric]').filter(input=>input.dataset.confirmed!=="true");
    if(missing.length){
      const labels=missing.map(input=>metricConfig()[input.dataset.metric].label).join("、");
      $("#checkin-status").textContent=`请先确认：${labels}`;
      missing[0].focus();
      return
    }

    const requestId=form.dataset.requestId||crypto.randomUUID();
    const temporaryId=`pending:${requestId}`;
    const payload={
      ...occurrenceFields($("#checkin-datetime")),
      notes:{},
      custom:{},
      factors:splitTags($("#checkin-factors").value)
    };
    let projected=false;
    form.dataset.requestId=requestId;
    button.disabled=true;
    button.textContent="正在保存…";
    $$('[data-metric]').forEach(input=>{
      const key=input.dataset.metric;
      if(input.dataset.custom==="1")payload.custom[key]=Number(input.value);
      else payload[key]=Number(input.value);
      payload.notes[key]=$(`#${CSS.escape(key)}-note`)?.value||""
    });

    try{
      const result=await requestV1("/api/v1/checkins",{
        method:"POST",
        headers:{"idempotency-key":requestId},
        body:JSON.stringify(payload)
      },{
        domains:["checkins"],
        projection:{
          kind:"checkin.create",
          temporaryId,
          payload:{
            ...payload,
            occurredAt:payload.occurredAt,
            occurredOn:payload.occurredOn||localDateKey(payload.occurredAt||new Date())
          }
        },
        onQueued:record=>{
          const occurredAt=payload.occurredAt||record.createdAt;
          const occurredOn=localDateKey(occurredAt);
          state.checkins=[
            {
              id:temporaryId,
              ...payload,
              occurredAt,
              occurredOn,
              createdAt:record.createdAt,
              _sync:{status:"sending",operationId:record.operationId}
            },
            ...(state.checkins||[]).filter(item=>item.id!==temporaryId)
          ];
          projected=true;
          renderStateChart();
          renderHomeMood();
          $("#checkin-status").textContent="已记下，正在同步…"
        }
      });
      state.checkins=(state.checkins||[]).map(item=>item.id===temporaryId?result.data:item);
      renderStateChart();
      renderHomeMood();
      clearDurableDraft("checkin-form");
      form.reset();
      delete form.dataset.requestId;
      renderSliders();
      resetOccurrenceInput($("#checkin-datetime"));
      $("#checkin-status").textContent="此刻状态已保存。";
      closeHomeEditors();
      showToast("此刻状态已保存");
      void refreshState(["checkins","review"])
        .catch(error=>showToast(`状态已保存，但列表刷新失败：${error.message}`,"error"))
    }catch(error){
      if(projected&&error.syncStatus==="pending"){
        const pending=(state.checkins||[]).find(item=>item.id===temporaryId);
        if(pending)pending._sync.status="pending";
        renderStateChart();
        renderHomeMood();
        clearDurableDraft("checkin-form");
        form.reset();
        delete form.dataset.requestId;
        renderSliders();
        resetOccurrenceInput($("#checkin-datetime"));
        $("#checkin-status").textContent="已记下，网络恢复后自动同步。";
        closeHomeEditors();
        showToast("此刻状态已进入待同步队列")
      }else if(projected&&error.syncStatus==="conflict"){
        state.checkins=(state.checkins||[]).filter(item=>item.id!==temporaryId);
        renderStateChart();
        renderHomeMood();
        $("#checkin-status").textContent=`同步冲突：${error.message}。本地内容已保留，请刷新后重试。`;
        showToast("此刻状态同步发生冲突","error")
      }else{
        if(projected){
          state.checkins=(state.checkins||[]).filter(item=>item.id!==temporaryId);
          renderStateChart();
          renderHomeMood()
        }
        $("#checkin-status").textContent=error.message
      }
    }finally{
      button.disabled=false;
      button.textContent="记下此刻"
    }
  });
}

export function installCheckinEditEvent({
  $,$$,showToast,requestV1,refreshState,applyPendingProjection,splitTags
} = {}) {
  $("#edit-checkin-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector('[type="submit"]');
    const id=$("#edit-checkin-id").value;
    const item=(state.checkins||[]).find(value=>value.id===id);
    const payload={
      occurredAt:$("#edit-checkin-datetime").value,
      factors:splitTags($("#edit-checkin-factors").value),
      custom:{},
      notes:{}
    };
    $$('[data-edit-checkin-metric]').forEach(input=>{
      const key=input.dataset.editCheckinMetric;
      if(input.dataset.custom==="1")payload.custom[key]=Number(input.value);
      else payload[key]=Number(input.value);
      payload.notes[key]=$(`[data-edit-checkin-note="${CSS.escape(key)}"]`)?.value||""
    });
    button.disabled=true;
    $("#edit-checkin-status").textContent="正在保存修改…";
    try{
      await requestV1(`/api/v1/checkins/${encodeURIComponent(id)}`,{
        method:"PATCH",
        headers:{"if-match":`"${item?.version||1}"`},
        body:JSON.stringify(payload)
      },{
        domains:["checkins"],
        recoverCommitted:true,
        projection:{kind:"record.update",domain:"checkins",id,payload},
        onQueued:record=>applyPendingProjection(record)
      });
      $("#edit-checkin-modal").hidden=true;
      void refreshState(["checkins","review"])
        .catch(error=>showToast(`状态已更新，但列表刷新失败：${error.message}`,"error"));
      showToast("此刻状态已更新")
    }catch(error){
      if(error.syncStatus==="pending"){
        $("#edit-checkin-modal").hidden=true;
        showToast("状态修改将在网络恢复后同步")
      }else{
        await refreshState(["checkins","review"]).catch(()=>{});
        $("#edit-checkin-status").textContent=error.message
      }
    }finally{
      button.disabled=false
    }
  })
}
