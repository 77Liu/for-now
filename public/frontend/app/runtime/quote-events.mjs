import { state } from "../../state/index.mjs";

export function installQuoteSubmissionEvent({
  $,occurrenceFields,quoteTagsForSubmission,requestV1,
  applyPendingProjection,closeSelectionQuoteModal,refreshState,showToast
} = {}) {
  $("#selection-quote-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector('[type="submit"]');
    const status=$("#selection-quote-status");
    const payload={
      ...occurrenceFields($("#selection-quote-datetime")),
      source:$("#selection-quote-source").value,
      content:$("#selection-quote-content").value,
      tags:quoteTagsForSubmission("selectionQuote")
    };
    const requestId=form.dataset.requestId||crypto.randomUUID();
    const temporaryId=`pending:${requestId}`;
    form.dataset.requestId=requestId;
    button.disabled=true;
    status.textContent="正在收藏…";
    try{
      const result=await requestV1("/api/v1/quotes",{
        method:"POST",
        headers:{"idempotency-key":requestId},
        body:JSON.stringify(payload)
      },{
        domains:["quotes"],
        projection:{kind:"record.create",domain:"quotes",temporaryId,payload},
        onQueued:record=>applyPendingProjection(record)
      });
      state.quotes=(state.quotes||[]).map(item=>item.id===temporaryId?result.data:item);
      delete form.dataset.requestId;
      closeSelectionQuoteModal();
      void refreshState("quotes").catch(error=>
        showToast(`善言已保存，但列表刷新失败：${error.message}`,"error")
      );
      showToast("选中文字已收为善言")
    }catch(error){
      if(error.syncStatus==="pending"){
        closeSelectionQuoteModal();
        showToast("善言已进入待同步队列")
      }else{
        status.textContent=error.message
      }
    }finally{
      button.disabled=false
    }
  })
}
