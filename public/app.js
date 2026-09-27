const appBasePath=new URL(".",import.meta.url).pathname.replace(/\/$/,"");
const appUrl=value=>typeof value==="string"&&value.startsWith("/")&&appBasePath?`${appBasePath}${value}`:value;
const baseMetrics={mood:{label:"情绪",anchors:["非常难受","有些低落","平稳、无明显起伏","感觉不错","轻盈而愉快"]},energy:{label:"精力",anchors:["几乎耗尽","勉强支撑","够用，但有限","精力较好","充沛、想行动"]},stress:{label:"压力",anchors:["快要撑不住","很紧绷","压力明显但可应对","有一点紧绷","身心松弛"]},sleep:{label:"睡眠",anchors:["几乎没休息好","明显不足","基本够用","睡得不错","充分恢复"]}};
const trendLabels=Object.fromEntries(Object.entries(baseMetrics).map(([k,v])=>[k,v.label]));
const localDateKey=(value=new Date())=>{const date=value instanceof Date?value:new Date(value),pad=number=>String(number).padStart(2,"0");return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`};
const llmTiers=["lite","mid","high","ultra"];
const defaultLlmProfiles={lite:{model:"deepseek-flash",effort:"none"},mid:{model:"deepseek-flash",effort:"high"},high:{model:"deepseek-v4-pro",effort:"high"},ultra:{model:"deepseek-v4-pro",effort:"max"}};
const defaultLlmScenarios={thoughtPrompt:"lite",thoughtDraft:"high",thoughtAnswer:"ultra",followUpAnswer:"ultra",chat:"high",diaryLead:"lite",diaryStructure:"mid",diaryTopic:"high",diaryReflection:"ultra",annotationShenji:"high",analysis:"ultra",bookRecognition:"mid",healthRecognition:"mid"};
const viewSections={today:"today",together:"today",daily:"today",captures:"seen",books:"seen",quotes:"seen",keepsakes:"seen",journals:"thought",thoughts:"thought",review:"thought",statistics:"mine",account:"mine",settings:"mine",about:"mine"};
let currentLocalDate=localDateKey();
let state={checkins:[],dailyRecords:[],captures:[],journals:[],journalDraft:null,thoughts:[],chats:[],books:[],keepsakes:[],quotes:[],experiments:[],analyses:[],customMetrics:[],clusters:[],insights:{trends:[],associations:[],aiOnlyThoughtIds:[],weekly:{}}},llmSettings={provider:"deepseek",profiles:structuredClone(defaultLlmProfiles),scenarios:{...defaultLlmScenarios},hasApiKey:false,keyHint:""};
let activeDate=currentLocalDate,activeDailyType="sleep",healthFiles={sleep:[],heartRate:[]},healthPreviewUrls=[],thoughtFilter="all",quoteTimer,quoteScrollFrame=0,quoteSkyIndex=0,answerDraft="",answerReasoningDraft="",toastTimer,draftTags=[],captureDraftTags=[],pendingSelection=null,activeCommentRoot="",activeAnnotationId="",activeShenjiComposer="",answerTaskSerial=0,activeAnswerTaskId=0,pendingBookImages={cover:null,recognition:null},bookPreviewUrls={cover:"",recognition:""},bookImagePasteTarget="recognition",editingBookId="",activeBookId="",bookCreatorOpen=false,journalDraftRestored=false,pendingBookNoteId="",activeBookFeatureNoteId="",bookDetailCondensed=false,activeKeepsakeId="",activeKeepsakeView="presentation",currentUser=null,statisticsData=null,statisticsRequestSerial=0;
const keepsakeEditor={file:null,sourceDataUrl:"",sourceImage:null,sourceCanvas:null,maskCanvas:null,autoBase:null,history:[],mode:"keep",drawing:false,lastPoint:null,source:"manual",originalPath:"",cutoutPath:"",renderFrame:0,segmentSerial:0};
const quoteScrollStates=new WeakMap();
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const escapeHtml=t=>String(t??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
function inlineMarkdown(value){
  const code=[],math=[];
  let source=String(value??"").replace(/\\\((.+?)\\\)/g,(_,tex)=>{const token=`\u0000MATH${math.length}\u0000`;math.push(tex);return token}).replace(/(^|[^\\])\$([^$\n]+)\$/g,(_,prefix,tex)=>{const token=`\u0000MATH${math.length}\u0000`;math.push(tex);return `${prefix}${token}`});
  let text=escapeHtml(source).replace(/`([^`\n]+)`/g,(_,content)=>{const token=`\u0000CODE${code.length}\u0000`;code.push(`<code>${content}</code>`);return token});
  text=text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g,(_,label,url,title)=>{const decoded=url.replace(/&amp;/g,"&");if(!/^(https?:\/\/|mailto:|\/|#)/i.test(decoded))return label;return `<a href="${escapeHtml(decoded)}"${title?` title="${escapeHtml(title)}"`:""}${/^https?:\/\//i.test(decoded)?' target="_blank" rel="noopener noreferrer"':""}>${label}</a>`});
  text=text.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/__([^_\n]+)__/g,"<strong>$1</strong>").replace(/~~([^~\n]+)~~/g,"<del>$1</del>").replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>").replace(/(^|[^_])_([^_\n]+)_/g,"$1<em>$2</em>");
  return text.replace(/\u0000CODE(\d+)\u0000/g,(_,index)=>code[Number(index)]||"").replace(/\u0000MATH(\d+)\u0000/g,(_,index)=>`<span class="latex-inline" data-tex="${encodeURIComponent(math[Number(index)]||"")}"></span>`);
}
function renderMarkdown(value){
  const displayMath=[];
  const source=String(value??"").replace(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g,(_,bracket,dollars)=>{const token=`\n\u0000DISPLAY${displayMath.length}\u0000\n`;displayMath.push((bracket??dollars??"").trim());return token});
  const lines=source.replace(/\r\n?/g,"\n").split("\n"),out=[];
  let paragraph=[],listType="",listItems=[],quote=[],code=[],codeLanguage="",inCode=false;
  const flushParagraph=()=>{if(paragraph.length){out.push(`<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g,"<br>")}</p>`);paragraph=[]}};
  const flushList=()=>{if(listItems.length){out.push(`<${listType}>${listItems.map(item=>`<li>${inlineMarkdown(item)}</li>`).join("")}</${listType}>`);listItems=[];listType=""}};
  const flushQuote=()=>{if(quote.length){out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);quote=[]}};
  const flushAll=()=>{flushParagraph();flushList();flushQuote()};
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    if(/^\u0000DISPLAY\d+\u0000$/.test(line)){flushAll();out.push(line);continue}
    const fence=line.match(/^```\s*([\w-]*)\s*$/);
    if(fence){if(inCode){out.push(`<pre><code${codeLanguage?` class="language-${escapeHtml(codeLanguage)}"`:""}>${escapeHtml(code.join("\n"))}</code></pre>`);code=[];codeLanguage="";inCode=false}else{flushAll();inCode=true;codeLanguage=fence[1]||""}continue}
    if(inCode){code.push(line);continue}
    const next=lines[index+1]||"";
    if(line.includes("|")&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)){
      flushAll();const headers=line.replace(/^\s*\||\|\s*$/g,"").split("|").map(cell=>cell.trim()),rows=[];index+=2;
      while(index<lines.length&&lines[index].includes("|")&&lines[index].trim()){rows.push(lines[index].replace(/^\s*\||\|\s*$/g,"").split("|").map(cell=>cell.trim()));index++}index--;
      out.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map(cell=>`<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${headers.map((_,i)=>`<td>${inlineMarkdown(row[i]||"")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);continue
    }
    if(!line.trim()){flushAll();continue}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){flushAll();out.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);continue}
    if(/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)){flushAll();out.push("<hr>");continue}
    const unordered=line.match(/^\s*[-+*]\s+(.+)$/),ordered=line.match(/^\s*\d+[.)]\s+(.+)$/);
    if(unordered||ordered){flushParagraph();flushQuote();const type=ordered?"ol":"ul";if(listType&&listType!==type)flushList();listType=type;listItems.push((unordered||ordered)[1]);continue}
    const quoted=line.match(/^\s*>\s?(.*)$/);if(quoted){flushParagraph();flushList();quote.push(quoted[1]);continue}
    flushList();flushQuote();paragraph.push(line);
  }
  if(inCode)out.push(`<pre><code${codeLanguage?` class="language-${escapeHtml(codeLanguage)}"`:""}>${escapeHtml(code.join("\n"))}</code></pre>`);else flushAll();
  return out.join("").replace(/\u0000DISPLAY(\d+)\u0000/g,(_,index)=>`<div class="latex-display" data-tex="${encodeURIComponent(displayMath[Number(index)]||"")}"></div>`);
}
function renderLatex(container){if(!container||!window.katex)return;container.querySelectorAll("[data-tex]").forEach(element=>{try{window.katex.render(decodeURIComponent(element.dataset.tex||""),element,{displayMode:element.classList.contains("latex-display"),throwOnError:false,strict:"ignore",trust:false})}catch{element.textContent=decodeURIComponent(element.dataset.tex||"")}})}
function reasoningDisclosure(value){return value?`<details class="saved-reasoning"><summary title="展开模型思考">思考</summary><div class="saved-reasoning-content markdown-content">${renderMarkdown(value)}</div></details>`:""}
function enhanceThoughtMarkdown(container){container?.querySelectorAll(".chain-part").forEach(section=>{const label=section.querySelector(":scope > b")?.textContent;if(label!=="初步想法")return;section.querySelectorAll(":scope > p:not(.missing-part)").forEach(paragraph=>{const rendered=document.createElement("div");rendered.className="markdown-content";rendered.innerHTML=renderMarkdown(paragraph.textContent);paragraph.replaceWith(rendered)})})}
function plainPreview(value){return String(value||"").replace(/!\[([^\]]*)\]\([^)]+\)/g,"$1").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[`*_>#~|]/g,"").replace(/\\[\[\]()]/g," ").replace(/\s+/g," ").trim()}
function responseThreadMarkup(question,children){
  const answers=children.filter(item=>item.type==="answer"),followUps=question.followUps||[],answerText=answers.map(answer=>answer.content||answer.modelDraft||"").filter(Boolean).join("\n\n"),original=answers.length?answers.map(answer=>`<div class="model-answer-content">${reasoningDisclosure(answer.reasoningContent)}<div class="markdown-content">${renderMarkdown(answer.content||answer.modelDraft||"")}</div>${answer.modelDraft&&answer.editedFromModel?`<small class="edit-signal">${answer.content?"由模型草稿修改后保留":"已舍弃模型草稿"}</small>`:""}</div>`).join(""):`<p class="missing-part">尚未回答</p>`;
  const summary=(label,date,preview)=>`<summary><div class="response-summary-copy"><div class="response-summary-head"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(date)}</small></div><p>${escapeHtml(plainPreview(preview)||"尚未回答")}</p></div></summary>`;
  const originalSummary=`<summary><div class="response-summary-copy"><div class="response-summary-head"><strong>原始回答</strong><small>${escapeHtml(answers.length?formatDate(answers[0].createdAt):"尚未回答")}</small></div><div class="response-summary-markdown markdown-content">${answerText?renderMarkdown(answerText):"<p>尚未回答</p>"}</div></div></summary>`;
  const followUpCards=followUps.map((followUp,index)=>`<details class="response-entry" data-followup-id="${followUp.id}">${summary(`追问 ${index+1}`,formatDate(followUp.createdAt),followUp.question)}<div class="response-entry-body"><div class="followup-question"><b>追问问题</b><div class="markdown-content">${renderMarkdown(followUp.question)}</div></div><div class="followup-answer"><b>追问回答</b>${followUp.answer?`<div class="model-answer-content">${reasoningDisclosure(followUp.reasoningContent)}<div class="markdown-content">${renderMarkdown(followUp.answer)}</div></div>`:`<form class="manual-followup-answer" data-followup-manual-answer="${followUp.id}" data-root-id="${question.id}"><textarea rows="3" placeholder="直接写下回答…" aria-label="追问回答" required></textarea><div><button class="quiet-button" type="submit">保存回答</button><button type="button" class="subtle-action answer-action" data-followup-answer="${followUp.id}" data-root-id="${question.id}">✦ 给我回答</button></div></form>`}<p class="followup-status" role="status" aria-live="polite"></p></div><div class="followup-record-actions"><button type="button" class="subtle-action" data-followup-edit-toggle="${followUp.id}">编辑</button><button type="button" class="subtle-action danger" data-followup-delete="${followUp.id}" data-root-id="${question.id}">删除</button></div><form class="followup-edit-form" data-followup-edit="${followUp.id}" data-root-id="${question.id}" hidden><label>追问问题<textarea rows="3" name="question" required>${escapeHtml(followUp.question)}</textarea></label><label>追问回答（可空）<textarea rows="5" name="answer">${escapeHtml(followUp.answer||"")}</textarea></label><div><button class="quiet-button" type="submit">保存修改</button><button class="subtle-action" type="button" data-followup-edit-cancel="${followUp.id}">取消</button></div></form></div></details>`).join("");
  return `<b>回答</b><div class="response-thread"><details class="response-entry original">${originalSummary}<div class="response-entry-body">${original}</div></details>${followUpCards}<form class="followup-form" data-follow-up-root="${question.id}" hidden><label><span>追问问题</span><textarea rows="3" name="question" placeholder="补充一个追问…" required></textarea></label><label><span>回答（可选）</span><textarea rows="3" name="answer" placeholder="已有答案时可一起记下"></textarea></label><button class="quiet-button followup-submit" type="submit">＋ 追问</button><p class="followup-status" role="status" aria-live="polite"></p></form></div>`
}
function enhanceResponseThreads(container,chains){[...(container?.querySelectorAll(".chain-record")||[])].forEach((card,index)=>{const chain=chains[index],section=[...card.querySelectorAll(".chain-part")].find(item=>item.querySelector(":scope > b")?.textContent==="回答");if(chain&&section){section.classList.add("response-section");section.innerHTML=responseThreadMarkup(chain.question,chain.children)}})}
function commentRootKey(type,id){return `${type}:${id}`}
function parseCommentRootKey(value){const divider=String(value||"").indexOf(":");return divider<1?{type:"",id:""}:{type:value.slice(0,divider),id:value.slice(divider+1)}}
function clearThoughtTracePending(rootKey){const {type,id}=parseCommentRootKey(rootKey);if(type!=="thought"||!id)return;state.insights.aiOnlyThoughtIds=(state.insights.aiOnlyThoughtIds||[]).filter(value=>value!==id);document.querySelectorAll(`[data-chain-id="${CSS.escape(id)}"]`).forEach(card=>card.closest(".thought-timeline-entry")?.querySelector(".thought-trace-pending")?.remove())}
function commentRoot(value){const {type,id}=parseCommentRootKey(value),collections={capture:"captures",journal:"journals",chat:"chats",analysis:"analyses",book:"books",quote:"quotes"};if(type==="thought")return state.thoughts.find(item=>item.id===id&&item.type==="question");return collections[type]?state[collections[type]]?.find(item=>item.id===id):null}
function commentEndpoint(value,suffix=""){const {type,id}=parseCommentRootKey(value);return `/api/annotations/${encodeURIComponent(type)}/${encodeURIComponent(id)}${suffix}`}
function commentRootLabel(value){const {type}=parseCommentRootKey(value);return({thought:"主题思考",capture:"捕念",journal:"日记",chat:"长期对话",analysis:"认知复盘",book:"读书笔记",quote:"善言"})[type]||"正文"}
function markCommentTarget(element,rootKey,targetKey){if(!element)return;element.classList.add("commentable");element.dataset.commentRoot=rootKey;element.dataset.commentTarget=targetKey}
function tagCommentableTargets(container,chains){[...(container?.querySelectorAll(".chain-record")||[])].forEach((card,index)=>{const chain=chains[index];if(!chain)return;const rootId=chain.question.id,rootKey=commentRootKey("thought",rootId),parts=[...card.querySelectorAll(":scope > .chain-expanded > .chain-part")],questionPart=parts.find(x=>x.querySelector(":scope > b")?.textContent==="问题"),ideaPart=parts.find(x=>x.querySelector(":scope > b")?.textContent==="初步想法"),ideas=chain.children.filter(x=>x.type==="idea"),answers=chain.children.filter(x=>x.type==="answer");markCommentTarget(questionPart?.querySelector(":scope > .markdown-content"),rootKey,`question:${rootId}`);[...(ideaPart?.querySelectorAll(":scope > .markdown-content")||[])].forEach((element,i)=>markCommentTarget(element,rootKey,`idea:${ideas[i]?.id||i}`));[...card.querySelectorAll(".response-entry.original > .response-entry-body .model-answer-content > .markdown-content")].forEach((element,i)=>markCommentTarget(element,rootKey,`answer:${answers[i]?.id||i}`));card.querySelectorAll(".response-entry[data-followup-id]").forEach(entry=>{const id=entry.dataset.followupId;markCommentTarget(entry.querySelector(".followup-question .markdown-content"),rootKey,`followup-question:${id}`);markCommentTarget(entry.querySelector(".followup-answer .model-answer-content > .markdown-content"),rootKey,`followup-answer:${id}`)})})}
function commentTextNodes(container){const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT,{acceptNode(node){if(!node.nodeValue||!node.nodeValue.length)return NodeFilter.FILTER_REJECT;const parent=node.parentElement;if(!parent||parent.closest("button, textarea, input")||parent.closest('.katex-html[aria-hidden="true"]'))return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_ACCEPT}});const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);return nodes}
function commentText(container){return commentTextNodes(container).map(node=>node.nodeValue).join("")}
function wrapCommentRange(container,start,end,rootId,annotationId,kind="comment"){let offset=0;for(const node of commentTextNodes(container)){const nodeStart=offset,nodeEnd=offset+node.nodeValue.length;offset=nodeEnd;if(end<=nodeStart||start>=nodeEnd)continue;const from=Math.max(0,start-nodeStart),to=Math.min(node.nodeValue.length,end-nodeStart);if(to<=from)continue;const selected=node.splitText(from),after=selected.splitText(to-from),mark=document.createElement("mark");mark.className=`comment-anchor ${kind==="highlight"?"highlight-anchor":""}`.trim();mark.dataset.commentRoot=rootId;mark.dataset.annotationId=annotationId;selected.parentNode.insertBefore(mark,selected);mark.append(selected);void after}}
function applySingleCommentAnchor(rootKey,annotation){document.querySelectorAll(`.commentable[data-comment-root="${CSS.escape(rootKey)}"][data-comment-target="${CSS.escape(annotation.targetKey)}"]`).forEach(element=>{if(element.querySelector(`.comment-anchor[data-annotation-id="${CSS.escape(annotation.id)}"]`))return;const text=commentText(element);let start=Number(annotation.start)||0,end=Number(annotation.end)||start;if(text.slice(start,end)!==annotation.quote){start=text.indexOf(annotation.quote);end=start+annotation.quote.length}if(start>=0&&end>start)wrapCommentRange(element,start,end,rootKey,annotation.id,annotation.kind)})}
function removeCommentAnchors(annotationId){document.querySelectorAll(`.comment-anchor[data-annotation-id="${CSS.escape(annotationId)}"]`).forEach(mark=>{const parent=mark.parentNode;mark.replaceWith(...mark.childNodes);parent?.normalize()})}
function applyCommentAnchors(container){container?.querySelectorAll(".commentable").forEach(element=>{const rootKey=element.dataset.commentRoot,root=commentRoot(rootKey),annotations=(root?.annotations||[]).filter(item=>item.targetKey===element.dataset.commentTarget).sort((a,b)=>b.start-a.start);for(const annotation of annotations){const text=commentText(element);let start=Number(annotation.start)||0,end=Number(annotation.end)||start;if(text.slice(start,end)!==annotation.quote){start=text.indexOf(annotation.quote);end=start+annotation.quote.length}if(start>=0&&end>start)wrapCommentRange(element,start,end,rootKey,annotation.id,annotation.kind)}})}
function commentSelection(){const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return null;const range=selection.getRangeAt(0),startElement=range.startContainer.nodeType===Node.TEXT_NODE?range.startContainer.parentElement:range.startContainer,endElement=range.endContainer.nodeType===Node.TEXT_NODE?range.endContainer.parentElement:range.endContainer,startTarget=startElement?.closest?.(".commentable"),endTarget=endElement?.closest?.(".commentable");if(!startTarget||startTarget!==endTarget)return null;const quote=selection.toString().trim();if(!quote||quote.length>1000)return null;const prefix=document.createRange();prefix.selectNodeContents(startTarget);prefix.setEnd(range.startContainer,range.startOffset);let start=prefix.toString().length;const raw=selection.toString(),leading=raw.length-raw.trimStart().length;start+=leading;return{rootKey:startTarget.dataset.commentRoot,targetKey:startTarget.dataset.commentTarget,start,end:start+quote.length,quote,rect:range.getBoundingClientRect()}}
function showSelectionCommentButton(){const found=commentSelection(),tools=$("#selection-tools");if(!found){tools.hidden=true;return}pendingSelection=found;tools.hidden=false;tools.style.left=`${Math.max(8,Math.min(window.innerWidth-tools.offsetWidth-8,found.rect.left+found.rect.width/2-tools.offsetWidth/2))}px`;tools.style.top=`${Math.max(8,found.rect.top-tools.offsetHeight-9)}px`}
function annotationCard(annotation){const highlight=annotation.kind==="highlight",shenji=(annotation.shenji||[]).map(item=>`<div class="shenji-turn">${item.message?`<div class="shenji-user"><span>@你</span><div class="markdown-content">${renderMarkdown(item.message)}</div></div>`:""}<div class="shenji-answer markdown-content"><span class="shenji-label">@神鸡</span>${reasoningDisclosure(item.reasoningContent)}${renderMarkdown(item.answer)}</div><small>${formatDate(item.createdAt)}</small></div>`).join("");return `<article class="comment-card ${highlight?"highlight-card":""} ${activeAnnotationId===annotation.id?"active":""}" data-comment-card="${annotation.id}">${highlight?'<span class="annotation-kind">浅绿色划线</span>':""}<blockquote>${escapeHtml(annotation.quote)}</blockquote>${highlight?"":`<p>${escapeHtml(annotation.text)}</p><small>${formatDate(annotation.createdAt)}</small>${(annotation.replies||[]).map(reply=>`<div class="comment-reply"><p>${escapeHtml(reply.text)}</p><small>${formatDate(reply.createdAt)}</small></div>`).join("")}<form class="comment-reply-form" data-comment-reply="${annotation.id}"><input placeholder="回复这条评论…" required><button type="submit">回复</button></form>`}${shenji?`<div class="shenji-thread">${shenji}</div>`:""}<form class="shenji-form" data-shenji-form="${annotation.id}" ${activeShenjiComposer===annotation.id?"":"hidden"}><div><span class="shenji-label">@神鸡</span><textarea name="message" rows="3" placeholder="可留空直接询问标记内容，也可补充你的问题…"></textarea></div><button type="submit">发送</button><p class="shenji-status" role="status"></p></form><div class="annotation-actions"><button type="button" class="shenji-toggle" data-shenji-toggle="${annotation.id}">@神鸡</button><button class="comment-delete" type="button" data-comment-delete="${annotation.id}">${highlight?"删除划线":"删除评论"}</button></div></article>`}
function driftCard(annotation){const context=annotation.originalContext||{before:"",focus:annotation.quote,after:""},replies=(annotation.replies||[]).map(item=>`<div class="comment-reply"><p>${escapeHtml(item.text)}</p><small>${formatDate(item.createdAt)}</small></div>`).join(""),shenji=(annotation.shenji||[]).map(item=>`<div class="shenji-turn">${item.message?`<div class="shenji-user"><span>@你</span><div class="markdown-content">${renderMarkdown(item.message)}</div></div>`:""}<div class="shenji-answer markdown-content"><span class="shenji-label">@神鸡</span>${reasoningDisclosure(item.reasoningContent)}${renderMarkdown(item.answer)}</div></div>`).join("");return `<article class="drift-card" data-drift-card="${annotation.id}"><div class="drift-meta"><span>${annotation.kind==="highlight"?"失效划线":"失效评论"}</span><small>${escapeHtml(annotation.driftReason||"原文已变化")}</small></div><div class="drift-context"><span>${escapeHtml(context.before)}</span><mark>${escapeHtml(context.focus||annotation.quote)}</mark><span>${escapeHtml(context.after)}</span></div>${annotation.text?`<p>${escapeHtml(annotation.text)}</p>`:""}${replies}${shenji}<button type="button" class="comment-delete" data-drift-delete="${annotation.id}">删除漂流记录</button></article>`}
function renderCommentPanel(){const panel=$("#comment-panel");if(!activeCommentRoot){panel.hidden=true;return}const root=commentRoot(activeCommentRoot);if(!root){activeCommentRoot="";panel.hidden=true;return}panel.hidden=false;panel.querySelector("header h2").textContent=`${commentRootLabel(activeCommentRoot)}批注`;$("#comment-composer").hidden=!(pendingSelection?.rootKey===activeCommentRoot);if(pendingSelection?.rootKey===activeCommentRoot)$("#comment-quote").textContent=pendingSelection.quote;const annotations=[...(root.annotations||[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),drift=[...(root.annotationDrift||[])].sort((a,b)=>(b.driftedAt||b.createdAt).localeCompare(a.driftedAt||a.createdAt)),live=annotations.length?annotations.map(annotationCard).join(""):empty("还没有有效评论或划线。选中正文后即可添加。"),driftSection=drift.length?`<section class="drift-box"><header><h3>评论漂流箱</h3><span>${drift.length}</span></header><p class="drift-help">原文被改写或删除后，无法可靠定位的批注会保留在这里。</p>${drift.map(driftCard).join("")}</section>`:"";$("#comment-panel-list").innerHTML=live+driftSection;renderLatex($("#comment-panel-list"));requestAnimationFrame(()=>{if(activeAnnotationId)panel.querySelector(`[data-comment-card="${CSS.escape(activeAnnotationId)}"]`)?.scrollIntoView({block:"center"})})}
function refreshAnnotationCard(annotation){const current=document.querySelector(`[data-comment-card="${CSS.escape(annotation.id)}"]`);if(!current)return renderCommentPanel();const template=document.createElement("template");template.innerHTML=annotationCard(annotation).trim();const next=template.content.firstElementChild;current.replaceWith(next);renderLatex(next)}
function openCommentPanel(rootKey,annotationId=""){activeCommentRoot=rootKey;activeAnnotationId=annotationId;renderCommentPanel()}
const splitTags=v=>String(v||"").split(/[,，#\s]+/).map(x=>x.trim()).filter(Boolean);
const formatDate=iso=>new Intl.DateTimeFormat("zh-CN",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(iso));
const formatTime=iso=>new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(iso));
const formatDateKey=value=>{const [year,month,day]=String(value||"").split("-").map(Number);return year&&month&&day?`${year}年${month}月${day}日`:""};
const bookReadingRange=book=>book.readingStartedOn?`${formatDateKey(book.readingStartedOn)} — ${book.readingFinishedOn?formatDateKey(book.readingFinishedOn):"至今"}`:"阅读日期未记录";
const toLocalDateTimeInput=iso=>{const d=new Date(iso),pad=n=>String(n).padStart(2,"0");return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`};
const localDateTimeForDate=(dateKey,value=new Date())=>{const d=value instanceof Date?value:new Date(value),pad=n=>String(n).padStart(2,"0");return `${dateKey}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`};
const eventTimestamp=item=>item?.occurredAt||item?.createdAt;
const persistedDateTimeInput=item=>{const value=item?.occurredAt||item?.createdAt;if(!value||Number.isNaN(new Date(value).getTime()))return "";return toLocalDateTimeInput(value)};
const eventDate=item=>item?.occurredOn||localDateKey(eventTimestamp(item));
const empty=t=>`<div class="empty">${escapeHtml(t)}</div>`;
const avg=v=>v.length?v.reduce((s,x)=>s+Number(x),0)/v.length:null;
const formatBytes=value=>value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`;
function validatedImageFiles(files,maxFiles=1){
  const list=[...files].slice(0,maxFiles),allowed=new Set(["image/png","image/jpeg","image/webp"]);
  if(!list.length)throw new Error("没有找到可用图片");
  if([...files].length>maxFiles)throw new Error(`最多选择 ${maxFiles} 张图片`);
  if(list.some(file=>!allowed.has(file.type)))throw new Error("只支持 PNG、JPEG 或 WebP 图片");
  if(list.some(file=>file.size>8*1024*1024)||list.reduce((sum,file)=>sum+file.size,0)>8*1024*1024)throw new Error("单张及本次图片总大小均不得超过 8 MB");
  return list;
}
const imageDataUrls=files=>Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("无法读取图片，请重新选择"));reader.readAsDataURL(file)})));
const bookImageUi={
  cover:{input:"#book-cover-image",preview:"#book-cover-preview",box:"#book-cover-upload-box",title:"#book-cover-upload-title",hint:"#book-cover-upload-hint",remove:"#book-cover-remove",emptyTitle:"选择、粘贴或拖入封面",emptyHint:"PNG / JPEG / WebP · 不超过 8 MB"},
  recognition:{input:"#book-recognition-image",preview:"#book-recognition-preview",box:"#book-recognition-upload-box",title:"#book-recognition-upload-title",hint:"#book-recognition-upload-hint",remove:"#book-recognition-remove",emptyTitle:"选择、粘贴或拖入识别图",emptyHint:"PNG / JPEG / WebP · 不超过 8 MB"}
};
function updateBookImageSwapButton(){
  const button=$("#book-image-swap");
  if(button)button.disabled=$("#book-cover-preview").hidden||$("#book-recognition-preview").hidden;
}
function resetBookImage(role,{existingPath=""}={}){
  const ui=bookImageUi[role];
  if(bookPreviewUrls[role])URL.revokeObjectURL(bookPreviewUrls[role]);
  bookPreviewUrls[role]="";pendingBookImages[role]=null;$(ui.input).value="";$(ui.box).classList.remove("has-image","dragging");
  const preview=$(ui.preview);
  if(existingPath){preview.src=existingPath;preview.hidden=false;$(ui.title).textContent="当前封面";$(ui.hint).textContent="选择新图片即可替换";$(ui.box).classList.add("has-image");$(ui.remove).hidden=false}
  else{preview.hidden=true;preview.removeAttribute("src");$(ui.title).textContent=ui.emptyTitle;$(ui.hint).textContent=ui.emptyHint;$(ui.remove).hidden=true}
  if(role==="recognition")$("#parse-book").disabled=true;
  updateBookImageSwapButton();
}
function setBookImage(role,file,source="已选择"){
  const ui=bookImageUi[role],status=$("#book-parse-status");try{[file]=validatedImageFiles([file])}catch(error){status.textContent=error.message;return false}
  if(bookPreviewUrls[role])URL.revokeObjectURL(bookPreviewUrls[role]);
  pendingBookImages[role]=file;bookPreviewUrls[role]=URL.createObjectURL(file);$(ui.preview).src=bookPreviewUrls[role];$(ui.preview).hidden=false;$(ui.title).textContent=file.name||"剪贴板图片";$(ui.hint).textContent=`${source} · ${formatBytes(file.size)} · 点击可重新选择`;$(ui.box).classList.add("has-image");$(ui.remove).hidden=false;
  if(role==="recognition"){$("#parse-book").disabled=false;status.textContent="识别图已就绪，可以回填书目信息。"}else status.textContent="新封面已就绪，将在保存书目时上传。";
  updateBookImageSwapButton();
  return true;
}
async function currentBookCoverFile(){
  if(pendingBookImages.cover)return pendingBookImages.cover;
  const imagePath=$("#book-image-path").value;
  if(!imagePath)return null;
  const response=await fetch(appUrl(imagePath));
  if(!response.ok)throw new Error("当前封面读取失败，无法交换");
  const blob=await response.blob(),name=decodeURIComponent(imagePath.split("/").pop()||"current-cover");
  return new File([blob],name,{type:blob.type||"image/jpeg"});
}
function syncBookReadingDates(){
  const start=$("#book-reading-start"),end=$("#book-reading-end");
  end.min=start.value;
  end.setCustomValidity(start.value&&end.value&&end.value<start.value?"结束日期不能早于开始日期":"");
}
function resetBookForm(){
  editingBookId="";$("#book-form").reset();$("#book-reading-start").value=localDateKey();syncBookReadingDates();$("#book-image-path").value="";resetBookImage("cover");resetBookImage("recognition");$("#book-form-title").textContent="创建书目";$("#book-submit").textContent="创建书目";$("#book-edit-cancel").hidden=true;$("#book-parse-status").textContent="";
}
function openBookEditor(book){
  editingBookId=book.id;activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false;bookCreatorOpen=true;
  for(const key of["title","author","publisher","isbn","description"])$(`#book-${key}`).value=book[key]||"";
  $("#book-reading-start").value=book.readingStartedOn||"";
  $("#book-reading-end").value=book.readingFinishedOn||"";
  syncBookReadingDates();
  $("#book-image-path").value=book.imagePath||"";resetBookImage("cover",{existingPath:book.imagePath||""});resetBookImage("recognition");
  $("#book-form-title").textContent="编辑书目";$("#book-submit").textContent="保存修改";$("#book-edit-cancel").hidden=false;$("#book-parse-status").textContent="可修改资料或替换封面。";renderBooks();
  requestAnimationFrame(()=>{$("#book-create-panel").scrollIntoView({behavior:"smooth",block:"start"});$("#book-title").focus()});
}

const dailyTypeMeta={sleep:{label:"睡眠",save:"保存睡眠"},heartRate:{label:"心率",save:"保存心率"},weight:{label:"体重",save:"保存体重"},exercise:{label:"运动",save:"保存运动"}};
const dailyNumericFields=["totalMinutes","deepMinutes","deepPercent","lightMinutes","lightPercent","remMinutes","remPercent","awakeCount","awakeMinutes","averageHeartRate","averageOxygen","respiratoryRate","minimum","maximum","average","resting","sleepAverage","measuredWeight"];
function resetHealthImages(){
  healthPreviewUrls.forEach(url=>URL.revokeObjectURL(url));healthPreviewUrls=[];
  healthFiles[activeDailyType]=[];$("#health-images").value="";$("#health-image-previews").innerHTML="";$("#health-upload-box").classList.remove("has-image","dragging");$("#parse-health-images").disabled=true;$("#health-parse-status").textContent="";
}
function renderHealthUploader(){
  const visible=["sleep","heartRate"].includes(activeDailyType),workflow=$("#health-image-workflow");workflow.hidden=!visible;if(!visible)return;
  const max=activeDailyType==="sleep"?2:1,files=healthFiles[activeDailyType]||[];
  $("#health-images").multiple=max>1;$("#health-upload-title").textContent=activeDailyType==="sleep"?"优先上传 1–2 张睡眠截图":"优先上传 1 张心率截图";
  $("#health-upload-hint").textContent=`点击、粘贴或拖入 · ${activeDailyType==="sleep"?"总览与详情可一起识别":"包含日视图与今日概览"} · 合计不超过 8 MB`;
  healthPreviewUrls.forEach(url=>URL.revokeObjectURL(url));healthPreviewUrls=files.map(file=>URL.createObjectURL(file));
  $("#health-image-previews").innerHTML=files.map((file,index)=>`<figure><img src="${healthPreviewUrls[index]}" alt="待识别截图 ${index+1}"><figcaption>${escapeHtml(file.name||`截图 ${index+1}`)} · ${formatBytes(file.size)}</figcaption><button type="button" data-health-image-remove="${index}" aria-label="移除截图 ${index+1}">×</button></figure>`).join("");
  $("#health-upload-box").classList.toggle("has-image",files.length>0);$("#parse-health-images").disabled=!files.length;
}
function setHealthImages(files,source="已选择",append=false){
  const status=$("#health-parse-status"),max=activeDailyType==="sleep"?2:1;
  try{const next=append?[...(healthFiles[activeDailyType]||[]),...files]:[...files];healthFiles[activeDailyType]=validatedImageFiles(next,max);renderHealthUploader();status.textContent=`${source}${append?"已追加":""} · ${healthFiles[activeDailyType].length} 张图片已就绪，识别后仍可修改。`;return true}catch(error){status.textContent=error.message;return false}
}
function dailyForm(type=activeDailyType){return $(`[data-daily-form="${CSS.escape(type)}"]`)}
function resetDailyForm(type=activeDailyType){
  const form=dailyForm(type);if(!form)return;form.reset();form.elements.recordId.value="";if(form.elements.attachmentPaths)form.elements.attachmentPaths.value="";form.elements.occurredAt.value=localDateTimeForDate(activeDate);form.querySelector('[type="submit"]').textContent=dailyTypeMeta[type].save;form.querySelector("[data-daily-cancel]").hidden=true;form.querySelector(".status").textContent="";
  if(type==="weight")form.elements.clothing.value="none";
}
function switchDailyType(type){
  if(!dailyTypeMeta[type])return;activeDailyType=type;
  $$("[data-daily-tab]").forEach(button=>{const active=button.dataset.dailyTab===type;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $$("[data-daily-form]").forEach(form=>{const active=form.dataset.dailyForm===type;form.hidden=!active;form.classList.toggle("active",active)});
  renderHealthUploader();renderDailyRecords();
}
const durationLabel=value=>Number.isFinite(Number(value))?`${Math.floor(Number(value)/60)}小时${String(Math.round(Number(value)%60)).padStart(2,"0")}分`:"—";
const valueLabel=(value,suffix="")=>value==null?"—":`${value}${suffix}`;
function weightChart(records){
  if(!records.length)return"";
  const items=[...records].sort((a,b)=>eventTimestamp(a).localeCompare(eventTimestamp(b))).slice(-30),width=900,height=220,left=48,right=24,top=18,bottom=40,values=items.flatMap(item=>[item.lower95,item.upper95,item.adjustedWeight]).filter(Number.isFinite),min=Math.floor((Math.min(...values)-.5)*2)/2,max=Math.ceil((Math.max(...values)+.5)*2)/2||min+1,x=index=>items.length===1?width/2:left+index*(width-left-right)/(items.length-1),y=value=>top+(max-value)*(height-top-bottom)/(max-min||1);
  const grid=[min,(min+max)/2,max].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${value.toFixed(1)}</text>`).join(""),marks=items.map((item,index)=>{const px=x(index),interval=item.clothing!=="none"?`<line class="weight-interval" x1="${px}" x2="${px}" y1="${y(item.upper95)}" y2="${y(item.lower95)}"/><line class="weight-cap" x1="${px-5}" x2="${px+5}" y1="${y(item.upper95)}" y2="${y(item.upper95)}"/><line class="weight-cap" x1="${px-5}" x2="${px+5}" y1="${y(item.lower95)}" y2="${y(item.lower95)}"/>`:"";return `${interval}<circle class="weight-point" cx="${px}" cy="${y(item.adjustedWeight)}" r="5"><title>${item.occurredOn} · 校正 ${item.adjustedWeight} kg${item.clothing!=="none"?` · 95% ${item.lower95}～${item.upper95} kg`:""}</title></circle><text class="weight-date" x="${px}" y="${height-14}" text-anchor="middle">${item.occurredOn.slice(5)}</text>`}).join("");
  return `<div class="weight-chart-legend"><span><i></i>衣物校正值</span><span><i class="interval"></i>穿衣记录 95% 估计区间</span></div><svg class="weight-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近体重衣物校正值与95%估计区间"><g class="weight-grid">${grid}</g>${marks}</svg><p class="weight-chart-note">图中使用衣物校正值进行比较；区间来自固定衣物重量假设，不代表体脂秤测量误差或医学置信区间。</p>`;
}
function dailyRecordCard(item){
  const labels={sleep:"睡眠",heartRate:"心率",weight:"体重",exercise:"运动"},source=item.source==="screenshot"?"截图识别":"手动记录";let body="";
  if(item.type==="sleep")body=`<div class="daily-values"><span><b>${durationLabel(item.totalMinutes)}</b>总睡眠</span><span><b>${valueLabel(item.deepMinutes," 分")}</b>深睡 ${valueLabel(item.deepPercent,"%")}</span><span><b>${valueLabel(item.lightMinutes," 分")}</b>浅睡 ${valueLabel(item.lightPercent,"%")}</span><span><b>${valueLabel(item.remMinutes," 分")}</b>快速眼动 ${valueLabel(item.remPercent,"%")}</span><span><b>${valueLabel(item.awakeCount," 次")}</b>清醒 · ${valueLabel(item.awakeMinutes," 分")}</span><span><b>${valueLabel(item.averageHeartRate)}</b>心率 · 血氧 ${valueLabel(item.averageOxygen,"%")} · 呼吸 ${valueLabel(item.respiratoryRate)}</span></div>`;
  if(item.type==="heartRate")body=`<div class="daily-values"><span><b>${valueLabel(item.minimum)}–${valueLabel(item.maximum)}</b>心率范围</span><span><b>${valueLabel(item.average)}</b>平均</span><span><b>${valueLabel(item.resting)}</b>静息</span><span><b>${valueLabel(item.sleepAverage)}</b>睡眠平均</span></div>${item.trendAnalysis?`<p class="heart-trend">${escapeHtml(item.trendAnalysis)}</p>`:""}`;
  if(item.type==="weight")body=`<div class="weight-record-value"><strong>${item.adjustedWeight.toFixed(2)} kg</strong><span>秤上 ${item.measuredWeight.toFixed(2)} kg · ${item.clothing==="none"?"不穿衣":item.clothing==="light"?"轻便衣物":"厚重衣物"}</span>${item.clothing!=="none"?`<small>95% 估计区间 ${item.lower95.toFixed(2)}–${item.upper95.toFixed(2)} kg</small>`:""}</div>`;
  if(item.type==="exercise")body=`<p class="exercise-description">${escapeHtml(item.description)}</p>`;
  return `<article class="daily-record-entry" data-daily-record-id="${item.id}"><header><div><span>${labels[item.type]}</span><time>${escapeHtml(item.occurredOn)} · ${formatTime(eventTimestamp(item))}</time></div><small>${source}</small></header>${body}<footer><button type="button" data-daily-edit="${item.id}">编辑</button><button type="button" class="danger" data-daily-delete="${item.id}">删除</button></footer></article>`;
}
function renderDailyRecords(){
  const items=[...(state.dailyRecords||[])].filter(item=>item.type===activeDailyType).sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  $("#daily-history-title").textContent=`${dailyTypeMeta[activeDailyType].label}记录`;$("#daily-history-count").textContent=`${items.length} 条`;$("#daily-record-chart").innerHTML=activeDailyType==="weight"?weightChart(items):"";
  $("#daily-record-list").innerHTML=items.length?items.map(dailyRecordCard).join(""):empty(`还没有${dailyTypeMeta[activeDailyType].label}记录。`);
}
function editDailyRecord(id){
  const item=(state.dailyRecords||[]).find(record=>record.id===id);if(!item)return;switchDailyType(item.type);const form=dailyForm(item.type);resetDailyForm(item.type);form.elements.recordId.value=item.id;form.elements.occurredAt.value=toLocalDateTimeInput(eventTimestamp(item));if(form.elements.attachmentPaths)form.elements.attachmentPaths.value=JSON.stringify(item.attachmentPaths||[]);
  for(const [key,value]of Object.entries(item)){if(["id","type","createdAt","occurredAt","occurredOn","attachmentPaths","trendSegments"].includes(key)||!form.elements[key])continue;if(form.elements[key] instanceof RadioNodeList)form.elements[key].value=value;else form.elements[key].value=value??""}
  if(form.elements.bedtime)form.elements.bedtime.value=item.bedtime?toLocalDateTimeInput(item.bedtime):"";if(form.elements.wakeTime)form.elements.wakeTime.value=item.wakeTime?toLocalDateTimeInput(item.wakeTime):"";if(form.elements.trendSegments)form.elements.trendSegments.value=JSON.stringify(item.trendSegments||[]);
  form.querySelector('[type="submit"]').textContent="保存修改";form.querySelector("[data-daily-cancel]").hidden=false;form.querySelector(".status").textContent="正在编辑已有记录";form.scrollIntoView({behavior:"smooth",block:"center"});
}

function setAnswerStatus(id,message,kind="working"){document.querySelectorAll(`[data-answer-chain="${CSS.escape(id)}"]`).forEach(button=>{let status=button.closest(".chain-expanded")?.querySelector(".card-action-status");if(!status){status=document.createElement("p");status.className="card-action-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");button.closest(".chain-expanded")?.append(status)}status.className=`card-action-status ${kind}`;status.textContent=message})}
async function request(url,options={}){const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];let response;try{response=await fetch(appUrl(url),{headers:{"content-type":"application/json"},...options})}catch{if(answerId)setAnswerStatus(answerId,"无法连接服务，请确认网络连接后重试。","error");throw new Error("无法连接服务，请确认网络连接后重试")}const result=await response.json();if(!response.ok){const message=result.error||"操作失败";if(response.status===401&&result.code==="AUTH_REQUIRED")showAuthGate();if(answerId)setAnswerStatus(answerId,`未能生成：${message}，可重试。`,"error");throw new Error(message)}if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");return result}
async function requestStream(url,options={},onEvent=()=>{}){
  const answerId=url.match(/^\/api\/thoughts\/([^/]+)\/answer$/)?.[1];
  let response;
  try{response=await fetch(appUrl(url),{...options,headers:{"content-type":"application/json",accept:"text/event-stream",...(options.headers||{})}})}
  catch{if(answerId)setAnswerStatus(answerId,"无法连接本地服务，请确认页面服务仍在运行后重试。","error");throw new Error("无法连接本地服务，请确认页面服务仍在运行后重试")}
  if(!response.ok){const raw=await response.text();let parsed={};try{parsed=JSON.parse(raw)}catch{}const message=parsed.error||"操作失败";if(response.status===401&&parsed.code==="AUTH_REQUIRED")showAuthGate();if(answerId)setAnswerStatus(answerId,`未能生成：${message}，可重试。`,"error");throw new Error(message)}
  if(!String(response.headers.get("content-type")||"").includes("text/event-stream")){const result=await response.json();if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");return result}
  if(!response.body)throw new Error("本地服务未返回可读取的回答流");
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer="",result,receivedDone=false;
  const consume=block=>{const data=block.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");if(!data)return;const event=JSON.parse(data);if(event.type==="error")throw new Error(event.error||"模型回答失败");onEvent(event);if(event.type==="done"){result=event.result;receivedDone=true}};
  while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary=buffer.match(/\r?\n\r?\n/);while(boundary){consume(buffer.slice(0,boundary.index));buffer=buffer.slice(boundary.index+boundary[0].length);boundary=buffer.match(/\r?\n\r?\n/)}}
  buffer+=decoder.decode();if(buffer.trim())consume(buffer);
  if(!receivedDone)throw new Error("回答流意外中断，请重试");
  if(answerId)setAnswerStatus(answerId,"回答已生成并保存。","success");
  return result;
}
function showToast(message,kind="success"){const t=$("#toast");t.textContent=message;t.className=`toast ${kind}`;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,3200)}
function commitDraftTags(){const input=$("#chain-tags"),values=splitTags(input.value);for(const value of values)if(!draftTags.includes(value))draftTags.push(value);input.value="";renderTagComposer()}
function renderTagComposer(){const list=$("#chain-tag-list");if(!list)return;list.innerHTML=draftTags.map(tag=>`<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-draft-tag="${escapeHtml(tag)}" aria-label="移除标签 ${escapeHtml(tag)}">×</button></span>`).join("");const known=[...new Set(state.thoughts.flatMap(item=>item.tags||[]))].filter(tag=>!draftTags.includes(tag));$("#tag-suggestions").innerHTML=known.map(tag=>`<option value="${escapeHtml(tag)}"></option>`).join("")}
function commitCaptureTags(){const input=$("#capture-tags"),values=splitTags(input.value);for(const value of values)if(!captureDraftTags.includes(value))captureDraftTags.push(value);input.value="";renderCaptureTagComposer()}
function renderCaptureTagComposer(){const list=$("#capture-tag-list");if(!list)return;list.innerHTML=captureDraftTags.map(tag=>`<span class="tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-capture-tag="${escapeHtml(tag)}" aria-label="移除关键词 ${escapeHtml(tag)}">×</button></span>`).join("");const known=[...new Set([...(state.captures||[]),...(state.thoughts||[])].flatMap(item=>item.tags||[]))].filter(tag=>!captureDraftTags.includes(tag));$("#capture-tag-suggestions").innerHTML=known.map(tag=>`<option value="${escapeHtml(tag)}"></option>`).join("")}
function metricConfig(){const custom=Object.fromEntries((state.customMetrics||[]).map(x=>[x.id,{label:x.name,anchors:[x.low,"偏低","居中","偏高",x.high],custom:true}]));return{...baseMetrics,...custom}}
function metricValue(checkin,key,custom){return custom?checkin.custom?.[key]:checkin[key]}
function metricReference(key,custom){const eligible=state.checkins.filter(x=>x.occurredOn<=activeDate).sort((a,b)=>b.occurredOn.localeCompare(a.occurredOn)||eventTimestamp(b).localeCompare(eventTimestamp(a)));const previous=eligible.map(x=>metricValue(x,key,custom)).find(x=>Number.isFinite(Number(x)));const history=eligible.slice(0,30).map(x=>Number(metricValue(x,key,custom))).filter(Number.isFinite);return{previous:previous==null?null:Number(previous),average:avg(history)}}
function metricMarker(kind,value,label){if(!Number.isFinite(value))return"";const position=Math.max(0,Math.min(100,(value-1)*25)),thumbOffset=11-position*.22,left=`calc(${position}% + ${thumbOffset.toFixed(3)}px)`;return `<span class="metric-history-marker ${kind}" style="left:${left}" data-position="${position}" role="img" aria-label="${label} ${value.toFixed(2)}" title="${label} ${value.toFixed(2)}"></span>`}
function sliderTemplate(key,cfg){const ref=metricReference(key,cfg.custom),value=ref.previous??(ref.average==null?3:Math.round(ref.average));return `<div class="metric unconfirmed"><div class="metric-top"><span class="metric-label">${escapeHtml(cfg.label)}</span><span class="anchor" id="${key}-anchor">待确认 · ${escapeHtml(cfg.anchors[value-1])}</span><button class="note-toggle" type="button" data-note="${key}" aria-expanded="false">＋备注</button></div><div class="metric-scale">${metricMarker("previous",ref.previous,"上一次")}${metricMarker("average",ref.average,"近30次平均")}<input type="range" id="metric-${key}" data-metric="${key}" data-custom="${cfg.custom?"1":"0"}" data-confirmed="false" min="1" max="5" value="${value}" step="1" aria-label="${escapeHtml(cfg.label)} 1到5，必须确认"></div><div class="range-labels"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div><input class="note-field" id="${key}-note" placeholder="可选：补充一句话" maxlength="800"></div>`}
function renderSliders(){const cfg=metricConfig();$("#sliders").innerHTML=`<div class="metric-history-legend" aria-label="历史参照图例"><span><i class="previous"></i>上一次</span><span><i class="average"></i>近30次平均</span></div>${Object.entries(cfg).map(([k,v])=>sliderTemplate(k,v)).join("")}`;$$('[data-metric]').forEach(input=>{const update=(confirmed=false)=>{if(confirmed){input.dataset.confirmed="true";input.closest(".metric").classList.remove("unconfirmed")}const prefix=input.dataset.confirmed==="true"?"":"待确认 · ";$(`#${CSS.escape(input.dataset.metric)}-anchor`).textContent=`${prefix}${cfg[input.dataset.metric].anchors[Number(input.value)-1]}`};input.addEventListener("input",()=>update(true));input.addEventListener("pointerdown",()=>update(true));update()});$$(".note-toggle").forEach(b=>b.addEventListener("click",()=>{const f=$(`#${CSS.escape(b.dataset.note)}-note`);f.classList.toggle("visible");b.setAttribute("aria-expanded",String(f.classList.contains("visible")));if(f.classList.contains("visible"))f.focus()}))}

const thoughtDate=chain=>eventDate(chain.question);
function thoughtChains(){const roots=state.thoughts.filter(x=>x.type==="question"),ids=new Set(roots.map(x=>x.id));const grouped=roots.map(question=>({question,children:state.thoughts.filter(x=>x.relatedTo===question.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))}));state.thoughts.filter(x=>x.type!=="question"&&(!x.relatedTo||!ids.has(x.relatedTo))).forEach(x=>grouped.push({question:{...x,type:"question",content:"（旧记录未关联问题）"},children:[x]}));return grouped.sort((a,b)=>thoughtDate(b).localeCompare(thoughtDate(a))||eventTimestamp(b.question).localeCompare(eventTimestamp(a.question)))}
function thoughtAnswerPreview(content){return plainPreview(content).replace(/^(?:核心判断|给我判断|给你(?:一个)?判断|我的判断|结论)(?:\s*[：:]|\s+)\s*/u,"").trimStart()}
function chainCard({question,children},showDate=true){
  const ideas=children.filter(x=>x.type==="idea"),answers=children.filter(x=>x.type==="answer"),ideaText=ideas.map(x=>x.content).join(" "),answerPreview=thoughtAnswerPreview(answers.map(x=>x.content).filter(Boolean).join(" "))||(answers.some(x=>x.modelDraft)?"模型草稿未被保留":"尚未回答"),annotationCount=(question.annotations||[]).length+(question.annotationDrift||[]).length,remarks=(question.remarks||[]).map(n=>`<div class="remark-row"><span>${escapeHtml(n.text)}</span><span class="remark-actions"><button type="button" data-edit-remark="${n.id}" data-thought-id="${question.id}" aria-label="编辑这条备注">＋</button><button type="button" data-delete-remark="${n.id}" data-thought-id="${question.id}" aria-label="删除这条备注">－</button></span></div>`).join("");
  const ideaSection=ideas.length?`<section class="chain-part"><b>初步想法</b>${ideas.map(x=>`<p>${escapeHtml(x.content)}</p>`).join("")}</section>`:"";
  const dispositionActions=`${question.disposition!=="kept"?`<button class="subtle-action" data-disposition="${question.id}" data-value="kept">保留</button>`:""}${question.disposition!=="discarded"?`<button class="subtle-action" data-disposition="${question.id}" data-value="discarded">舍弃</button>`:""}`;
  const tags=question.tags?.length?`#${question.tags.map(escapeHtml).join(" #")}`:"未标记",tracePending=(state.insights.aiOnlyThoughtIds||[]).includes(question.id)?'<span class="thought-trace-pending">📫没有你的痕迹⏳</span>':"";
  return `<article class="thought-timeline-entry"><div class="timeline-date">${showDate?escapeHtml(eventDate(question)):""}</div><header class="thought-entry-meta"><div class="thought-entry-markers"><span class="thought-entry-tags">${tags}</span>${tracePending}</div><time>${formatTime(eventTimestamp(question))}</time></header><details class="thought-card chain-record" data-chain-id="${question.id}"><summary class="chain-summary"><div class="summary-content"><strong class="question-preview">${escapeHtml(plainPreview(question.content))}</strong>${ideaText?`<p class="idea-preview">${escapeHtml(plainPreview(ideaText))}</p>`:""}<p class="answer-preview">${escapeHtml(answerPreview)}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="chain-expanded"><section class="chain-part"><b>问题</b><div class="markdown-content">${renderMarkdown(question.content)}</div></section>${ideaSection}<section class="chain-part"><b>回答</b>${answers.length?answers.map(x=>`<p class="${x.content?"":"missing-part"}">${x.content?escapeHtml(x.content):"模型草稿未被保留"}</p>${x.modelDraft&&x.editedFromModel?`<small class="edit-signal">${x.content?"由模型草稿修改后保留":"已舍弃模型草稿"}</small>`:""}`).join(""):`<p class="missing-part">尚未回答</p>`}</section>${remarks?`<div class="remarks">${remarks}</div>`:""}<div class="thought-actions">${answers.length?"":`<button class="subtle-action answer-action" data-answer-chain="${question.id}">✦ 给我回答</button>`}${annotationCount?`<button class="subtle-action" data-open-comments="${question.id}">批注 ${annotationCount}</button>`:""}${dispositionActions}<button class="subtle-action" data-edit-chain="${question.id}">编辑</button><button class="subtle-action" data-followup-compose="${question.id}" aria-expanded="false">＋追问</button><button class="subtle-action" data-remark="${question.id}">＋备注</button><button class="subtle-action danger" data-delete-chain="${question.id}">删除</button></div></div></details></article>`
}
function chainCardsMarkup(chains){return chains.map((chain,index)=>chainCard(chain,index===0||thoughtDate(chain)!==thoughtDate(chains[index-1]))).join("")}
function renderThoughtFilters(chains){const tags=[...new Set(chains.flatMap(({question,children})=>[...(question.tags||[]),...children.flatMap(x=>x.tags||[])]))].sort((a,b)=>a.localeCompare(b,"zh-CN"));if(thoughtFilter!=="all"&&!tags.includes(thoughtFilter))thoughtFilter="all";$("#thought-filters").innerHTML=["all",...tags].map(tag=>`<button class="filter-button ${thoughtFilter===tag?"active":""}" data-tag-filter="${escapeHtml(tag)}">${tag==="all"?"全部":`#${escapeHtml(tag)}`}</button>`).join("")}
function thoughtOpenState(){const roots=new Set(),followUps=new Set();$$('.chain-record[open][data-chain-id]').forEach(card=>roots.add(card.dataset.chainId));$$('.response-entry[open][data-followup-id]').forEach(entry=>{const root=entry.closest('[data-chain-id]')?.dataset.chainId;if(root)followUps.add(`${root}:${entry.dataset.followupId}`)});return{roots,followUps}}
function restoreThoughtOpenState(openState){$$('[data-chain-id]').forEach(card=>{if(openState.roots.has(card.dataset.chainId))card.open=true;card.querySelectorAll('[data-followup-id]').forEach(entry=>{if(openState.followUps.has(`${card.dataset.chainId}:${entry.dataset.followupId}`))entry.open=true})})}
function renderThoughts(extraOpen={}){const open=thoughtOpenState();if(extraOpen.chainId)open.roots.add(extraOpen.chainId);if(extraOpen.followUpId)open.followUps.add(`${extraOpen.chainId}:${extraOpen.followUpId}`);const chains=thoughtChains(),today=chains.filter(x=>thoughtDate(x)===activeDate).slice(0,5);$("#today-thoughts").innerHTML=today.length?chainCardsMarkup(today):empty("这一天还没有思绪记录。");renderThoughtFilters(chains);const items=thoughtFilter==="all"?chains:chains.filter(({question,children})=>[...(question.tags||[]),...children.flatMap(x=>x.tags||[])].includes(thoughtFilter));$("#all-thoughts").innerHTML=items.length?chainCardsMarkup(items):empty("这个标签下还没有记录。");enhanceResponseThreads($("#today-thoughts"),today);enhanceResponseThreads($("#all-thoughts"),items);enhanceThoughtMarkdown($("#today-thoughts"));enhanceThoughtMarkdown($("#all-thoughts"));tagCommentableTargets($("#today-thoughts"),today);tagCommentableTargets($("#all-thoughts"),items);renderLatex($("#today-thoughts"));renderLatex($("#all-thoughts"));applyCommentAnchors($("#today-thoughts"));applyCommentAnchors($("#all-thoughts"));restoreThoughtOpenState(open)}

function captureCard(item,showDate=true){
  const tags=item.tags?.length?`#${item.tags.map(escapeHtml).join(" #")}`:"未标记";
  return `<article class="capture-timeline-entry" data-capture-id="${item.id}"><div class="timeline-date capture-date">${showDate?escapeHtml(eventDate(item)):""}</div><header class="capture-meta"><span class="capture-top-tags">${tags}</span><time class="capture-entry-time">${formatTime(eventTimestamp(item))}</time></header><div class="capture-item"><div class="capture-copy"><div class="capture-content-viewport"><div class="record-actions capture-actions"><button type="button" data-capture-promote="${item.id}">展开成思考</button><div class="capture-actions-row"><button type="button" data-capture-edit="${item.id}">编辑</button><button type="button" class="danger" data-capture-delete="${item.id}" aria-label="删除这条捕念">删除</button></div></div><div class="markdown-content">${renderMarkdown(item.content)}</div></div></div><button class="capture-expand" type="button" data-capture-expand aria-expanded="false" aria-label="展开捕念" hidden>⌄</button></div></article>`;
}
function syncCaptureOverflow(){
  $$(".capture-item").forEach(card=>{
    const viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]");if(!viewport||!button)return;
    const wasExpanded=viewport.classList.contains("expanded");viewport.classList.remove("expanded");
    const overflows=viewport.scrollHeight>viewport.clientHeight+1;
    const expanded=wasExpanded&&overflows;
    viewport.classList.toggle("expanded",expanded);card.classList.toggle("is-expandable",overflows);card.classList.toggle("is-expanded",expanded);button.hidden=!overflows;button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",expanded?"收起捕念":"展开捕念");
  });
}
function toggleCaptureCard(card){
  if(!card?.classList.contains("is-expandable"))return;
  const viewport=card.querySelector(".capture-content-viewport"),button=card.querySelector("[data-capture-expand]"),expanded=!viewport.classList.contains("expanded");
  viewport.classList.toggle("expanded",expanded);card.classList.toggle("is-expanded",expanded);button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",expanded?"收起捕念":"展开捕念");
}
function renderCaptures(){
  const items=[...(state.captures||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  $("#capture-count").textContent=`${items.length} 条`;
  $("#capture-list").innerHTML=items.length?items.map((item,index)=>captureCard(item,index===0||eventDate(item)!==eventDate(items[index-1]))).join(""):empty("这里还没有捕念。下一次有什么一闪而过，直接放进来。");
  items.forEach(item=>markCommentTarget($(`[data-capture-id="${CSS.escape(item.id)}"] .capture-copy .markdown-content`),commentRootKey("capture",item.id),"content"));
  renderLatex($("#capture-list"));applyCommentAnchors($("#capture-list"));requestAnimationFrame(syncCaptureOverflow);
}
function resetCaptureForm(){
  $("#capture-form").reset();$("#capture-id").value="";captureDraftTags=[];renderCaptureTagComposer();$("#capture-date").value=localDateTimeForDate(activeDate);$("#capture-submit").textContent="收下";$("#capture-cancel").hidden=true;$("#capture-status").textContent="";
}
function editCapture(id){
  const item=state.captures.find(value=>value.id===id);if(!item)return;
  $("#capture-id").value=item.id;$("#capture-content").value=item.content;captureDraftTags=[...(item.tags||[])];$("#capture-tags").value="";renderCaptureTagComposer();$("#capture-date").value=toLocalDateTimeInput(eventTimestamp(item));$("#capture-submit").textContent="保存修改";$("#capture-cancel").hidden=false;$("#capture-status").textContent="正在编辑已有捕念";$("#capture-form").scrollIntoView({behavior:"smooth",block:"start"});$("#capture-content").focus();
}
function reflectionMarkup(item,reflection,index){
  const stale=reflection.sourceUpdatedAt&&(reflection.sourceUpdatedAt!==(item.updatedAt||item.createdAt));
  return `<details class="journal-reflection" data-reflection-id="${reflection.id}" ${index===0?"open":""}><summary><span>助手回望${index?" "+(item.reflections.length-index):""}</span><small>${stale?"基于修改前版本 · ":""}${formatDate(reflection.createdAt)}</small></summary><div class="model-answer-content">${reasoningDisclosure(reflection.reasoningContent)}<div class="markdown-content">${renderMarkdown(reflection.content)}</div></div></details>`;
}
function journalCard(item){
  const title=item.title||`${eventDate(item)} 日记`,reflections=item.reflections||[],tags=item.tags?.length?`<div class="record-tags">${item.tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</div>`:"";
  return `<details class="card journal-entry" data-journal-id="${item.id}"><summary><div><time>${escapeHtml(eventDate(item))}</time><strong>${escapeHtml(title)}</strong><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="journal-entry-body"><div class="markdown-content journal-original">${renderMarkdown(item.content)}</div>${tags}<div class="record-actions"><button type="button" class="reflect-action" data-journal-reflect="${item.id}">✦ ${reflections.length?"再次回望":"请助手回望"}</button><button type="button" data-journal-edit="${item.id}">编辑</button><button type="button" class="danger" data-journal-delete="${item.id}">删除</button></div>${reflections.length?`<section class="journal-reflections"><h3>回望记录</h3>${reflections.map((reflection,index)=>reflectionMarkup(item,reflection,index)).join("")}</section>`:""}</div></details>`;
}
function renderJournals(){
  if(!journalDraftRestored){journalDraftRestored=true;restoreJournalDraft(state.journalDraft)}
  const open=new Set($$(".journal-entry[open]").map(item=>item.dataset.journalId)),items=[...(state.journals||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  $("#journal-count").textContent=`${items.length} 篇`;
  $("#journal-list").innerHTML=items.length?items.map(journalCard).join(""):empty("还没有日记。写一句真实的话，就是开始。");
  $$(".journal-entry").forEach(card=>{const item=items.find(value=>value.id===card.dataset.journalId);if(!item)return;if(open.has(item.id))card.open=true;const rootKey=commentRootKey("journal",item.id);markCommentTarget(card.querySelector(".journal-original"),rootKey,"content");(item.reflections||[]).forEach(reflection=>markCommentTarget(card.querySelector(`[data-reflection-id="${CSS.escape(reflection.id)}"] .model-answer-content>.markdown-content`),rootKey,`reflection:${reflection.id}`))});renderLatex($("#journal-list"));applyCommentAnchors($("#journal-list"));
}
function resetJournalForm(){
  $("#journal-form").reset();$("#journal-id").value="";$("#journal-date").value=localDateTimeForDate(activeDate);$("#journal-submit").textContent="保存日记";$("#journal-cancel").hidden=true;$("#journal-status").textContent="";$("#journal-assist-status").textContent="";
}
function restoreJournalDraft(draft){
  if(!draft)return false;
  const item=state.journals.find(value=>value.id===draft.journalId);
  $("#journal-form").reset();$("#journal-id").value=item?.id||"";$("#journal-title").value=draft.title||"";$("#journal-content").value=draft.content||"";
  $("#journal-date").value=item?toLocalDateTimeInput(eventTimestamp(item)):localDateTimeForDate(activeDate);
  $("#journal-tags").value=item?(item.tags||[]).map(tag=>`#${tag}`).join(" "):"";
  $("#journal-submit").textContent=item?"保存修改":"保存日记";$("#journal-cancel").hidden=!item;$("#journal-assist-status").textContent="";
  $("#journal-status").textContent=`已恢复 ${formatTime(draft.updatedAt)} 保存的草稿。`;
  return true;
}
function editJournal(id){
  const item=state.journals.find(value=>value.id===id);if(!item)return;
  $("#journal-id").value=item.id;$("#journal-title").value=item.title||"";$("#journal-date").value=toLocalDateTimeInput(eventTimestamp(item));$("#journal-content").value=item.content;$("#journal-tags").value=(item.tags||[]).map(tag=>`#${tag}`).join(" ");$("#journal-submit").textContent="保存修改";$("#journal-cancel").hidden=false;$("#journal-status").textContent=item.reflections?.length?"修改原文后，已有回望仍会保留并标记为旧版本。":"正在编辑已有日记";$("#journal-form").scrollIntoView({behavior:"smooth",block:"start"});$("#journal-content").focus();
}

function renderCheckinHistory(items){
  const list=$("#checkin-history"),ordered=[...items].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a))),cfg=metricConfig();
  if(!ordered.length){list.innerHTML="";return}
  list.innerHTML=`<div class="checkin-history-heading"><b>单次记录</b><span>${ordered.length} 次</span></div><div class="checkin-history-list">${ordered.map(item=>{const values=Object.entries(cfg).map(([key,meta])=>{const value=metricValue(item,key,meta.custom);return Number.isFinite(Number(value))?`<span>${escapeHtml(meta.label)} ${Number(value)}</span>`:""}).filter(Boolean).join(""),factors=item.factors?.length?`因素：${item.factors.map(escapeHtml).join("、")}`:"未记录因素";return `<article class="checkin-history-entry"><header><time>${escapeHtml(eventDate(item))} · ${formatTime(eventTimestamp(item))}</time><button type="button" data-edit-checkin="${escapeHtml(item.id)}" aria-label="编辑 ${escapeHtml(eventDate(item))} ${formatTime(eventTimestamp(item))} 的状态">编辑</button></header><div>${values}</div><p>${factors}</p></article>`}).join("")}</div>`;
}
function renderStateChart(){
  const days=Number($("#chart-range")?.value||30),cutoff=new Date(`${activeDate}T12:00:00`);cutoff.setDate(cutoff.getDate()-days+1);
  const available=state.checkins.filter(item=>item.occurredOn<=activeDate),eligible=available.filter(item=>new Date(`${item.occurredOn}T12:00:00`)>=cutoff),groups=new Map();
  for(const item of eligible){if(!groups.has(item.occurredOn))groups.set(item.occurredOn,[]);groups.get(item.occurredOn).push(item)}
  renderCheckinHistory(available);
  const dates=[...groups.keys()].sort();if(!dates.length){$("#state-chart").innerHTML=empty("记录一次状态后，这里会出现时间线。");return}
  const mean=(items,getter)=>{const values=items.map(getter).map(Number).filter(Number.isFinite);return values.length?avg(values):null},round=value=>Math.round(value*100)/100;
  const daily=dates.map(date=>{const entries=groups.get(date),mood=mean(entries,x=>x.mood),energy=mean(entries,x=>x.energy),stress=mean(entries,x=>x.stress),sleep=mean(entries,x=>x.sleep),composite=[mood,energy,stress,sleep].every(Number.isFinite)?0.3*mood+0.3*energy+0.25*sleep+0.15*stress:null;return{date,entries:entries.length,mood,energy,stress,sleep,composite,score:composite==null?null:Math.round((composite-1)*25),custom:Object.fromEntries((state.customMetrics||[]).map(metric=>[metric.id,mean(entries,x=>x.custom?.[metric.id])]))}});
  const palette=["#7885c8","#70a68c","#d39a78","#a990c8","#7aa8b8","#b2a56b","#cb87a1"],series=[{key:"mood",label:"情绪",color:palette[0]},{key:"energy",label:"精力",color:palette[1]},{key:"stress",label:"压力",color:palette[2]},{key:"sleep",label:"睡眠",color:palette[3]},...(state.customMetrics||[]).map((metric,index)=>({key:`custom.${metric.id}`,label:metric.name,color:palette[(index+4)%palette.length]}))];
  const valueOf=(day,key)=>key.startsWith("custom.")?day.custom[key.slice(7)]:day[key],width=900,height=250,left=42,right=18,top=20,bottom=42,x=index=>daily.length===1?width/2:left+index*(width-left-right)/(daily.length-1),y=value=>top+(5-value)*(height-top-bottom)/4,pathFor=key=>daily.map((day,index)=>({index,value:valueOf(day,key)})).filter(point=>Number.isFinite(point.value)).map((point,index)=>`${index?"L":"M"}${x(point.index)},${y(point.value)}`).join(" ");
  const labels=daily.map((day,index)=>(index===0||index===daily.length-1||daily.length<=7)?`<text x="${x(index)}" y="232" text-anchor="middle">${day.date.slice(5)}</text>`:"").join(""),grid=[1,2,3,4,5].map(value=>`<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/><text x="25" y="${y(value)+4}">${value}</text>`).join("");
  const paleLines=series.map(item=>{const path=pathFor(item.key),dots=daily.map((day,index)=>{const value=valueOf(day,item.key);return Number.isFinite(value)?`<circle class="metric-dot" style="--series:${item.color}" cx="${x(index)}" cy="${y(value)}" r="3.5"><title>${day.date} · ${item.label} ${round(value)} · ${day.entries} 次提交均值</title></circle>`:""}).join("");return path?`<path class="metric-line" style="--series:${item.color}" d="${path}"/>${dots}`:""}).join("");
  const scorePath=pathFor("composite"),scoreDots=daily.map((day,index)=>Number.isFinite(day.composite)?`<circle class="score-dot" cx="${x(index)}" cy="${y(day.composite)}" r="5"><title>${day.date} · 综合 ${day.score}/100 · ${day.entries} 次提交均值</title></circle>`:"").join(""),current=daily.at(-1),summary=[["情绪",current.mood],["精力",current.energy],["压力",current.stress],["睡眠",current.sleep]].map(([label,value])=>`${label} ${round(value)}`).join(" · ");
  $("#state-chart").innerHTML=`<div class="chart-stats"><span><b>${daily.length}</b> 个记录日</span><span><b>${eligible.length}</b> 次提交</span><span><b>${current.score??"—"}</b> 最新综合分</span></div><div class="chart-day-summary"><b>${current.date}</b><span>${current.entries} 次提交取均值：${summary}</span></div><div class="chart-legend">${series.map(item=>`<span><i style="--series:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("")}<span class="score-legend"><i></i>综合状态</span></div><svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="所有状态指标的每日均值与综合状态趋势"><g class="chart-grid">${grid}${labels}</g>${paleLines}<path class="score-line" d="${scorePath}"/>${scoreDots}</svg><p class="score-method">所有指标均为 1 最差、5 最好。综合分 = 情绪 30% + 精力 30% + 睡眠 25% + 压力状态 15%，再换算为 0–100。自定义指标只展示趋势，不擅自计入总分。</p>`
}
function renderChat(){const chats=state.chats.filter(x=>eventDate(x)===activeDate);$("#chat-history").innerHTML=chats.length?[...chats].reverse().map(x=>`<div class="chat-message user" data-chat-id="${x.id}" data-chat-part="message"><div class="markdown-content">${renderMarkdown(x.message)}</div></div><div class="chat-message agent" data-chat-id="${x.id}" data-chat-part="answer">${reasoningDisclosure(x.reasoningContent)}<div class="markdown-content">${renderMarkdown(x.answer)}</div></div>`).join(""):empty("在这里提问，我会带着你的长期记录一起回答。");chats.forEach(item=>{const rootKey=commentRootKey("chat",item.id);markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="message"]>.markdown-content`),rootKey,"message");markCommentTarget($(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="answer"]>.markdown-content`),rootKey,"answer")});renderLatex($("#chat-history"));applyCommentAnchors($("#chat-history"))}
function experimentCard(item){const start=new Date(item.createdAt),elapsed=Math.max(1,Math.floor((Date.now()-start.getTime())/86400000)+1),relevant=state.checkins.filter(x=>new Date(eventTimestamp(x))>=start),withFactor=relevant.filter(x=>(x.factors||[]).includes(item.factor)),withoutFactor=relevant.filter(x=>!(x.factors||[]).includes(item.factor)),metric=baseMetrics[item.outcome]?item.outcome:"mood",withAvg=avg(withFactor.map(x=>x[metric]).filter(Number.isFinite)),withoutAvg=avg(withoutFactor.map(x=>x[metric]).filter(Number.isFinite)),enough=withFactor.length>=3&&withoutFactor.length>=3,result=enough?`有因素 ${withAvg.toFixed(1)} / 无因素 ${withoutAvg.toFixed(1)}，差值 ${(withAvg-withoutAvg).toFixed(1)}`:`有因素 ${withFactor.length} 次 / 无因素 ${withoutFactor.length} 次；两边各满 3 次后开始显示线索`;return `<article class="experiment-card"><div class="section-title"><b>${escapeHtml(item.hypothesis)}</b><span>${Math.min(elapsed,item.duration)} / ${item.duration} 天</span></div><div class="experiment-progress"><i style="width:${Math.min(100,elapsed/item.duration*100)}%"></i></div><p>每天若做了“<b>${escapeHtml(item.factor)}</b>”，请在今日因素中填入完全相同的词；观察 ${trendLabels[metric]}。</p><small>${escapeHtml(result)}。相关不等于因果。</small></article>`}

function renderAssociationFlow(){const dates=new Set(state.checkins.map(x=>x.occurredOn)).size,factors=new Set(state.checkins.flatMap(x=>x.factors||[])).size;$("#association-flow").innerHTML=`<div class="association-flow" role="img" aria-label="延迟相关线索计算流程：记录状态和因素，按日期聚合，按因素分组，对照当天与自然次日情绪，通过样本门槛，最后输出非因果线索"><div class="flow-node"><b>状态记录</b><span>${state.checkins.length} 次状态 · ${factors} 个因素</span></div><i>↓</i><div class="flow-node"><b>按自然日聚合</b><span>${dates} 天；同日多次取平均</span></div><i>↓</i><div class="flow-node"><b>逐个因素分组</b><span>出现该因素的天 vs 未出现的天</span></div><i>↓</i><div class="flow-node"><b>三个对照</b><span>当天情绪 · 自然次日情绪 · 无因素基线</span></div><i>↓</i><div class="flow-node"><b>样本分层</b><span>首次出现即展示；样本增加后再升级为初步线索或可观察</span></div><i>↓</i><div class="flow-node final"><b>延迟关联线索</b><span>只显示均值差异，不推断因果</span></div></div>`}
function setAssociationFlowOpen(open){const modal=$("#association-flow-modal"),button=$("#association-flow-toggle");modal.hidden=!open;button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",open?"关闭计算流程":"查看计算流程");button.title=open?"关闭计算流程":"查看计算流程";if(open)$("#association-flow-close").focus();else button.focus()}
function trendInsightsMarkup(){
  const trends=state.insights.trends||[],available=trends.filter(item=>item.current!=null);
  if(!available.length)return empty("记录一次状态后即可形成当前均值；有第二组数据后再比较变化。");
  const waiting=available.every(item=>item.previous==null),sampleCount=Math.max(...available.map(item=>item.currentCount||0),state.insights.weekly?.checkins||0);
  const note=waiting?`<p class="review-observation"><b>当前观察</b><span>先展示已有 ${sampleCount||"少量"} 个记录日的均值；样本增加后自动补充前后变化。</span></p>`:"";
  return `${note}${trends.map(item=>{const delta=item.previous==null?"当前均值":`${item.current>=item.previous?"+":""}${(item.current-item.previous).toFixed(1)}`,count=item.currentCount?` · ${item.currentCount}天`:"";return `<div class="trend-row trend-${item.metric}"><b>${trendLabels[item.metric]}</b><div class="trend-bar"><span style="width:${(item.current||0)*20}%;--trend-value:${item.current||0}"></span></div><span class="delta">${item.current??"—"} / ${delta}${count}</span></div>`}).join("")}`;
}
function associationInsightsMarkup(){
  const associations=(state.insights.associations||[]).slice(0,3);
  if(associations.length)return associations.map(item=>{const next=item.nextDay==null?"次日暂无":`次日 ${item.nextDay}（${item.nextDayCount}天）`,baseline=item.baseline==null?"暂无无因素日":`无因素 ${item.baseline}（${item.withoutCount}天）`;return `<div class="association-row"><b>${escapeHtml(item.factor)}</b><span>当天 ${item.sameDay??"—"}（${item.withCount}天） · ${next} · ${baseline}</span><span class="delta">${item.confidence}</span></div>`}).join("");
  const groups=new Map();for(const item of state.checkins){const value=Number(item.mood);if(!Number.isFinite(value))continue;const key=item.occurredOn;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(value)}
  const moods=[...groups.values()].map(avg),days=groups.size;
  if(!moods.length)return empty("记录一次状态后即可形成当前观察；补充当天因素后再寻找关联线索。");
  return `<p class="review-observation"><b>当前观察</b><span>${days} 个记录日的情绪均值为 ${avg(moods).toFixed(1)}。尚未记录可对照因素，暂时只描述现状。</span></p>`;
}
function renderAnalysisHistory(){
  const list=$("#analysis-list"),known=new Set([...list.querySelectorAll("[data-analysis-id]")].map(item=>item.dataset.analysisId)),opened=new Set([...list.querySelectorAll("[data-analysis-id][open]")].map(item=>item.dataset.analysisId)),items=[...(state.analyses||[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $("#analysis-count").textContent=`${items.length} 份`;
  list.innerHTML=items.length?items.map((item,index)=>{const label=item.reason==="weekly-background"?"后台周复盘":"主动复盘",isNew=!known.has(item.id),open=opened.has(item.id)||(index===0&&(!known.size||isNew));return `<details class="analysis-entry" data-analysis-id="${item.id}" ${open?"open":""}><summary><div><div class="analysis-summary-meta"><time>${formatDate(item.createdAt)}</time><span>${label}</span>${index===0?'<b>最新</b>':""}</div><p>${escapeHtml(plainPreview(item.content))}</p></div><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="analysis-entry-body">${reasoningDisclosure(item.reasoningContent)}<div class="analysis-content markdown-content">${renderMarkdown(item.content)}</div></div></details>`}).join(""):empty("已有任一状态、健康、捕念、日记或思绪记录，就可以生成低样本认知复盘。");
  items.forEach(item=>markCommentTarget(list.querySelector(`[data-analysis-id="${CSS.escape(item.id)}"] .analysis-content`),commentRootKey("analysis",item.id),"content"));
  renderLatex(list);applyCommentAnchors(list);
}
function renderReview(){
  const w=state.insights.weekly||{},reviewValue=w.reviewAgeDays==null?"未开始":w.reviewAgeDays===0?"今天":String(w.reviewAgeDays),reviewUnit=w.reviewAgeDays>0?"天":"";
  const signals=[
    {key:"coverage",label:"近 7 日记录覆盖",value:w.activeDays7??0,unit:"/ 7 天",detail:"有任一主动记录的自然日"},
    {key:"paired",label:"近 30 日身心同日",value:w.pairedDays30??0,unit:"天",detail:"状态与健康记录出现在同一天"},
    {key:"trace",label:"近 30 日思考留痕率",value:w.traceRate30??"—",unit:w.traceRate30==null?"":"%",detail:w.rootCount30?`${w.tracedRoots30??0} / ${w.rootCount30} 个问题留有你的痕迹`:"近 30 日还没有问题"},
    {key:"correction",label:"近 30 日主动校正",value:w.correctionActions30??0,unit:"次",detail:"编辑、追问、批注与回望"},
    {key:"review",label:"距上次认知复盘",value:reviewValue,unit:reviewUnit,detail:w.analysisCount?`累计 ${w.analysisCount} 份认知复盘`:"还没有认知复盘"}
  ];
  $("#weekly-summary").innerHTML=signals.map(item=>`<article class="summary-signal" data-signal="${item.key}"><span class="summary-signal-label">${item.label}</span><div class="summary-signal-value"><strong>${item.value}</strong>${item.unit?`<span>${item.unit}</span>`:""}</div><p>${item.detail}</p></article>`).join("");
  $("#trend-list").innerHTML=trendInsightsMarkup();renderStateChart();$("#association-list").innerHTML=associationInsightsMarkup();renderAssociationFlow();$("#cluster-grid").innerHTML=state.clusters.length?state.clusters.map(g=>`<article class="cluster-card"><div class="section-title"><h2>${escapeHtml(g.theme)}</h2><b>${g.count}</b></div><div class="cluster-stats"><span>保留 ${g.kept}</span><span>舍弃 ${g.discarded}</span><span>未处理 ${g.unreviewed}</span></div><ul>${g.items.slice(0,3).map(x=>`<li>${escapeHtml(x.content.slice(0,54))}${x.content.length>54?"…":""}</li>`).join("")}</ul></article>`).join(""):empty("累积几条思绪后，这里会出现反复主题。");$("#experiment-list").innerHTML=state.experiments.length?state.experiments.map(experimentCard).join(""):`<p class="time-hint">建议从 14 天、一个因素、一个结果开始。</p>`;$("#metric-list").innerHTML=state.customMetrics.length?`<div class="pill-list">${state.customMetrics.map(x=>`<span class="pill">${escapeHtml(x.name)}：${escapeHtml(x.low)} ↔ ${escapeHtml(x.high)}</span>`).join("")}</div>`:`<p class="time-hint">新指标会出现在“此刻状态”中。</p>`;renderAnalysisHistory()
}
const bookFavoriteMeta={none:{icon:"☆",label:"无收藏",next:"star"},star:{icon:"🌟",label:"星标",next:"sprout"},sprout:{icon:"🌱",label:"萌芽",next:"none"}};
function sortedBookNotes(book){return [...(book.notes||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)))}
function bookCoverMarkup(book,className="book-cover"){return book.imagePath?`<img class="${className}" src="${escapeHtml(appUrl(book.imagePath))}" alt="${escapeHtml(book.title)}">`:`<div class="${className} placeholder" aria-hidden="true">书</div>`}
function featuredBookNote(book){
  const notes=sortedBookNotes(book);
  let note=notes.find(item=>item.id===activeBookFeatureNoteId);
  if(!note&&notes.length){note=notes[Math.floor(Math.random()*notes.length)];activeBookFeatureNoteId=note.id}
  return note;
}
function bookFeatureMarkup(note){
  if(!note)return `<article class="book-feature-note is-empty"><p class="eyebrow">随机精选</p><h3>第一条笔记会出现在这里</h3><p>正文时间线已经就位。写下一条真实的理解，再回来与它偶遇。</p></article>`;
  const type=note.type==="thought"?"附加思考":"读书记录",preview=plainPreview(note.content);
  return `<article class="book-feature-note"><p class="eyebrow">随机精选</p><blockquote>${escapeHtml(preview.slice(0,220))}${preview.length>220?"…":""}</blockquote><footer><span>${type} · ${formatDate(eventTimestamp(note))}</span><button class="text-button" type="button" data-book-feature-note="${note.id}">在时间线中查看 →</button></footer></article>`;
}
function bookEntryForm(book){
  return `<form class="book-entry-form card" data-book-entry-form="${book.id}">
    <div class="book-entry-form-heading"><div><p class="eyebrow">写进这本书</p><h2 data-book-entry-heading>新增记录</h2></div><button class="text-button" type="button" data-book-entry-cancel hidden>取消编辑</button></div>
    <input type="hidden" name="noteId">
    <div class="book-entry-controls">
      <fieldset class="book-segmented"><legend>类型</legend><label><input type="radio" name="type" value="record" checked><span>记录</span></label><label><input type="radio" name="type" value="thought"><span>附加思考</span></label></fieldset>
      <label class="book-entry-time"><span>发生时间</span><input type="datetime-local" step="1" name="occurredAt" value="${toLocalDateTimeInput(new Date())}" required></label>
      <fieldset class="book-segmented favorite-segmented"><legend>收藏</legend><label><input type="radio" name="favorite" value="none" checked><span>无</span></label><label><input type="radio" name="favorite" value="star"><span>🌟</span></label><label><input type="radio" name="favorite" value="sprout"><span>🌱</span></label></fieldset>
    </div>
    <textarea name="content" rows="5" placeholder="记下原文、理解、疑问，或读完后仍在生长的想法…" required></textarea>
    <div class="book-entry-submit"><span>支持 Markdown 与 LaTeX</span><button class="primary-button" type="submit">保存记录</button></div>
    <p class="status" role="status"></p>
  </form>`
}
function bookTimelineMarkup(book){
  const notes=sortedBookNotes(book);
  if(!notes.length)return `<div class="book-timeline-empty">${empty("还没有记录。先留下一句真实的理解，之后再慢慢补充。")}</div>`;
  return `<div class="book-timeline">${notes.map((note,index)=>{
    const date=eventDate(note),previous=index?eventDate(notes[index-1]):"",favorite=bookFavoriteMeta[note.favorite]||bookFavoriteMeta.none,type=note.type==="thought"?"附加思考":"记录";
    return `<article class="book-timeline-entry" id="book-note-${note.id}" data-note-id="${note.id}">
      ${date!==previous?`<time class="book-entry-date">${escapeHtml(date)}</time>`:""}
      <div class="book-entry-card card">
        <header><span class="book-entry-type ${note.type==="thought"?"thought":""}">${type}</span><time>${formatTime(eventTimestamp(note))}</time></header>
        <div class="book-note markdown-content">${renderMarkdown(note.content)}</div>
        <footer><button class="book-favorite ${note.favorite||"none"}" type="button" data-book-note-favorite="${note.id}" data-next-favorite="${favorite.next}" title="${favorite.label}，点击切换" aria-label="${favorite.label}，点击切换">${favorite.icon}</button><div><button class="subtle-action" type="button" data-book-note-edit="${note.id}">编辑</button><button class="subtle-action danger" type="button" data-book-note-delete="${note.id}">删除</button></div></footer>
      </div>
    </article>`
  }).join("")}</div>`
}
function renderBookDetail(book){
  const detail=$("#book-detail"),notes=sortedBookNotes(book),latest=notes[0],featured=featuredBookNote(book);
  detail.innerHTML=`<div class="book-detail-nav"><button class="book-back" type="button" data-book-back>← 返回书架</button><button class="quiet-button" type="button" data-book-edit="${book.id}">编辑书目</button></div>
    <section class="book-detail-overview">
      <div class="book-feature-wrap">${bookFeatureMarkup(featured)}</div>
      <section class="book-detail-hero">
        ${bookCoverMarkup(book,"book-detail-cover")}
        <div class="book-detail-copy"><h2>${escapeHtml(book.title)}</h2><p class="book-meta">${escapeHtml(book.author||"作者未填")}${book.publisher?` · ${escapeHtml(book.publisher)}`:""}${book.isbn?` · ${escapeHtml(book.isbn)}`:""}</p><p class="book-reading-range">${escapeHtml(bookReadingRange(book))}</p><div class="book-description markdown-content">${renderMarkdown(book.description||"暂无简介")}</div><div class="book-detail-stats"><span><b>${notes.length}</b> 条记录</span><span>${latest?`最近记录 ${formatDate(eventTimestamp(latest))}`:"等待第一条记录"}</span></div></div>
      </section>
    </section>
    <section class="book-timeline-section"><div class="book-timeline-heading"><div><p class="eyebrow">阅读时间线</p><h2>我的笔记与思考</h2></div><div><span>${notes.length} 条</span><button class="quiet-button" type="button" data-book-add-note>＋ 新增记录</button></div></div>${bookTimelineMarkup(book)}</section>
    ${bookEntryForm(book)}`;
  const rootKey=commentRootKey("book",book.id);
  markCommentTarget(detail.querySelector(".book-description"),rootKey,"description");
  notes.forEach(note=>markCommentTarget(detail.querySelector(`[data-note-id="${CSS.escape(note.id)}"] .book-note`),rootKey,`note:${note.id}`));
  renderLatex(detail);applyCommentAnchors(detail);
  if(pendingBookNoteId){
    const target=detail.querySelector(`#book-note-${CSS.escape(pendingBookNoteId)}`);
    pendingBookNoteId="";
    requestAnimationFrame(()=>target?.scrollIntoView({behavior:"smooth",block:"center"}));
  }
}
function setBookDetailCondensed(value){
  bookDetailCondensed=Boolean(value&&activeBookId);
  $("#view-books").classList.toggle("book-detail-condensed",bookDetailCondensed);
  $("#book-detail").classList.toggle("is-condensed",bookDetailCondensed);
}
function syncBookDetailCondensed(){
  if(activeBookId&&!bookDetailCondensed&&window.scrollY>48)setBookDetailCondensed(true);
}
function renderBookMemories(){
  const sky=$("#book-memory-sky"),memories=state.books.flatMap(book=>(book.notes||[]).map(note=>({book,note}))).sort(()=>Math.random()-.5).slice(0,5);
  sky.innerHTML=memories.length?`<div class="book-memory-title"><p class="eyebrow">偶遇旧笔记</p><span>点击回到原处</span></div>${memories.map(({book,note},index)=>`<button class="book-memory-bubble tone-${index%5} position-${index%5}" type="button" data-book-memory="${book.id}" data-book-note="${note.id}" aria-label="打开《${escapeHtml(book.title)}》中的这条笔记"><span>${escapeHtml(plainPreview(note.content).slice(0,76))}${plainPreview(note.content).length>76?"…":""}</span><small>《${escapeHtml(book.title)}》</small></button>`).join("")}`:`<div class="book-memory-placeholder"><b>旧笔记会在这里浮现</b><span>在任一本书中留下记录后，这里会随机回顾。</span></div>`;
}
function setupBookTitlePans(){
  $$(".book-title-frame").forEach(frame=>{
    const title=frame.dataset.title||"",text=frame.querySelector(".book-title");
    if(!text)return;
    text.textContent=title;frame.classList.remove("is-overflowing");frame.style.removeProperty("--book-title-travel");frame.style.removeProperty("--book-title-duration");
    const lineHeight=parseFloat(getComputedStyle(text).lineHeight);
    if(!lineHeight||text.scrollHeight<=lineHeight*2+.5)return;
    const node=text.firstChild,range=document.createRange(),firstTop=text.getBoundingClientRect().top;
    let secondLineStart=title.length;
    for(let offset=0;offset<title.length;offset++){
      range.setStart(node,offset);range.setEnd(node,offset+1);
      if(range.getBoundingClientRect().top>firstTop+lineHeight*.5){secondLineStart=offset;break}
    }
    const firstLine=title.slice(0,secondLineStart).trimEnd(),remainder=title.slice(secondLineStart).trimStart();
    if(!remainder)return;
    const viewport=document.createElement("span"),track=document.createElement("span"),first=document.createElement("span"),second=document.createElement("span");
    viewport.className="book-title-scroll";track.className="book-title-scroll-track";first.className="book-title-scroll-line";second.className="book-title-scroll-line";first.textContent=firstLine;second.textContent=remainder;track.append(first,second);viewport.append(track);text.replaceChildren(viewport);
    const travel=Math.max(0,Math.ceil(track.scrollWidth-viewport.clientWidth));
    if(!travel)return;
    frame.style.setProperty("--book-title-travel",`${-travel}px`);
    frame.style.setProperty("--book-title-duration",`${Math.min(9,Math.max(4,3.5+travel/40)).toFixed(1)}s`);
    frame.classList.add("is-overflowing");
  });
}
function renderBooks(){
  const hasBooks=state.books.length>0,book=state.books.find(item=>item.id===activeBookId);
  if(!editingBookId&&!$("#book-reading-start").value)$("#book-reading-start").value=localDateKey();
  if(activeBookId&&!book){activeBookId="";activeBookFeatureNoteId="";bookDetailCondensed=false}
  const detailBook=state.books.find(item=>item.id===activeBookId),inDetail=Boolean(detailBook),creator=$("#book-create-panel"),library=$("#book-library"),detail=$("#book-detail"),toggle=$("#book-create-toggle");
  $("#view-books").classList.toggle("book-detail-mode",inDetail);
  $("#view-books").classList.toggle("book-detail-condensed",inDetail&&bookDetailCondensed);
  detail.classList.toggle("is-condensed",inDetail&&bookDetailCondensed);
  $("#book-count").textContent=hasBooks?`${state.books.length} 本`:"";
  $("#book-note-count").textContent=`${state.books.reduce((sum,item)=>sum+(item.notes||[]).length,0)} 条笔记`;
  toggle.hidden=!hasBooks||inDetail;toggle.textContent=bookCreatorOpen?"收起创建":"＋ 添加书目";
  creator.hidden=inDetail||(hasBooks&&!bookCreatorOpen);creator.classList.toggle("cold-start",!hasBooks);
  library.hidden=inDetail||!hasBooks;detail.hidden=!inDetail;
  if(inDetail){renderBookDetail(detailBook);return}
  detail.innerHTML="";
  if(!hasBooks){$("#book-grid").innerHTML="";return}
  renderBookMemories();
  $("#book-grid").innerHTML=state.books.map(book=>{
    const notes=sortedBookNotes(book),latest=notes[0];
    return `<article class="book-card card" data-book-id="${book.id}"><button class="book-card-open" type="button" data-open-book="${book.id}">${bookCoverMarkup(book,"book-gallery-cover")}<span class="book-card-copy"><span class="book-title-frame" data-title="${escapeHtml(book.title)}" title="${escapeHtml(book.title)}"><strong class="book-title">${escapeHtml(book.title)}</strong></span><span>${escapeHtml(book.author||"作者未填")}</span><small class="book-card-reading">${escapeHtml(bookReadingRange(book))}</small><small>${notes.length} 条记录${latest?` · ${formatDate(eventTimestamp(latest))}`:""}</small></span><span class="book-card-arrow" aria-hidden="true">→</span></button></article>`
  }).join("");
  requestAnimationFrame(setupBookTitlePans);
}
const dataUrlFromBlob=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("图片读取失败"));reader.readAsDataURL(blob)});
const loadImageSource=source=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("图片无法打开，请换一张重试"));image.src=source});
function blankCanvas(width,height){const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;return canvas}
function clearKeepsakeHistory(){keepsakeEditor.history=[];$("#keepsake-undo").disabled=true}
function pushKeepsakeHistory(){
  if(!keepsakeEditor.maskCanvas)return;
  const canvas=keepsakeEditor.maskCanvas,ctx=canvas.getContext("2d",{willReadFrequently:true});
  keepsakeEditor.history.push(ctx.getImageData(0,0,canvas.width,canvas.height));
  if(keepsakeEditor.history.length>12)keepsakeEditor.history.shift();
  $("#keepsake-undo").disabled=false;
}
function paintMaskOverlay(target,mask,color="#55b98a"){
  const overlay=blankCanvas(mask.width,mask.height),ctx=overlay.getContext("2d");
  ctx.fillStyle=color;ctx.fillRect(0,0,overlay.width,overlay.height);ctx.globalCompositeOperation="destination-in";ctx.drawImage(mask,0,0);
  target.drawImage(overlay,0,0);
}
function keepsakeCutoutCanvas(){
  const source=keepsakeEditor.sourceCanvas,mask=keepsakeEditor.maskCanvas;if(!source||!mask)return null;
  const cutout=blankCanvas(source.width,source.height),ctx=cutout.getContext("2d");
  ctx.drawImage(source,0,0);ctx.globalCompositeOperation="destination-in";ctx.drawImage(mask,0,0);ctx.globalCompositeOperation="source-over";
  return cutout;
}
function renderKeepsakeCanvases(){
  if(!keepsakeEditor.sourceCanvas||!keepsakeEditor.maskCanvas)return;
  const source=keepsakeEditor.sourceCanvas,mask=keepsakeEditor.maskCanvas,editor=$("#keepsake-mask-canvas"),preview=$("#keepsake-preview-canvas");
  for(const canvas of[editor,preview]){if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height}}
  const editCtx=editor.getContext("2d"),previewCtx=preview.getContext("2d");
  editCtx.clearRect(0,0,editor.width,editor.height);editCtx.drawImage(source,0,0);editCtx.save();editCtx.globalAlpha=.48;paintMaskOverlay(editCtx,mask);editCtx.restore();
  previewCtx.clearRect(0,0,preview.width,preview.height);previewCtx.save();previewCtx.globalAlpha=.15;previewCtx.drawImage(source,0,0);previewCtx.restore();previewCtx.drawImage(keepsakeCutoutCanvas(),0,0);
}
function scheduleKeepsakeRender(){if(!keepsakeEditor.renderFrame)keepsakeEditor.renderFrame=requestAnimationFrame(()=>{keepsakeEditor.renderFrame=0;renderKeepsakeCanvases()})}
function maskImageDataFromCanvas(canvas){return canvas.getContext("2d",{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height)}
function dilatedMask(imageData,radius){
  const {width,height,data}=imageData,r=Math.max(0,Math.round(radius));if(!r)return new ImageData(new Uint8ClampedArray(data),width,height);
  const stride=width+1,integral=new Uint32Array((height+1)*stride);
  for(let y=0;y<height;y++){let row=0;for(let x=0;x<width;x++){row+=data[(y*width+x)*4+3]>20?1:0;integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+row}}
  const output=new ImageData(width,height),pixels=output.data;
  for(let y=0;y<height;y++){const top=Math.max(0,y-r),bottom=Math.min(height-1,y+r);for(let x=0;x<width;x++){const left=Math.max(0,x-r),right=Math.min(width-1,x+r),count=integral[(bottom+1)*stride+right+1]-integral[top*stride+right+1]-integral[(bottom+1)*stride+left]+integral[top*stride+left];if(count){const i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=pixels[i+3]=255}}}
  return output;
}
function softenedMask(imageData,radius=1){
  const {width,height,data}=imageData,r=Math.max(1,Math.round(radius)),stride=width+1,integral=new Uint32Array((height+1)*stride);
  for(let y=0;y<height;y++){let row=0;for(let x=0;x<width;x++){row+=data[(y*width+x)*4+3];integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+row}}
  const output=new ImageData(width,height),pixels=output.data;
  for(let y=0;y<height;y++){const top=Math.max(0,y-r),bottom=Math.min(height-1,y+r);for(let x=0;x<width;x++){const left=Math.max(0,x-r),right=Math.min(width-1,x+r),count=(bottom-top+1)*(right-left+1),alpha=Math.round((integral[(bottom+1)*stride+right+1]-integral[top*stride+right+1]-integral[(bottom+1)*stride+left]+integral[top*stride+left])/count),i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=255;pixels[i+3]=alpha}}
  return output;
}
function applyKeepsakeExpansion({history=false}={}){
  if(!keepsakeEditor.autoBase||!keepsakeEditor.maskCanvas)return;
  if(history)pushKeepsakeHistory();
  const value=Number($("#keepsake-edge-expansion").value),radius=Math.round(Math.max(keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height)*value/1000);
  keepsakeEditor.maskCanvas.getContext("2d").putImageData(softenedMask(dilatedMask(keepsakeEditor.autoBase,radius),Math.max(1,Math.round(Math.max(keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height)/800))),0,0);
  scheduleKeepsakeRender();
}
function keepsakeWorkingImage(maxSide){
  const source=keepsakeEditor.sourceCanvas,scale=Math.min(1,maxSide/Math.max(source.width,source.height)),width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale)),canvas=blankCanvas(width,height);
  canvas.getContext("2d").drawImage(source,0,0,width,height);
  return canvas;
}
async function applySegmentedKeepsakeMask(cutoutUrl,serial){
  const target=keepsakeEditor.maskCanvas,cutout=await loadImageSource(cutoutUrl);
  if(serial!==keepsakeEditor.segmentSerial||target!==keepsakeEditor.maskCanvas)return false;
  const temp=blankCanvas(target.width,target.height),tempCtx=temp.getContext("2d",{willReadFrequently:true});
  tempCtx.drawImage(cutout,0,0,temp.width,temp.height);
  const cutoutData=tempCtx.getImageData(0,0,temp.width,temp.height),maskData=new ImageData(temp.width,temp.height);
  for(let i=0;i<cutoutData.data.length;i+=4)maskData.data[i]=maskData.data[i+1]=maskData.data[i+2]=maskData.data[i+3]=cutoutData.data[i+3];
  target.getContext("2d").putImageData(maskData,0,0);
  keepsakeEditor.autoBase=maskImageDataFromCanvas(target);keepsakeEditor.source="auto";applyKeepsakeExpansion();
  return true;
}
function keepsakeSegmentationDataUrl(){
  return keepsakeWorkingImage(1600).toDataURL("image/jpeg",.9);
}
function resetKeepsakeEditor({close=false}={}){
  keepsakeEditor.segmentSerial+=1;keepsakeEditor.file=null;keepsakeEditor.sourceDataUrl="";keepsakeEditor.sourceImage=null;keepsakeEditor.sourceCanvas=null;keepsakeEditor.maskCanvas=null;keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";keepsakeEditor.originalPath="";keepsakeEditor.cutoutPath="";keepsakeEditor.drawing=false;keepsakeEditor.lastPoint=null;
  keepsakeEditor.mode="keep";$("#keepsake-brush-keep").classList.add("active");$("#keepsake-brush-erase").classList.remove("active");$("#keepsake-brush-keep").setAttribute("aria-pressed","true");$("#keepsake-brush-erase").setAttribute("aria-pressed","false");
  $("#keepsake-auto-segment").disabled=false;
  clearKeepsakeHistory();$("#keepsake-form").reset();$("#keepsake-id").value="";$("#keepsake-datetime").value=localDateTimeForDate(activeDate);$("#keepsake-edge-expansion").value="8";$("#keepsake-edge-output").value="8";$("#keepsake-image").value="";$("#keepsake-editor").hidden=true;$("#keepsake-upload-box").hidden=false;$("#keepsake-upload-box").classList.remove("dragging","has-image");$("#keepsake-upload-title").textContent="选择、粘贴或拖入小物照片";$("#keepsake-upload-hint").textContent="PNG / JPEG / WebP · 不超过 8 MB";$("#keepsake-segment-status").textContent="";$("#keepsake-save-status").textContent="";$("#keepsake-save").textContent="保存小物";$("#keepsake-cancel-edit").hidden=true;$("#keepsake-editor-eyebrow").textContent="新建留存";$("#keepsake-editor-title").textContent="拍下或放入一张照片";
  if(close)$("#keepsake-workspace").hidden=true;
}
async function prepareKeepsakeImage({dataUrl,file=null,cutoutUrl="",auto=true,serial=++keepsakeEditor.segmentSerial}){
  const image=await loadImageSource(dataUrl),maxSide=1600,scale=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale)),sourceCanvas=blankCanvas(width,height),maskCanvas=blankCanvas(width,height);
  if(serial!==keepsakeEditor.segmentSerial)return false;
  sourceCanvas.getContext("2d").drawImage(image,0,0,width,height);
  if(cutoutUrl){const cutout=await loadImageSource(cutoutUrl),temp=blankCanvas(width,height),tempCtx=temp.getContext("2d",{willReadFrequently:true});tempCtx.drawImage(cutout,0,0,width,height);const sourceData=tempCtx.getImageData(0,0,width,height),maskData=new ImageData(width,height);for(let i=0;i<sourceData.data.length;i+=4)maskData.data[i]=maskData.data[i+1]=maskData.data[i+2]=maskData.data[i+3]=sourceData.data[i+3];maskCanvas.getContext("2d").putImageData(maskData,0,0)}
  if(serial!==keepsakeEditor.segmentSerial)return false;
  keepsakeEditor.file=file;keepsakeEditor.sourceDataUrl=dataUrl;keepsakeEditor.sourceImage=image;keepsakeEditor.sourceCanvas=sourceCanvas;keepsakeEditor.maskCanvas=maskCanvas;keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";clearKeepsakeHistory();
  $("#keepsake-upload-box").hidden=true;$("#keepsake-editor").hidden=false;renderKeepsakeCanvases();
  if(auto)await segmentCurrentKeepsake();
  return true;
}
async function setKeepsakeFile(file,source="本地文件"){
  const status=$("#keepsake-segment-status");try{[file]=validatedImageFiles([file])}catch(error){status.textContent=error.message;return false}
  const serial=++keepsakeEditor.segmentSerial;$("#keepsake-auto-segment").disabled=false;
  $("#keepsake-workspace").hidden=false;status.textContent="正在读取照片…";
  try{const [dataUrl]=await imageDataUrls([file]);if(serial!==keepsakeEditor.segmentSerial)return false;if(!await prepareKeepsakeImage({dataUrl,file,auto:false,serial}))return false;keepsakeEditor.originalPath="";keepsakeEditor.cutoutPath="";status.textContent=`${source} · ${formatBytes(file.size)} · 正在识别主体…`;void segmentCurrentKeepsake();return true}catch(error){if(serial===keepsakeEditor.segmentSerial)status.textContent=error.message;return false}
}
async function segmentCurrentKeepsake(){
  const button=$("#keepsake-auto-segment"),status=$("#keepsake-segment-status");if(!keepsakeEditor.sourceDataUrl)return status.textContent="请先放入一张照片。";
  const serial=++keepsakeEditor.segmentSerial;button.disabled=true;status.textContent="正在识别主体，通常需要数秒…";pushKeepsakeHistory();
  try{
    const result=await request("/api/keepsakes/segment",{method:"POST",body:JSON.stringify({image:keepsakeSegmentationDataUrl()})});
    if(serial!==keepsakeEditor.segmentSerial)return;
    if(!result.cutout)throw new Error("服务未返回透明轮廓");
    if(!await applySegmentedKeepsakeMask(result.cutout,serial))return;
    status.textContent="自动轮廓已生成，可继续涂抹修正。";
  }catch(error){if(serial===keepsakeEditor.segmentSerial)status.textContent=`自动提取未完成：${error.message}。仍可手动涂抹。`}
  finally{if(serial===keepsakeEditor.segmentSerial)button.disabled=false}
}
function keepsakeCanvasPoint(event){
  const canvas=$("#keepsake-mask-canvas"),rect=canvas.getBoundingClientRect();
  return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
function paintKeepsakeStroke(from,to){
  const canvas=keepsakeEditor.maskCanvas;if(!canvas)return;const ctx=canvas.getContext("2d"),display=$("#keepsake-mask-canvas"),scale=canvas.width/display.getBoundingClientRect().width,size=Number($("#keepsake-brush-size").value)*scale;
  ctx.save();ctx.globalCompositeOperation=keepsakeEditor.mode==="erase"?"destination-out":"source-over";ctx.strokeStyle="#fff";ctx.fillStyle="#fff";ctx.lineWidth=size;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke();ctx.beginPath();ctx.arc(to.x,to.y,size/2,0,Math.PI*2);ctx.fill();ctx.restore();keepsakeEditor.source="manual";scheduleKeepsakeRender();
}
function keepsakeImageMarkup(item,className="",loading="lazy"){
  return `<span class="keepsake-image-stack ${className}"><img class="keepsake-image-original" src="${escapeHtml(appUrl(item.originalPath))}" alt="${escapeHtml(item.title)}" loading="${loading}"><img class="keepsake-image-cutout" src="${escapeHtml(appUrl(item.cutoutPath))}" alt="" aria-hidden="true" loading="${loading}"></span>`;
}
function keepsakeTagsMarkup(tags){
  return (tags||[]).length?`<span class="keepsake-tags">${tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</span>`:"";
}
function renderKeepsakeDetail(item){
  const original=activeKeepsakeView==="original",detail=$("#keepsake-detail");
  detail.dataset.keepsakeId=item.id;
  detail.innerHTML=`<nav class="keepsake-detail-nav"><button class="book-back" type="button" data-keepsake-back>← 返回陈列</button><div class="keepsake-detail-actions"><button class="text-button" type="button" data-keepsake-edit="${escapeHtml(item.id)}">编辑</button><button class="text-button danger" type="button" data-keepsake-delete="${escapeHtml(item.id)}">删除</button></div></nav>
    <div class="keepsake-detail-layout">
      <section class="keepsake-detail-media">
        <div class="keepsake-detail-viewbar"><span>${original?"原始照片":"主体清晰 · 环境 15%"}</span><div class="segmented-control" aria-label="图片显示方式"><button type="button" data-keepsake-view="presentation" aria-pressed="${String(!original)}" class="${original?"":"active"}">呈现</button><button type="button" data-keepsake-view="original" aria-pressed="${String(original)}" class="${original?"active":""}">原图</button></div></div>
        <div class="keepsake-detail-image-wrap">${keepsakeImageMarkup(item,original?"keepsake-detail-image show-original":"keepsake-detail-image","eager")}</div>
      </section>
      <section class="keepsake-detail-copy">
        <p class="eyebrow">${escapeHtml(item.category||"其他")}</p>
        <h2>${escapeHtml(item.title)}</h2>
        <time datetime="${escapeHtml(eventTimestamp(item))}">${escapeHtml(formatDateKey(eventDate(item)))} · ${formatTime(eventTimestamp(item))}</time>
        ${keepsakeTagsMarkup(item.tags)}
        <p class="keepsake-detail-note">${item.note?escapeHtml(item.note):"没有留下文字备注。"}</p>
      </section>
    </div>`;
}
function renderKeepsakes(){
  const items=[...(state.keepsakes||[])].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a)));
  let detailItem=items.find(item=>item.id===activeKeepsakeId);if(activeKeepsakeId&&!detailItem){activeKeepsakeId="";activeKeepsakeView="presentation"}
  detailItem=items.find(item=>item.id===activeKeepsakeId);const inDetail=Boolean(detailItem),library=$(".keepsake-library"),detail=$("#keepsake-detail");
  $("#view-keepsakes").classList.toggle("keepsake-detail-mode",inDetail);$("#keepsake-count").textContent=items.length?`${items.length} 件`:"";$("#keepsake-library-count").textContent=`${items.length} 件`;$("#keepsake-create-toggle").hidden=inDetail;library.hidden=inDetail;detail.hidden=!inDetail;
  if(inDetail){renderKeepsakeDetail(detailItem);return}
  detail.innerHTML="";
  $("#keepsake-grid").innerHTML=items.length?items.map(item=>`<article class="keepsake-card" data-keepsake-id="${escapeHtml(item.id)}"><button class="keepsake-card-open" type="button" data-keepsake-open="${escapeHtml(item.id)}" aria-label="查看 ${escapeHtml(item.title)} 详情">${keepsakeImageMarkup(item,"keepsake-card-image")}<span class="keepsake-card-copy"><span class="keepsake-card-meta"><span class="keepsake-card-category">${escapeHtml(item.category||"其他")}</span><time>${formatDate(eventTimestamp(item))}</time></span><strong>${escapeHtml(item.title)}</strong>${item.note?`<span class="keepsake-card-note">${escapeHtml(item.note)}</span>`:""}${keepsakeTagsMarkup(item.tags)}</span></button><div class="keepsake-card-actions"><button type="button" data-keepsake-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="danger" data-keepsake-delete="${escapeHtml(item.id)}">删除</button></div></article>`).join(""):empty("还没有数字留存的小物。");
}
async function editKeepsake(id){
  const item=(state.keepsakes||[]).find(value=>value.id===id);if(!item)return;
  resetKeepsakeEditor();const serial=keepsakeEditor.segmentSerial;
  activeKeepsakeId="";activeKeepsakeView="presentation";renderKeepsakes();$("#keepsake-workspace").hidden=false;$("#keepsake-editor-eyebrow").textContent="编辑留存";$("#keepsake-editor-title").textContent=item.title;$("#keepsake-id").value=item.id;$("#keepsake-title").value=item.title;$("#keepsake-category").value=item.category||"其他";$("#keepsake-datetime").value=toLocalDateTimeInput(eventTimestamp(item));$("#keepsake-tags").value=(item.tags||[]).join(" ");$("#keepsake-note").value=item.note||"";$("#keepsake-edge-expansion").value=String(item.edgeExpansion??8);$("#keepsake-edge-output").value=String(item.edgeExpansion??8);$("#keepsake-save").textContent="保存修改";$("#keepsake-cancel-edit").hidden=false;$("#keepsake-segment-status").textContent="正在载入原图与已有轮廓…";
  try{const [originalResponse,cutoutResponse]=await Promise.all([fetch(appUrl(item.originalPath)),fetch(appUrl(item.cutoutPath))]);if(!originalResponse.ok||!cutoutResponse.ok)throw new Error("已有图片读取失败");const [dataUrl,cutoutUrl]=await Promise.all([dataUrlFromBlob(await originalResponse.blob()),dataUrlFromBlob(await cutoutResponse.blob())]);if(serial!==keepsakeEditor.segmentSerial)return;if(!await prepareKeepsakeImage({dataUrl,cutoutUrl,auto:false,serial}))return;keepsakeEditor.originalPath=item.originalPath;keepsakeEditor.cutoutPath=item.cutoutPath;$("#keepsake-segment-status").textContent="已有轮廓已载入，可涂抹修正或重新识别。";$("#keepsake-workspace").scrollIntoView({behavior:"smooth",block:"start"})}catch(error){if(serial===keepsakeEditor.segmentSerial)$("#keepsake-segment-status").textContent=error.message}
}
function openKeepsakeDetail(id){
  if(!(state.keepsakes||[]).some(item=>item.id===id))return;activeKeepsakeId=id;activeKeepsakeView="presentation";resetKeepsakeEditor({close:true});renderKeepsakes();window.scrollTo({top:0,behavior:"smooth"});
}
function setKeepsakeDetailView(view){
  if(!activeKeepsakeId)return;activeKeepsakeView=view==="original"?"original":"presentation";const item=(state.keepsakes||[]).find(value=>value.id===activeKeepsakeId);if(item)renderKeepsakeDetail(item);
}
function rotatingQuotes(){
  const quotes=[...(state.quotes||[])],tagNames=[...new Set(quotes.flatMap(item=>item.tags||[]))],selected=[],selectedIds=new Set();
  if(tagNames.length){for(let offset=0;offset<tagNames.length&&selected.length<3;offset++){const tag=tagNames[(quoteSkyIndex+offset)%tagNames.length],bucket=quotes.filter(item=>(item.tags||[]).includes(tag)&&!selectedIds.has(item.id));if(!bucket.length)continue;const item=bucket[(quoteSkyIndex+offset)%bucket.length];selected.push(item);selectedIds.add(item.id)}}
  for(let offset=0;offset<quotes.length&&selected.length<3;offset++){const item=quotes[(quoteSkyIndex+offset)%quotes.length];if(!selectedIds.has(item.id)){selected.push(item);selectedIds.add(item.id)}}
  return selected;
}
const quoteTagsMarkup=tags=>(tags||[]).length?`<div class="quote-tags">${tags.map(tag=>`<span>#${escapeHtml(tag)}</span>`).join("")}</div>`:"";
function stopQuoteBubbleScroll(){if(quoteScrollFrame)cancelAnimationFrame(quoteScrollFrame);quoteScrollFrame=0}
function runQuoteBubbleScroll(now){
  if(document.hidden||!$("#view-quotes").classList.contains("active")){quoteScrollFrame=0;return}
  let active=false;
  $$(".quote-bubble p.is-auto-scrolling").forEach(viewport=>{
    const scrollState=quoteScrollStates.get(viewport),maximum=viewport.scrollHeight-viewport.clientHeight;if(!scrollState||maximum<=1)return;
    active=true;const elapsed=Math.min(64,now-scrollState.lastTime)/1000;scrollState.lastTime=now;
    if(now<scrollState.resumeAt){scrollState.position=viewport.scrollTop;scrollState.velocity=0;viewport.classList.toggle("is-user-scrolling",scrollState.userPaused);return}
    scrollState.userPaused=false;viewport.classList.remove("is-user-scrolling");
    if(now<scrollState.holdUntil){scrollState.velocity=0;return}
    const remaining=scrollState.direction>0?maximum-scrollState.position:scrollState.position;
    if(remaining<=.25){scrollState.position=scrollState.direction>0?maximum:0;viewport.scrollTop=scrollState.position;scrollState.direction*=-1;scrollState.velocity=0;scrollState.holdUntil=now+800;return}
    const cruiseSpeed=14,acceleration=18,targetSpeed=Math.min(cruiseSpeed,Math.sqrt(2*acceleration*remaining)),currentSpeed=Math.abs(scrollState.velocity),speedStep=acceleration*elapsed;
    const speed=currentSpeed<targetSpeed?Math.min(targetSpeed,currentSpeed+speedStep):Math.max(targetSpeed,currentSpeed-speedStep);
    scrollState.velocity=scrollState.direction*speed;
    const next=scrollState.position+scrollState.velocity*elapsed;
    if(next>=maximum||next<=0){scrollState.position=scrollState.direction>0?maximum:0;viewport.scrollTop=scrollState.position;scrollState.direction*=-1;scrollState.velocity=0;scrollState.holdUntil=now+800}
    else{scrollState.position=next;viewport.scrollTop=next}
  });
  quoteScrollFrame=active?requestAnimationFrame(runQuoteBubbleScroll):0;
}
function setupQuoteBubbleScroll(){
  stopQuoteBubbleScroll();const now=performance.now(),reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$(".quote-bubble p").forEach(viewport=>{
    viewport.classList.remove("is-auto-scrolling");viewport.removeAttribute("tabindex");viewport.scrollTop=0;
    if(viewport.scrollHeight-viewport.clientHeight<=1)return;
    viewport.classList.add("is-auto-scrolling");viewport.tabIndex=0;
    quoteScrollStates.set(viewport,{direction:1,position:0,velocity:0,lastTime:now,resumeAt:now+1200,holdUntil:0,userPaused:false});
  });
  if(!reduceMotion&&$("#view-quotes").classList.contains("active")&&$$(".quote-bubble p.is-auto-scrolling").length)quoteScrollFrame=requestAnimationFrame(runQuoteBubbleScroll);
}
function deferQuoteBubbleScroll(viewport){const scrollState=quoteScrollStates.get(viewport);if(!scrollState)return;const now=performance.now();scrollState.direction=1;scrollState.position=viewport.scrollTop;scrollState.velocity=0;scrollState.lastTime=now;scrollState.resumeAt=now+5000;scrollState.holdUntil=0;scrollState.userPaused=true;viewport.classList.add("is-user-scrolling")}
function renderQuoteSky(advance=false){const sky=$("#quote-sky-content"),previousIds=new Set([...sky.querySelectorAll(".quote-bubble")].map(item=>item.dataset.quoteId));if(advance)quoteSkyIndex+=1;const items=rotatingQuotes();if(advance&&state.quotes.length>items.length&&items.every(item=>previousIds.has(item.id))){const alternate=state.quotes.find(item=>!previousIds.has(item.id));if(alternate)items[items.length-1]=alternate}sky.innerHTML=items.length?items.map(x=>{const visibleLines=3+Math.floor(Math.random()*3);return `<article class="quote-bubble" data-quote-id="${x.id}" data-visible-lines="${visibleLines}" style="--quote-content-max-height:${(visibleLines*1.72).toFixed(2)}em"><p><span class="quote-scroll-track">“<span class="quote-content">${escapeHtml(x.content)}</span>”</span></p>${quoteTagsMarkup(x.tags)}<small>— ${escapeHtml(x.source)}</small></article>`}).join(""):`<div class="empty quote-sky-empty">收藏至少一条善言后，它们会在这里随机浮现。</div>`;items.forEach(item=>markCommentTarget(sky.querySelector(`[data-quote-id="${CSS.escape(item.id)}"] .quote-content`),commentRootKey("quote",item.id),"content"));applyCommentAnchors(sky);requestAnimationFrame(setupQuoteBubbleScroll)}
function syncQuoteOverflow(){
  $$(".quote-entry").forEach(entry=>{
    const viewport=entry.querySelector(".quote-content-viewport"),button=entry.querySelector("[data-quote-expand]");if(!viewport||!button)return;
    const wasExpanded=viewport.classList.contains("expanded");viewport.classList.remove("expanded");
    const overflows=viewport.scrollHeight>viewport.clientHeight+1;
    viewport.classList.toggle("expanded",wasExpanded&&overflows);button.hidden=!overflows;button.textContent=wasExpanded&&overflows?"收起":"展开";button.setAttribute("aria-expanded",String(wasExpanded&&overflows));
  });
}
function renderQuotes(){
  const dateOf=eventDate,items=[...state.quotes].sort((a,b)=>eventTimestamp(b).localeCompare(eventTimestamp(a))),timeline=$("#quote-timeline");
  renderQuoteSky();
  timeline.innerHTML=items.length?items.map((item,index)=>`<article class="quote-entry" data-quote-id="${item.id}">${index===0||dateOf(item)!==dateOf(items[index-1])?`<div class="quote-date">${escapeHtml(dateOf(item))}</div>`:""}<header class="quote-entry-meta"><cite title="${escapeHtml(item.source)}">${escapeHtml(item.source)}</cite><span class="quote-entry-tools"><time>${formatTime(eventTimestamp(item))}</time><button class="subtle-action" type="button" data-quote-edit="${item.id}">编辑</button><button class="subtle-action danger" type="button" data-quote-delete="${item.id}">删除</button></span></header><div class="quote-entry-card card"><blockquote class="quote-content-viewport">${escapeHtml(item.content)}</blockquote><button class="quote-expand" type="button" data-quote-expand aria-expanded="false" hidden>展开</button>${quoteTagsMarkup(item.tags)}</div></article>`).join(""):"";
  items.forEach(item=>markCommentTarget(timeline.querySelector(`[data-quote-id="${CSS.escape(item.id)}"] blockquote`),commentRootKey("quote",item.id),"content"));
  applyCommentAnchors(timeline);requestAnimationFrame(syncQuoteOverflow);clearInterval(quoteTimer);
  if(state.quotes.length>3)quoteTimer=setInterval(()=>{if($("#view-quotes").classList.contains("active")&&!document.hidden&&!$("#quote-sky").matches(":hover"))renderQuoteSky(true)},24000);
}
function resetQuoteForm(){const form=$("#quote-form");form.reset();$("#quote-id").value="";$("#quote-datetime").value=localDateTimeForDate(activeDate);$("#quote-submit").textContent="收藏";$("#quote-cancel").hidden=true;$("#quote-status").textContent=""}
function editQuote(id){const quote=state.quotes.find(item=>item.id===id);if(!quote)return;$("#quote-id").value=id;$("#quote-source").value=quote.source;$("#quote-content").value=quote.content;$("#quote-tags").value=(quote.tags||[]).join(" ");$("#quote-datetime").value=toLocalDateTimeInput(eventTimestamp(quote));$("#quote-submit").textContent="保存修改";$("#quote-cancel").hidden=false;$("#quote-status").textContent="正在编辑已有善言";$("#quote-form").scrollIntoView({behavior:"smooth",block:"center"});$("#quote-content").focus()}
function selectionQuoteSource(rootKey){const root=commentRoot(rootKey),label=commentRootLabel(rootKey),{type}=parseCommentRootKey(rootKey);const title=type==="book"?root?.title:type==="journal"?root?.title||root?.content:type==="quote"?root?.source:type==="chat"?root?.message:root?.content;return `${label}${title?` · ${plainPreview(title).slice(0,60)}`:""}`}
function closeSelectionQuoteModal(){const modal=$("#selection-quote-modal");modal.hidden=true;$("#selection-quote-form").reset();$("#selection-quote-status").textContent=""}
function openSelectionQuoteModal(selection){const label=commentRootLabel(selection.rootKey);$("#selection-quote-content").value=selection.quote;$("#selection-quote-source").value=selectionQuoteSource(selection.rootKey);$("#selection-quote-tags").value=label;$("#selection-quote-datetime").value=localDateTimeForDate(activeDate);$("#selection-quote-status").textContent="";$("#selection-quote-modal").hidden=false;pendingSelection=null;window.getSelection()?.removeAllRanges();$("#selection-quote-content").focus()}
function llmProfile(scene="thoughtAnswer"){const tier=llmSettings.scenarios?.[scene]||"high",profile=llmSettings.profiles?.[tier]||defaultLlmProfiles[tier]||defaultLlmProfiles.high;return{tier,...profile}}
function modelName(scene="thoughtAnswer"){const profile=llmProfile(scene);return `${profile.model==="deepseek-v4-pro"?"DeepSeek Pro":"DeepSeek Flash"} · ${profile.tier[0].toUpperCase()+profile.tier.slice(1)}`}
function settingsPayload(){return{profiles:Object.fromEntries(llmTiers.map(tier=>[tier,{model:$(`[data-profile-model="${tier}"]`).value,effort:$(`[data-profile-effort="${tier}"]`).value}])),scenarios:Object.fromEntries($$("[data-ai-scenario]").map(select=>[select.dataset.aiScenario,select.value])),apiKey:$("#llm-api-key").value}}
function renderSettings(){const badge=$("#llm-key-state"),hint=$("#llm-key-hint");if(!badge)return;llmSettings.profiles={...structuredClone(defaultLlmProfiles),...(llmSettings.profiles||{})};llmSettings.scenarios={...defaultLlmScenarios,...(llmSettings.scenarios||{})};for(const tier of llmTiers){$(`[data-profile-model="${tier}"]`).value=llmSettings.profiles[tier].model;$(`[data-profile-effort="${tier}"]`).value=llmSettings.profiles[tier].effort}$$("[data-ai-scenario]").forEach(select=>{if(!select.options.length)select.innerHTML=llmTiers.map(tier=>`<option value="${tier}">${tier[0].toUpperCase()+tier.slice(1)}</option>`).join("");select.value=llmSettings.scenarios[select.dataset.aiScenario]});badge.textContent=llmSettings.hasApiKey?"密钥已配置":"未配置密钥";badge.classList.toggle("ready",llmSettings.hasApiKey);hint.textContent=llmSettings.hasApiKey?`${llmSettings.keyHint} · 留空保留原密钥`:"仅保存在本机";const chat=llmProfile("chat");$("#chat-model-label").textContent=`${modelName("chat")} · ${chat.effort==="none"?"不思考":chat.effort.toUpperCase()}`}
const shiftLocalDateKey=(dateKey,days)=>{const [year,month,day]=String(dateKey).split("-").map(Number),date=new Date(Date.UTC(year,month-1,day+days));return date.toISOString().slice(0,10)};
const compactNumber=value=>new Intl.NumberFormat("zh-CN",{notation:"compact",maximumFractionDigits:1}).format(Number(value)||0);
const formatUsd=value=>{const number=Number(value)||0,digits=number>=1?2:number>=.01?3:number>=.001?4:6;return `$${number.toFixed(digits)}`};
const formatDuration=value=>{const milliseconds=Number(value)||0;return milliseconds>=60000?`${(milliseconds/60000).toFixed(1)} 分钟`:milliseconds>=1000?`${(milliseconds/1000).toFixed(1)} 秒`:`${Math.round(milliseconds)} ms`};
const shortDate=value=>{const [,month,day]=String(value).split("-");return `${Number(month)}/${Number(day)}`};
const sceneLabels={thoughtPrompt:"思考引子",thoughtDraft:"思考草稿",thoughtAnswer:"思考回答",followUpAnswer:"追问回答",chat:"长期对话",diaryLead:"日记引子",diaryStructure:"日记结构",diaryTopic:"日记话题",diaryReflection:"日记回望",annotationShenji:"批注神鸡",analysis:"认知复盘",bookRecognition:"书目识别",healthRecognition:"健康识别",lite:"连接测试",mid:"连接测试",high:"连接测试",ultra:"连接测试"};
function chartFrame(daily,series,{ariaLabel,valueLabel=compactNumber}={}){
  const width=760,height=260,pad={left:54,right:18,top:16,bottom:38},plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom,max=Math.max(1,...series.flatMap(item=>item.values)),x=index=>pad.left+(daily.length<=1?plotWidth/2:index*plotWidth/(daily.length-1)),y=value=>pad.top+plotHeight-(Number(value)||0)/max*plotHeight;
  const grid=[0,.5,1].map(ratio=>{const py=pad.top+plotHeight*(1-ratio);return `<line x1="${pad.left}" y1="${py}" x2="${width-pad.right}" y2="${py}"></line><text x="${pad.left-9}" y="${py+4}" text-anchor="end">${escapeHtml(valueLabel(max*ratio))}</text>`}).join("");
  const labelIndexes=[0,Math.floor((daily.length-1)/2),daily.length-1].filter((value,index,array)=>array.indexOf(value)===index);
  const dates=labelIndexes.map(index=>`<text x="${x(index)}" y="${height-12}" text-anchor="${index===0?"start":index===daily.length-1?"end":"middle"}">${escapeHtml(shortDate(daily[index]?.date||""))}</text>`).join("");
  const paths=series.map(item=>{const points=item.values.map((value,index)=>`${x(index)},${y(value)}`).join(" "),dots=item.values.length<=31?item.values.map((value,index)=>`<circle cx="${x(index)}" cy="${y(value)}" r="3"><title>${escapeHtml(`${item.label} · ${daily[index]?.date} · ${valueLabel(value)}`)}</title></circle>`).join(""):"";return `<g class="analytics-series" style="--series:${item.color}"><polyline points="${points}"></polyline>${dots}</g>`}).join("");
  const legend=series.map(item=>`<span><i style="--series:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("");
  return `<svg class="analytics-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel||"统计图")}"><g class="analytics-grid">${grid}${dates}</g>${paths}</svg><div class="analytics-legend">${legend}</div>`;
}
function stackedTokenChart(daily){
  const width=760,height=260,pad={left:54,right:18,top:16,bottom:38},plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom,answer=daily.map(item=>item.tokens.answer||0),reasoning=daily.map(item=>item.tokens.reasoning||0),total=answer.map((value,index)=>value+reasoning[index]),max=Math.max(1,...total),x=index=>pad.left+(daily.length<=1?plotWidth/2:index*plotWidth/(daily.length-1)),y=value=>pad.top+plotHeight-value/max*plotHeight,path=values=>values.map((value,index)=>`${index?"L":"M"} ${x(index)} ${y(value)}`).join(" "),area=(top,bottom)=>`${path(top)} ${bottom.map((_,index)=>`L ${x(bottom.length-1-index)} ${y(bottom[bottom.length-1-index])}`).join(" ")} Z`;
  const grid=[0,.5,1].map(ratio=>{const py=pad.top+plotHeight*(1-ratio);return `<line x1="${pad.left}" y1="${py}" x2="${width-pad.right}" y2="${py}"></line><text x="${pad.left-9}" y="${py+4}" text-anchor="end">${escapeHtml(compactNumber(max*ratio))}</text>`}).join("");
  const labelIndexes=[0,Math.floor((daily.length-1)/2),daily.length-1].filter((value,index,array)=>array.indexOf(value)===index),dates=labelIndexes.map(index=>`<text x="${x(index)}" y="${height-12}" text-anchor="${index===0?"start":index===daily.length-1?"end":"middle"}">${escapeHtml(shortDate(daily[index]?.date||""))}</text>`).join("");
  return `<svg class="analytics-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="回答与推理 Token 每日面积图"><g class="analytics-grid">${grid}${dates}</g><path class="analytics-area answer" d="${area(answer,answer.map(()=>0))}"></path><path class="analytics-area reasoning" d="${area(total,answer)}"></path><path class="analytics-area-line answer" d="${path(answer)}"></path><path class="analytics-area-line reasoning" d="${path(total)}"></path></svg><div class="analytics-legend"><span><i style="--series:#4f8d78"></i>回答</span><span><i style="--series:#c18c3f"></i>推理</span></div>`;
}
function renderStatistics(data){
  statisticsData=data;
  const {records,ai}=data,summary=ai.summary;
  $("#record-total").innerHTML=`<strong>${records.total}</strong><span>累计条目</span>`;
  const recordMarkup=items=>items.map(item=>`<div><dt>${escapeHtml(item.label)}</dt><dd>${item.count}</dd></div>`).join("");
  $("#record-content-stats").innerHTML=recordMarkup(records.content);
  $("#record-interaction-stats").innerHTML=recordMarkup(records.interactions);
  const totalTokens=summary.tokens.input+summary.tokens.output,cacheRate=summary.tokens.input?summary.tokens.cacheHit/summary.tokens.input*100:0,averageCost=summary.calls?summary.costsUsd.total/summary.calls:0,knownStatuses=(summary.successfulCalls||0)+(summary.failedCalls||0),successRate=knownStatuses?(summary.successfulCalls||0)/knownStatuses*100:null,averageDuration=summary.durationKnownCalls?(summary.durationMs||0)/summary.durationKnownCalls:0,vision=ai.modalities?.find(item=>item.modality==="vision")||{calls:summary.visionCalls||0,imageCount:summary.imageCount||0,costsUsd:{total:0}};
  $("#ai-kpis").innerHTML=[
    ["总费用",formatUsd(summary.costsUsd.total),"按官方单价估算"],
    ["调用次数",compactNumber(summary.calls),"次"],
    ["成功率",successRate==null?"未知":`${successRate.toFixed(successRate>=10?0:1)}%`,`${summary.failedCalls||0} 次失败 · ${summary.unknownStatusCalls||0} 次历史未知`],
    ["图片理解",compactNumber(vision.calls),`${compactNumber(vision.imageCount)} 张 · ${formatUsd(vision.costsUsd.total)}`],
    ["总 Token",compactNumber(totalTokens),"输入与输出"],
    ["缓存命中率",`${cacheRate.toFixed(cacheRate>=10?0:1)}%`,`${compactNumber(summary.tokens.cacheHit)} Token`],
    ["平均费用",formatUsd(averageCost),"每次实际请求"],
    ["平均响应",summary.durationKnownCalls?formatDuration(averageDuration):"未知",`${summary.usageUnknownCalls||0} 次用量未知`]
  ].map(([label,value,note])=>`<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
  $("#ai-tracking-since").textContent=`自 ${new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(ai.trackingStartedAt))} 开始统计`;
  const modelColors={"deepseek-flash":"#4f8d78","deepseek-v4-pro":"#a65f4b"};
  const callSeries=ai.models.map(model=>({label:model.label,color:modelColors[model.model],values:ai.daily.map(day=>day.models[model.model]?.calls||0)}));
  callSeries.push({label:"其中图片理解",color:"#c18c3f",values:ai.daily.map(day=>day.visionCalls||0)});
  $("#ai-calls-chart").innerHTML=chartFrame(ai.daily,callSeries,{ariaLabel:"各 DeepSeek 模型与图片理解每日调用次数",valueLabel:value=>String(Math.round(value))});
  $("#ai-token-chart").innerHTML=stackedTokenChart(ai.daily);
  $("#ai-modality-summary").innerHTML=`<table><thead><tr><th>输入方式</th><th>调用</th><th>成功</th><th>图片</th><th>总 Token</th><th>费用</th><th>平均响应</th></tr></thead><tbody>${(ai.modalities||[]).map(item=>`<tr><td>${escapeHtml(item.label)}</td><td>${item.calls}</td><td>${item.successfulCalls||0}</td><td>${item.imageCount||0}</td><td>${compactNumber((item.tokens?.input||0)+(item.tokens?.output||0))}</td><td>${formatUsd(item.costsUsd?.total)}</td><td>${item.durationKnownCalls?formatDuration((item.durationMs||0)/item.durationKnownCalls):"未知"}</td></tr>`).join("")}</tbody></table>`;
  const costSeries=[["input","输入未命中","#5c7891"],["cacheHit","缓存命中","#4f8d78"],["reasoning","推理","#c18c3f"],["output","回答","#a65f4b"]];
  $("#ai-cost-charts").innerHTML=ai.models.map(model=>`<section><h4>${escapeHtml(model.label)} <span>${model.calls} 次 · ${formatUsd(model.costsUsd.total)}</span></h4>${chartFrame(ai.daily,costSeries.map(([key,label,color])=>({label,color,values:ai.daily.map(day=>day.models[model.model]?.costsUsd[key]||0)})),{ariaLabel:`${model.label} 每日费用构成`,valueLabel:formatUsd})}</section>`).join("");
  const maxScene=Math.max(1,...ai.scenes.map(item=>item.calls));
  $("#ai-scenario-bars").innerHTML=ai.scenes.length?ai.scenes.map(item=>`<div><span>${escapeHtml(sceneLabels[item.scene]||item.scene)}</span><i><b style="width:${item.calls/maxScene*100}%"></b></i><strong>${item.calls}</strong></div>`).join(""):`<div class="analytics-empty">这段时间还没有 AI 调用。</div>`;
  $("#ai-model-summary").innerHTML=`<table><thead><tr><th>模型</th><th>调用</th><th>图片</th><th>失败</th><th>输入</th><th>输出</th><th>费用</th></tr></thead><tbody>${ai.models.map(model=>`<tr><td>${escapeHtml(model.label)}</td><td>${model.calls}</td><td>${model.visionCalls||0}</td><td>${model.failedCalls||0}</td><td>${compactNumber(model.tokens.input)}</td><td>${compactNumber(model.tokens.output)}</td><td>${formatUsd(model.costsUsd.total)}</td></tr>`).join("")}</tbody></table>`;
  const pricing=ai.pricing;
  $("#ai-pricing").innerHTML=`<p>${escapeHtml(pricing.estimateNote)} 价格核对于 ${escapeHtml(pricing.checkedAt)}，单位为美元 / 百万 Token。<a href="${escapeHtml(pricing.source)}" target="_blank" rel="noopener noreferrer">DeepSeek 官方价格</a></p><div class="pricing-table-wrap"><table><thead><tr><th>模型</th><th>时段</th><th>缓存命中</th><th>输入未命中</th><th>输出</th></tr></thead><tbody>${Object.entries(pricing.models).flatMap(([,model])=>[["offPeak","谷时"],["peak","峰时"]].map(([key,label])=>`<tr><td>${escapeHtml(model.label)}</td><td>${label}</td><td>$${model[key].cacheHit}</td><td>$${model[key].cacheMiss}</td><td>$${model[key].output}</td></tr>`)).join("")}</tbody></table></div>`;
}
function setStatisticsRange(days=7){
  $("#statistics-to").value=currentLocalDate;$("#statistics-from").value=shiftLocalDateKey(currentLocalDate,1-days);
  $$("[data-statistics-days]").forEach(button=>button.classList.toggle("active",Number(button.dataset.statisticsDays)===days));
}
async function loadStatistics(){
  const from=$("#statistics-from").value,to=$("#statistics-to").value;if(!from||!to)setStatisticsRange(7);
  const serial=++statisticsRequestSerial,status=$("#statistics-status"),button=$("#statistics-range-form button[type='submit']");
  button.disabled=true;status.textContent="正在汇总记录与 AI 用量…";
  try{const data=await request(`/api/statistics?from=${encodeURIComponent($("#statistics-from").value)}&to=${encodeURIComponent($("#statistics-to").value)}`);if(serial!==statisticsRequestSerial)return;renderStatistics(data);status.textContent=""}
  catch(error){if(serial===statisticsRequestSerial)status.textContent=error.message}
  finally{if(serial===statisticsRequestSerial)button.disabled=false}
}
function renderDate(){$$("[data-active-date]").forEach(input=>input.value=activeDate);if(!$("#capture-id")?.value)$("#capture-date").value=localDateTimeForDate(activeDate);if(!$("#journal-id")?.value)$("#journal-date").value=localDateTimeForDate(activeDate);if(!$("#quote-id")?.value)$("#quote-datetime").value=localDateTimeForDate(activeDate);if(!$("#keepsake-id")?.value)$("#keepsake-datetime").value=localDateTimeForDate(activeDate);$$("[data-daily-form]").forEach(form=>{if(!form.elements.recordId.value)form.elements.occurredAt.value=localDateTimeForDate(activeDate)});const d=new Date(`${activeDate}T12:00:00`),today=activeDate===localDateKey(),label=new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"}).format(d);$$("[data-active-date-label]").forEach(element=>element.textContent=label);$$("[data-active-date-heading]").forEach(element=>{const view=element.closest(".view")?.id;element.textContent=!today?"回到这一天":view==="view-daily"?"今天，留下了什么？":view==="view-together"?"今天，一起看看":"今天，你感觉怎么样？"})}
function render(){renderDate();renderSliders();renderDailyRecords();renderHealthUploader();renderCaptures();renderJournals();renderThoughts();renderStateChart();renderChat();renderReview();renderBooks();renderKeepsakes();renderQuotes();renderTagComposer();renderCaptureTagComposer();renderCommentPanel();renderSettings()}
async function load(){journalDraftRestored=false;resetJournalForm();[state,llmSettings]=await Promise.all([request("/api/state"),request("/api/settings")]);render()}
function setAuthTab(tab){
  $$("[data-auth-tab]").forEach(button=>{const active=button.dataset.authTab===tab;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});
  $("#login-form").hidden=tab!=="login";$("#register-form").hidden=tab!=="register";$("#auth-status").textContent="";
  (tab==="login"?$("#login-form"):$("#register-form")).elements.username.focus();
}
function showAuthGate(){
  currentUser=null;document.body.classList.add("auth-locked");$("#auth-gate").hidden=false;$("#account-control").hidden=true;$("#account-authenticated").hidden=true;
}
function renderAccountIdentity(){
  const username=currentUser?.username||"";
  $("#account-name").textContent=username;$("#account-current-name").textContent=username;$("#account-page-name").textContent=username;$("#account-username").value=username;
}
function unlockForUser(user,authRequired){
  currentUser=user;document.body.classList.remove("auth-locked");$("#auth-gate").hidden=true;$("#account-control").hidden=!authRequired;$("#account-authenticated").hidden=!authRequired;$("#account-local-mode").hidden=authRequired;renderAccountIdentity();
  if(authRequired)$(".local-note").textContent="● 账户数据已隔离";
}
async function authRequest(endpoint,payload,method="POST"){
  const response=await fetch(appUrl(endpoint),{method,headers:{"content-type":"application/json"},body:JSON.stringify(payload||{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||"账户操作失败");return result;
}
async function bootstrap(){
  let response;
  try{response=await fetch(appUrl("/api/auth/me"),{headers:{accept:"application/json"}})}catch{showAuthGate();$("#auth-status").textContent="无法连接服务，请检查网络后重试。";return}
  const session=await response.json();
  if(!session.authenticated){showAuthGate();setAuthTab(session.userCount?"login":"register");return}
  unlockForUser(session.user,session.authRequired);await load();
}
async function refreshState(domains,options={}){state=await request("/api/state");const wanted=new Set(Array.isArray(domains)?domains:[domains]);if(wanted.has("dailyRecords"))renderDailyRecords();if(wanted.has("captures")){renderCaptures();renderCaptureTagComposer()}if(wanted.has("journals"))renderJournals();if(wanted.has("thoughts")){renderThoughts(options);renderTagComposer();renderCaptureTagComposer()}if(wanted.has("checkins")){renderStateChart();renderSliders()}if(wanted.has("chat"))renderChat();if(wanted.has("review"))renderReview();if(wanted.has("books")){renderBooks();if(activeCommentRoot.startsWith("book:"))renderCommentPanel()}if(wanted.has("keepsakes"))renderKeepsakes();if(wanted.has("quotes"))renderQuotes();if(wanted.has("comments"))renderCommentPanel()}
function setAnswerModalStep(step){const order=["context","thinking","answer","done"],current=order.indexOf(step);$$("#ai-answer-progress li").forEach((item,index)=>{item.classList.toggle("active",index===current);item.classList.toggle("done",index<current||(step==="done"&&index===current))})}
function closeAnswerModal(){const modal=$("#ai-answer-modal"),busy=modal.dataset.busy==="true";modal.hidden=true;if(busy)showToast("回答继续在后台生成，完成后会提醒。")}
async function runAnswerInModal({title,scene="thoughtAnswer",requestCall,onDone}){
  const taskId=++answerTaskSerial,modal=$("#ai-answer-modal"),result=$("#ai-answer-result"),output=$("#ai-answer-output"),reasoningBox=$("#ai-answer-reasoning"),reasoningContent=$("#ai-answer-reasoning-content"),reasoningState=$("#ai-answer-reasoning-state"),status=$("#ai-answer-status");
  activeAnswerTaskId=taskId;modal.hidden=false;modal.dataset.busy="true";$("#ai-answer-title").textContent=title;output.hidden=true;result.innerHTML="";reasoningBox.hidden=true;reasoningBox.open=true;reasoningContent.replaceChildren();reasoningState.textContent="生成中";status.className="status answer-modal-status";status.textContent="正在整理个人语境与完整问答链…";setAnswerModalStep("context");
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(activeAnswerTaskId===taskId){setAnswerModalStep("thinking");status.textContent=`${modelName(scene)} 正在思考…`}
  let reasoning="",answer="",renderFrame=0,answerStarted=false;
  const renderAnswer=()=>{renderFrame=0;if(activeAnswerTaskId!==taskId)return;result.innerHTML=renderMarkdown(answer);renderLatex(result);result.scrollIntoView({block:"nearest"})};
  const scheduleAnswerRender=()=>{if(!renderFrame)renderFrame=requestAnimationFrame(renderAnswer)};
  const onEvent=event=>{
    if(activeAnswerTaskId!==taskId)return;
    if(event.type==="reasoning"){const delta=event.delta||"",stickToBottom=reasoningContent.scrollHeight-reasoningContent.scrollTop-reasoningContent.clientHeight<32;reasoning+=delta;reasoningBox.hidden=false;reasoningBox.open=true;reasoningContent.append(document.createTextNode(delta));if(stickToBottom)reasoningContent.scrollTop=reasoningContent.scrollHeight;setAnswerModalStep("thinking");return}
    if(event.type==="content"){answer+=event.delta||"";if(!answerStarted){answerStarted=true;reasoningState.textContent=reasoning?"思考完成":"未返回思考过程";reasoningBox.open=false;reasoningBox.hidden=!reasoning;output.hidden=false;setAnswerModalStep("answer");status.textContent="正在生成回答…"}scheduleAnswerRender()}
  };
  try{
    const response=await requestCall(onEvent),finalAnswer=response.draft||response.content||response.answer||answer;
    if(response.reasoningContent&&!reasoning){reasoning=response.reasoningContent;reasoningContent.textContent=reasoning}
    answer=finalAnswer;if(renderFrame)cancelAnimationFrame(renderFrame);
    if(activeAnswerTaskId===taskId){renderAnswer();output.hidden=!answer;if(reasoning){reasoningContent.innerHTML=renderMarkdown(reasoning);renderLatex(reasoningContent);reasoningState.textContent="思考完成";reasoningBox.open=false}if(onDone)await onDone(response);setAnswerModalStep("done");status.textContent="回答已生成并保存。";modal.dataset.busy="false"}
    else if(onDone)await onDone(response);
    return response;
  }catch(error){
    if(activeAnswerTaskId===taskId){status.className="status answer-modal-status error";status.textContent=`未能生成：${error.message}`;modal.dataset.busy="false"}
    throw error;
  }
}
function startBackgroundChainAnswer(question){
  void runAnswerInModal({title:"为刚记录的问题生成回答",scene:"thoughtAnswer",requestCall:onEvent=>requestStream(`/api/thoughts/${question.id}/answer`,{method:"POST",body:"{}"},onEvent),onDone:()=>refreshState(["thoughts","review"],{chainId:question.id})})
    .then(()=>showToast("后台回答已生成"))
    .catch(error=>{setAnswerStatus(question.id,`自动回答未完成：${error.message}，可在卡片中重试。`,"error");showToast("思考已保存，自动回答可稍后重试","error")});
}
function switchView(name){
  const section=viewSections[name]||"today",sectionNav=$("#section-nav");
  $$(".view").forEach(view=>view.classList.toggle("active",view.id===`view-${name}`));
  $$(".nav-button").forEach(button=>{const active=button.dataset.section===section;button.classList.toggle("active",active);button.setAttribute("aria-current",active?"page":"false")});
  sectionNav.hidden=false;
  $$("[data-section-links]").forEach(group=>group.hidden=group.dataset.sectionLinks!==section);
  $$(".section-nav button").forEach(button=>{const active=button.dataset.view===name;button.classList.toggle("active",active);button.setAttribute("aria-current",active?"page":"false")});
  if(name==="captures")requestAnimationFrame(syncCaptureOverflow);
  if(name==="quotes")requestAnimationFrame(()=>{syncQuoteOverflow();setupQuoteBubbleScroll()});else stopQuoteBubbleScroll();
  if(name==="statistics")void loadStatistics();
  window.scrollTo({top:0,behavior:"smooth"});
}
function openChainEditor(id){const chain=thoughtChains().find(x=>x.question.id===id);if(!chain)return;$("#edit-chain-id").value=id;$("#edit-chain-datetime").value=toLocalDateTimeInput(eventTimestamp(chain.question));$("#edit-chain-question").value=chain.question.content;$("#edit-chain-idea").value=chain.children.filter(x=>x.type==="idea").map(x=>x.content).join("\n\n");$("#edit-chain-answer").value=chain.children.filter(x=>x.type==="answer").map(x=>x.content).join("\n\n");$("#edit-chain-tags").value=(chain.question.tags||[]).join(" ");$("#edit-chain-status").textContent="";$("#edit-chain-modal").hidden=false;$("#edit-chain-question").focus()}
function openCheckinEditor(id){
  const item=state.checkins.find(value=>value.id===id);if(!item)return;
  $("#edit-checkin-id").value=id;$("#edit-checkin-datetime").value=persistedDateTimeInput(item);$("#edit-checkin-factors").value=(item.factors||[]).join(" ");$("#edit-checkin-status").textContent="";
  $("#edit-checkin-metrics").innerHTML=Object.entries(metricConfig()).map(([key,cfg])=>{const value=Number(metricValue(item,key,cfg.custom))||3,note=item.notes?.[key]||"",options=cfg.anchors.map((anchor,index)=>`<option value="${index+1}" ${value===index+1?"selected":""}>${index+1} · ${escapeHtml(anchor)}</option>`).join("");return `<label class="edit-checkin-metric"><span>${escapeHtml(cfg.label)}</span><select data-edit-checkin-metric="${escapeHtml(key)}" data-custom="${cfg.custom?"1":"0"}">${options}</select><input data-edit-checkin-note="${escapeHtml(key)}" value="${escapeHtml(note)}" maxlength="800" placeholder="备注（可空）"></label>`}).join("");
  $("#edit-checkin-modal").hidden=false;$("#edit-checkin-factors").focus();
}

document.addEventListener("mouseup",()=>setTimeout(showSelectionCommentButton));
document.addEventListener("keyup",e=>{if(e.key.startsWith("Arrow")||e.key==="Shift")setTimeout(showSelectionCommentButton)});
for(const eventName of ["wheel","pointerdown","pointermove","touchstart","touchmove","keydown"])document.addEventListener(eventName,event=>{const viewport=event.target.closest?.(".quote-bubble p.is-auto-scrolling");if(viewport)deferQuoteBubbleScroll(viewport)},{passive:true});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&$("#view-quotes").classList.contains("active"))setupQuoteBubbleScroll()});
window.addEventListener("scroll",()=>{$("#selection-tools").hidden=true;syncBookDetailCondensed()},{passive:true});
window.addEventListener("resize",()=>requestAnimationFrame(()=>{syncCaptureOverflow();syncQuoteOverflow();setupQuoteBubbleScroll();setupBookTitlePans()}),{passive:true});
document.addEventListener("click",e=>{
  const card=e.target.closest(".capture-item");if(!card?.classList.contains("is-expandable"))return;
  const toggle=e.target.closest("[data-capture-expand]");
  if(!toggle&&e.target.closest("button,a,input,textarea,select,.comment-anchor"))return;
  if(!toggle&&!window.getSelection()?.isCollapsed)return;
  toggleCaptureCard(card);
});
document.addEventListener("click",e=>{const button=e.target.closest("[data-quote-expand]");if(!button)return;const viewport=button.closest(".quote-entry-card")?.querySelector(".quote-content-viewport");if(!viewport)return;const expanded=!viewport.classList.contains("expanded");viewport.classList.toggle("expanded",expanded);button.textContent=expanded?"收起":"展开";button.setAttribute("aria-expanded",String(expanded))});
$("#selection-tools").addEventListener("mousedown",e=>e.preventDefault());
$("#selection-tools").addEventListener("click",async e=>{const action=e.target.closest("[data-selection-action]")?.dataset.selectionAction;if(!action||!pendingSelection)return;const selection={...pendingSelection};$("#selection-tools").hidden=true;if(action==="comment"){openCommentPanel(selection.rootKey);$("#comment-text").focus();return}if(action==="quote"){openSelectionQuoteModal(selection);return}try{const annotation=await request(commentEndpoint(selection.rootKey),{method:"POST",body:JSON.stringify({...selection,kind:"highlight",text:""})}),root=commentRoot(selection.rootKey);if(root){root.annotations||=[];root.annotations.push(annotation)}clearThoughtTracePending(selection.rootKey);pendingSelection=null;window.getSelection()?.removeAllRanges();applySingleCommentAnchor(selection.rootKey,annotation);showToast("已添加浅绿色划线")}catch(err){showToast(err.message,"error")}});
$("#comment-panel-close").addEventListener("click",()=>{activeCommentRoot="";activeAnnotationId="";activeShenjiComposer="";pendingSelection=null;$("#comment-panel").hidden=true;$("#selection-tools").hidden=true;window.getSelection()?.removeAllRanges()});
$("#comment-composer").addEventListener("submit",async e=>{e.preventDefault();if(!pendingSelection)return;const button=e.currentTarget.querySelector("button"),status=$("#comment-status"),selection={...pendingSelection};button.disabled=true;status.textContent="正在保存…";try{const annotation=await request(commentEndpoint(selection.rootKey),{method:"POST",body:JSON.stringify({...selection,text:$("#comment-text").value})}),root=commentRoot(selection.rootKey);if(root){root.annotations||=[];root.annotations.push(annotation)}clearThoughtTracePending(selection.rootKey);activeAnnotationId=annotation.id;$("#comment-text").value="";pendingSelection=null;window.getSelection()?.removeAllRanges();applySingleCommentAnchor(selection.rootKey,annotation);renderCommentPanel();showToast("评论已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
document.addEventListener("click",e=>{const anchor=e.target.closest(".comment-anchor");if(!anchor)return;pendingSelection=null;openCommentPanel(anchor.dataset.commentRoot,anchor.dataset.annotationId)});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-comment-reply]");if(!form)return;e.preventDefault();const input=form.querySelector("input"),button=form.querySelector("button"),annotationId=form.dataset.commentReply;button.disabled=true;try{const reply=await request(commentEndpoint(activeCommentRoot,`/${annotationId}/replies`),{method:"POST",body:JSON.stringify({text:input.value})}),root=commentRoot(activeCommentRoot),annotation=root?.annotations?.find(item=>item.id===annotationId);if(annotation){annotation.replies||=[];annotation.replies.push(reply);activeAnnotationId=annotationId;refreshAnnotationCard(annotation)}showToast("回复已保存")}catch(err){showToast(err.message,"error");button.disabled=false}});
document.addEventListener("click",e=>{const button=e.target.closest("[data-shenji-toggle]");if(!button)return;const id=button.dataset.shenjiToggle;activeShenjiComposer=activeShenjiComposer===id?"":id;document.querySelectorAll("[data-shenji-form]").forEach(form=>form.hidden=form.dataset.shenjiForm!==activeShenjiComposer);const form=button.closest(".comment-card")?.querySelector("[data-shenji-form]");if(form&&!form.hidden)form.elements.message.focus()});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-shenji-form]");if(!form)return;e.preventDefault();const annotationId=form.dataset.shenjiForm,button=form.querySelector('button[type="submit"]'),status=form.querySelector(".shenji-status"),message=form.elements.message.value;button.disabled=true;status.textContent="神鸡正在核对原文、概念与潜在矛盾…";try{const exchange=await request(commentEndpoint(activeCommentRoot,`/${annotationId}/shenji`),{method:"POST",body:JSON.stringify({message})}),root=commentRoot(activeCommentRoot),annotation=root?.annotations?.find(item=>item.id===annotationId);if(annotation){annotation.shenji||=[];annotation.shenji.push(exchange);activeAnnotationId=annotationId;activeShenjiComposer=annotationId;refreshAnnotationCard(annotation)}showToast("神鸡已回答")}catch(err){status.textContent=`未能回答：${err.message}`;button.disabled=false}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-comment-delete]");if(!button)return;const annotationId=button.dataset.commentDelete,root=commentRoot(activeCommentRoot),annotation=root?.annotations?.find(item=>item.id===annotationId),label=annotation?.kind==="highlight"?"划线":"评论";if(!confirm(`删除这条${label}${annotation?.shenji?.length?"及其神鸡对话":""}？`))return;try{await request(commentEndpoint(activeCommentRoot,`/${annotationId}`),{method:"DELETE"});if(root)root.annotations=(root.annotations||[]).filter(item=>item.id!==annotationId);removeCommentAnchors(annotationId);button.closest(".comment-card")?.remove();activeAnnotationId="";if(activeShenjiComposer===annotationId)activeShenjiComposer="";if(!$("#comment-panel-list").querySelector(".comment-card"))renderCommentPanel();showToast(`${label}已删除`)}catch(err){showToast(err.message,"error")}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-drift-delete]");if(!button)return;const driftId=button.dataset.driftDelete;if(!confirm("删除这条漂流批注及其评论记录？"))return;try{await request(commentEndpoint(activeCommentRoot,`/drift/${driftId}`),{method:"DELETE"});const root=commentRoot(activeCommentRoot);if(root)root.annotationDrift=(root.annotationDrift||[]).filter(item=>item.id!==driftId);renderCommentPanel();showToast("漂流批注已删除")}catch(err){showToast(err.message,"error")}});

document.addEventListener("submit",async e=>{const form=e.target.closest("[data-follow-up-root]");if(!form)return;e.preventDefault();const button=form.querySelector('button[type="submit"]'),status=form.querySelector(".followup-status"),rootId=form.dataset.followUpRoot;button.disabled=true;status.textContent="正在保存追问…";try{const saved=await request(`/api/thoughts/${rootId}/follow-ups`,{method:"POST",body:JSON.stringify({question:form.elements.question.value,answer:form.elements.answer.value})});await refreshState(["thoughts","review"],{chainId:rootId,followUpId:saved.id});showToast(form.elements.answer.value.trim()?"追问与回答已保存":"追问已保存")}catch(err){status.textContent=err.message;button.disabled=false}});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-followup-manual-answer]");if(!form)return;e.preventDefault();const button=form.querySelector('button[type="submit"]'),status=form.closest(".followup-answer")?.querySelector(".followup-status"),rootId=form.dataset.rootId,followUpId=form.dataset.followupManualAnswer;button.disabled=true;if(status)status.textContent="正在保存回答…";try{await request(`/api/thoughts/${rootId}/follow-ups/${followUpId}`,{method:"PATCH",body:JSON.stringify({answer:form.querySelector("textarea").value})});await refreshState("thoughts",{chainId:rootId,followUpId});showToast("追问回答已保存")}catch(err){if(status)status.textContent=err.message;button.disabled=false}});
document.addEventListener("submit",async e=>{const form=e.target.closest("[data-followup-edit]");if(!form)return;e.preventDefault();const button=form.querySelector('button[type="submit"]'),rootId=form.dataset.rootId,followUpId=form.dataset.followupEdit;button.disabled=true;try{await request(`/api/thoughts/${rootId}/follow-ups/${followUpId}`,{method:"PATCH",body:JSON.stringify({question:form.elements.question.value,answer:form.elements.answer.value})});await refreshState("thoughts",{chainId:rootId,followUpId});showToast("追问已更新")}catch(err){showToast(err.message,"error");button.disabled=false}});
document.addEventListener("click",e=>{const toggle=e.target.closest("[data-followup-edit-toggle]"),cancel=e.target.closest("[data-followup-edit-cancel]");if(!toggle&&!cancel)return;const id=(toggle||cancel).dataset.followupEditToggle||(toggle||cancel).dataset.followupEditCancel,form=document.querySelector(`[data-followup-edit="${CSS.escape(id)}"]`);if(form){form.hidden=cancel?true:!form.hidden;if(!form.hidden)form.elements.question.focus()}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-followup-delete]");if(!button)return;if(!confirm("删除这条追问及其回答？此操作无法撤销。"))return;button.disabled=true;try{await request(`/api/thoughts/${button.dataset.rootId}/follow-ups/${button.dataset.followupDelete}`,{method:"DELETE"});await refreshState("thoughts",{chainId:button.dataset.rootId});showToast("追问已删除")}catch(err){showToast(err.message,"error");button.disabled=false}});
document.addEventListener("click",async e=>{const button=e.target.closest("[data-followup-answer]");if(!button)return;const rootId=button.dataset.rootId,followUpId=button.dataset.followupAnswer;button.disabled=true;try{await runAnswerInModal({title:"回答这条追问",scene:"followUpAnswer",requestCall:onEvent=>requestStream(`/api/thoughts/${rootId}/follow-ups/${followUpId}/answer`,{method:"POST",body:"{}"},onEvent),onDone:()=>refreshState("thoughts",{chainId:rootId,followUpId})});showToast("追问回答已生成")}catch(err){showToast(err.message,"error")}finally{button.disabled=false}});

document.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;if(b.dataset.view)return switchView(b.dataset.view);if(b.dataset.go)return switchView(b.dataset.go);if(b.dataset.openComments)return openCommentPanel(commentRootKey("thought",b.dataset.openComments));if(b.dataset.followupCompose){const form=b.closest(".chain-record")?.querySelector(`[data-follow-up-root="${CSS.escape(b.dataset.followupCompose)}"]`);if(!form)return;form.hidden=!form.hidden;b.setAttribute("aria-expanded",String(!form.hidden));if(!form.hidden){form.elements.question.focus();form.scrollIntoView({block:"nearest",behavior:"smooth"})}return}if(b.dataset.removeDraftTag!=null){draftTags=draftTags.filter(tag=>tag!==b.dataset.removeDraftTag);return renderTagComposer()}if(b.dataset.removeCaptureTag!=null){captureDraftTags=captureDraftTags.filter(tag=>tag!==b.dataset.removeCaptureTag);return renderCaptureTagComposer()}if(b.dataset.tagFilter!=null){thoughtFilter=b.dataset.tagFilter;return renderThoughts()}if(b.dataset.editChain)return openChainEditor(b.dataset.editChain);if(b.dataset.answerChain){const id=b.dataset.answerChain;b.disabled=true;try{await runAnswerInModal({title:"回答这个问题",scene:"thoughtAnswer",requestCall:onEvent=>requestStream(`/api/thoughts/${id}/answer`,{method:"POST",body:"{}"},onEvent),onDone:()=>refreshState(["thoughts","review"],{chainId:id})});showToast("回答已生成，可继续编辑")}catch(err){showToast(err.message,"error")}finally{b.disabled=false}return}if(b.dataset.remark){const text=prompt("新增一条备注：");if(text?.trim()){await request(`/api/thoughts/${b.dataset.remark}/remarks`,{method:"POST",body:JSON.stringify({text})});await refreshState("thoughts",{chainId:b.dataset.remark});showToast("备注已保存")}return}if(b.dataset.editRemark){const item=state.thoughts.find(x=>x.id===b.dataset.thoughtId),remark=item?.remarks?.find(x=>x.id===b.dataset.editRemark);if(!remark)return;const text=prompt("编辑备注：",remark.text);if(text?.trim()){await request(`/api/thoughts/${b.dataset.thoughtId}/remarks/${b.dataset.editRemark}`,{method:"PATCH",body:JSON.stringify({text})});await refreshState("thoughts",{chainId:b.dataset.thoughtId});showToast("备注已更新")}return}if(b.dataset.deleteRemark){if(!confirm("删除这条备注？"))return;await request(`/api/thoughts/${b.dataset.thoughtId}/remarks/${b.dataset.deleteRemark}`,{method:"DELETE"});await refreshState("thoughts",{chainId:b.dataset.thoughtId});showToast("备注已删除");return}if(b.dataset.disposition){await request(`/api/thoughts/${b.dataset.disposition}/disposition`,{method:"PATCH",body:JSON.stringify({disposition:b.dataset.value})});await refreshState(["thoughts","review"],{chainId:b.dataset.disposition});showToast(b.dataset.value==="kept"?"已保留":"已舍弃");return}if(b.dataset.deleteChain){if(!confirm("删除整套“问题—初步想法—回答”？此操作无法撤销。"))return;b.disabled=true;try{await request(`/api/thought-chains/${b.dataset.deleteChain}`,{method:"DELETE"});await refreshState(["thoughts","review"]);showToast("整套思考已删除")}catch(err){showToast(err.message,"error");b.disabled=false}}});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  if(button.dataset.journalPrompt){const editor=$("#journal-content"),prompt=button.dataset.journalPrompt,prefix=editor.value.trim()?"\n\n":"";editor.setRangeText(`${prefix}${prompt}\n`,editor.selectionStart,editor.selectionEnd,"end");editor.focus();return}
  if(button.dataset.journalAssist){
    const mode=button.dataset.journalAssist,editor=$("#journal-content"),status=$("#journal-assist-status"),buttons=$$("[data-journal-assist]"),labels={lead:"引子",structure:"结构",topic:"话题"};
    buttons.forEach(item=>item.disabled=true);status.textContent=`正在生成${labels[mode]}…`;
    try{
      let streamed="";
      const result=await requestStream("/api/journals/assist",{method:"POST",body:JSON.stringify({mode,occurredAt:$("#journal-date").value,title:$("#journal-title").value,content:editor.value})},event=>{if(event.type==="content"){streamed+=event.delta||"";status.textContent=`正在生成${labels[mode]}… ${streamed.length} 字`}});
      const addition=(result.content||streamed).trim();
      if(addition){editor.value+=`${editor.value.trim()?"\n\n":""}${addition}`;editor.selectionStart=editor.selectionEnd=editor.value.length;editor.focus();status.textContent=`${labels[mode]}已追加到正文末尾。`;showToast(`${labels[mode]}已追加`)}
    }catch(err){status.textContent=`生成失败：${err.message}`}finally{buttons.forEach(item=>item.disabled=false)}
    return;
  }
  if(button.dataset.captureEdit)return editCapture(button.dataset.captureEdit);
  if(button.dataset.journalEdit)return editJournal(button.dataset.journalEdit);
  if(button.dataset.editCheckin)return openCheckinEditor(button.dataset.editCheckin);
  if(button.dataset.capturePromote){const item=(state.captures||[]).find(value=>value.id===button.dataset.capturePromote);if(!item)return;activeDate=eventDate(item)||activeDate;renderDate();renderSliders();renderThoughts();renderStateChart();renderChat();$("#chain-question").value="";$("#chain-idea").value=item.content;draftTags=[...(item.tags||[])];renderTagComposer();$("#chain-status").textContent="捕念已放入初步想法。补上一个明确问题，再形成完整思考。";switchView("today");$("#chain-form").scrollIntoView({behavior:"smooth",block:"start"});$("#chain-question").focus();return}
  if(button.dataset.captureDelete){if(!confirm("删除这条捕念？"))return;button.disabled=true;try{await request(`/api/captures/${button.dataset.captureDelete}`,{method:"DELETE"});await refreshState("captures");showToast("捕念已删除")}catch(err){showToast(err.message,"error");button.disabled=false}return}
  if(button.dataset.journalDelete){if(!confirm("删除这篇日记及其助手回望？"))return;button.disabled=true;try{await request(`/api/journals/${button.dataset.journalDelete}`,{method:"DELETE"});await refreshState("journals");showToast("日记已删除")}catch(err){showToast(err.message,"error");button.disabled=false}return}
  if(button.dataset.journalReflect){const id=button.dataset.journalReflect;button.disabled=true;try{await runAnswerInModal({title:"回望这篇日记",scene:"diaryReflection",requestCall:onEvent=>requestStream(`/api/journals/${id}/reflect`,{method:"POST",body:"{}"},onEvent),onDone:()=>refreshState("journals")});showToast("日记回望已保存")}catch(err){showToast(err.message,"error")}finally{button.disabled=false}}
});
$$("[data-active-date]").forEach(input=>input.addEventListener("change",e=>{activeDate=e.target.value||activeDate;renderDate();renderSliders();renderDailyRecords();renderThoughts();renderStateChart();renderChat()}));$("#chart-range").addEventListener("change",renderStateChart);
$$("[data-daily-tab]").forEach(button=>button.addEventListener("click",()=>switchDailyType(button.dataset.dailyTab)));
$("#health-images").addEventListener("change",e=>{if(!setHealthImages(e.currentTarget.files,"本地文件"))e.currentTarget.value=""});
$("#health-upload-box").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#health-images").click()}});
$("#health-upload-box").addEventListener("dragenter",e=>{e.preventDefault();e.currentTarget.classList.add("dragging")});
$("#health-upload-box").addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
$("#health-upload-box").addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
$("#health-upload-box").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const files=[...(e.dataTransfer?.files||[])].filter(item=>item.type.startsWith("image/"));setHealthImages(files,"拖入图片",activeDailyType==="sleep")});
document.addEventListener("paste",e=>{if(!$("#view-daily").classList.contains("active")||!["sleep","heartRate"].includes(activeDailyType)||(e.target instanceof Element&&e.target.closest("input,textarea,[contenteditable=true]")))return;const files=[...(e.clipboardData?.files||[])].filter(item=>item.type.startsWith("image/"));if(!files.length)return;e.preventDefault();setHealthImages(files,"剪贴板",activeDailyType==="sleep")});
document.addEventListener("click",e=>{const button=e.target.closest("[data-health-image-remove]");if(!button)return;healthFiles[activeDailyType].splice(Number(button.dataset.healthImageRemove),1);renderHealthUploader();$("#health-parse-status").textContent=healthFiles[activeDailyType].length?`已保留 ${healthFiles[activeDailyType].length} 张图片。`:"请重新选择或粘贴截图。"});
$("#parse-health-images").addEventListener("click",async e=>{
  const button=e.currentTarget,files=healthFiles[activeDailyType]||[],status=$("#health-parse-status");if(!files.length)return status.textContent="请先选择、粘贴或拖入截图。";
  button.disabled=true;status.textContent=`${modelName("healthRecognition")} 正在识别并核对字段…`;
  try{
    const result=await request("/api/images/parse",{method:"POST",body:JSON.stringify({kind:activeDailyType,referenceDate:activeDate,images:await imageDataUrls(files)})}),form=dailyForm();
    for(const [key,value]of Object.entries(result)){if(["attachmentPaths","verification","date"].includes(key)||!form.elements[key])continue;form.elements[key].value=Array.isArray(value)?JSON.stringify(value):value??""}
    form.elements.attachmentPaths.value=JSON.stringify(result.attachmentPaths||[]);form.elements.occurredAt.value=result.wakeTime||localDateTimeForDate(result.date||activeDate);
    status.textContent=result.verification||"识别完成。请核对后保存，空白字段可以手动补充。";showToast("截图已识别并回填");
  }catch(err){status.textContent=err.message}finally{button.disabled=false}
});
$$("[data-daily-form]").forEach(form=>form.addEventListener("submit",async e=>{
  e.preventDefault();const current=e.currentTarget,type=current.dataset.dailyForm,id=current.elements.recordId.value,button=current.querySelector('[type="submit"]'),status=current.querySelector(".status"),payload=Object.fromEntries(new FormData(current).entries());
  delete payload.recordId;payload.type=type;payload.attachmentPaths=payload.attachmentPaths?JSON.parse(payload.attachmentPaths):[];payload.source=payload.attachmentPaths.length?"screenshot":"manual";if(payload.trendSegments){try{payload.trendSegments=JSON.parse(payload.trendSegments)}catch{payload.trendSegments=[]}}
  dailyNumericFields.forEach(key=>{if(Object.hasOwn(payload,key))payload[key]=payload[key]===""?null:Number(payload[key])});
  button.disabled=true;status.textContent=id?"正在保存修改…":"正在保存…";
  try{await request(id?`/api/daily-records/${id}`:"/api/daily-records",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetDailyForm(type);if(["sleep","heartRate"].includes(type))resetHealthImages();await refreshState("dailyRecords");showToast(id?"日录已更新":`${dailyTypeMeta[type].label}已记录`)}
  catch(err){status.textContent=err.message}finally{button.disabled=false}
}));
$$("[data-daily-cancel]").forEach(button=>button.addEventListener("click",()=>resetDailyForm(button.closest("[data-daily-form]").dataset.dailyForm)));
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-daily-edit],[data-daily-delete]");if(!button)return;
  if(button.dataset.dailyEdit)return editDailyRecord(button.dataset.dailyEdit);
  if(!confirm("删除这条日录？"))return;button.disabled=true;
  try{await request(`/api/daily-records/${button.dataset.dailyDelete}`,{method:"DELETE"});await refreshState("dailyRecords");showToast("日录已删除")}catch(err){showToast(err.message,"error");button.disabled=false}
});
$("#chain-tags").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===","||e.key==="，"){e.preventDefault();commitDraftTags()}});$("#chain-tags").addEventListener("blur",()=>{if($("#chain-tags").value.trim())commitDraftTags()});
$("#capture-tags").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===","||e.key==="，"){e.preventDefault();commitCaptureTags()}});$("#capture-tags").addEventListener("blur",()=>{if($("#capture-tags").value.trim())commitCaptureTags()});
$("#capture-cancel").addEventListener("click",resetCaptureForm);
$("#journal-cancel").addEventListener("click",resetJournalForm);
$("#capture-content").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();$("#capture-form").requestSubmit()}});
$("#capture-form").addEventListener("submit",async e=>{e.preventDefault();if($("#capture-tags").value.trim())commitCaptureTags();const id=$("#capture-id").value,button=$("#capture-submit"),status=$("#capture-status"),payload={occurredAt:$("#capture-date").value,content:$("#capture-content").value,tags:captureDraftTags};button.disabled=true;status.textContent=id?"正在保存修改…":"正在收下…";try{await request(id?`/api/captures/${id}`:"/api/captures",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetCaptureForm();await refreshState("captures");showToast(id?"捕念已更新":"已收进捕念")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
$("#journal-draft-save").addEventListener("click",async e=>{const button=e.currentTarget,status=$("#journal-status");button.disabled=true;button.textContent="正在保存…";status.textContent="正在保存草稿…";try{const draft=await request("/api/journal-draft",{method:"PUT",body:JSON.stringify({journalId:$("#journal-id").value,title:$("#journal-title").value,content:$("#journal-content").value})});state.journalDraft=draft;status.textContent=`草稿已保存于 ${formatTime(draft.updatedAt)}。`;showToast("日记草稿已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false;button.textContent="保存草稿"}});
$("#journal-form").addEventListener("submit",async e=>{e.preventDefault();const id=$("#journal-id").value,button=$("#journal-submit"),status=$("#journal-status"),payload={occurredAt:$("#journal-date").value,title:$("#journal-title").value,content:$("#journal-content").value,tags:splitTags($("#journal-tags").value)};button.disabled=true;status.textContent=id?"正在保存修改…":"正在保存原文…";try{await request(id?`/api/journals/${id}`:"/api/journals",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetJournalForm();await refreshState("journals");showToast(id?"日记已更新":"日记已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
$("#checkin-form").addEventListener("submit",async e=>{e.preventDefault();const b=e.currentTarget.querySelector('[type="submit"]'),missing=$$('[data-metric]').filter(x=>x.dataset.confirmed!=="true");if(missing.length){$("#checkin-status").textContent=`请先确认：${missing.map(x=>metricConfig()[x.dataset.metric].label).join("、")}`;missing[0].focus();return}b.disabled=true;b.textContent="正在保存…";const payload={occurredAt:localDateTimeForDate(activeDate),notes:{},custom:{},factors:splitTags($("#checkin-factors").value)};$$('[data-metric]').forEach(x=>{const k=x.dataset.metric;if(x.dataset.custom==="1")payload.custom[k]=Number(x.value);else payload[k]=Number(x.value);payload.notes[k]=$(`#${CSS.escape(k)}-note`)?.value||""});try{await request("/api/checkins",{method:"POST",body:JSON.stringify(payload)});await refreshState(["checkins","review"]);$("#checkin-status").textContent="已记下。这只是此刻，不是对整天的评分。";showToast("此刻状态已保存")}catch(err){$("#checkin-status").textContent=err.message}finally{b.disabled=false;b.textContent="记下此刻"}});
$("#thought-prompt-button").addEventListener("click",async e=>{
  const button=e.currentTarget,question=$("#chain-question"),status=$("#thought-prompt-status"),selectedDate=activeDate,owner=currentUser?.id;
  if(question.value.trim()){status.textContent="问题框已有内容，清空后再生成新的引子。";question.focus();return}
  let changed=false;const markChanged=()=>{changed=true};question.addEventListener("input",markChanged);$("#chain-form").addEventListener("reset",markChanged);
  button.disabled=true;button.textContent="正在想…";status.textContent=`${modelName("thoughtPrompt")} 正在找一个可以接住的开头…`;
  try{
    const result=await request("/api/thought-prompts",{method:"POST",body:JSON.stringify({occurredAt:localDateTimeForDate(selectedDate)})});
    if(changed||question.value.trim()||activeDate!==selectedDate||currentUser?.id!==owner){status.textContent="引子已生成；当前输入已变化，请继续你的思考。";return}
    question.value=result.prompt||"";question.focus();question.setSelectionRange(question.value.length,question.value.length);
    status.textContent=result.hasHistory?"从之前的记录接了一步；它只是引子，可以随手改。":"先抛来一个轻巧的问题；它只是引子，可以随手改。";
  }catch(err){status.textContent=`生成失败：${err.message}`}
  finally{question.removeEventListener("input",markChanged);$("#chain-form").removeEventListener("reset",markChanged);button.disabled=false;button.textContent="✦ 给个引子"}
});
$("#draft-answer-button").addEventListener("click",async e=>{const button=e.currentTarget,q=$("#chain-question").value.trim();if(!q){$("#chain-status").textContent="先写下问题，我才能结合你的记录回答。";$("#chain-question").focus();return}button.disabled=true;try{await runAnswerInModal({title:"生成可编辑回答草稿",scene:"thoughtDraft",requestCall:onEvent=>requestStream("/api/answer-drafts",{method:"POST",body:JSON.stringify({question:q,idea:$("#chain-idea").value})},onEvent),onDone:r=>{answerDraft=r.draft;answerReasoningDraft=r.reasoningContent||"";$("#chain-answer").value=r.draft;$("#chain-status").textContent="草稿已填入回答框。请按你的判断修改，再提交整套思考。"}});showToast("回答草稿已生成，可直接修改")}catch(err){$("#chain-status").textContent=err.message}finally{button.disabled=false}});
$("#chain-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,b=form.querySelector('[type="submit"]');if(b.disabled)return;if($("#chain-tags").value.trim())commitDraftTags();const id=form.dataset.requestId||crypto.randomUUID(),answer=$("#chain-answer").value,needsAnswer=!answer.trim();form.dataset.requestId=id;b.disabled=true;b.textContent="正在保存…";$("#chain-status").textContent="正在保存整套思考…";try{const result=await request("/api/thought-chains",{method:"POST",body:JSON.stringify({clientRequestId:id,occurredAt:localDateTimeForDate(activeDate),question:$("#chain-question").value,idea:$("#chain-idea").value,answer,modelDraft:answerDraft,modelReasoning:answerReasoningDraft,tags:draftTags})}),question=result.items.find(item=>item.type==="question");form.reset();draftTags=[];renderTagComposer();answerDraft="";answerReasoningDraft="";delete form.dataset.requestId;b.disabled=false;b.textContent="收进思绪箱";$("#chain-status").textContent=needsAnswer?"思考已保存，回答正在后台生成。":"已保存为一套完整思考。";void refreshState(["thoughts","review"],{chainId:question?.id}).catch(error=>showToast(`记录已保存，但页面刷新失败：${error.message}`,"error"));if(needsAnswer&&question)startBackgroundChainAnswer(question);showToast(needsAnswer?"思考已保存，可继续记录":"整套思考已保存，不会重复记录")}catch(err){$("#chain-status").textContent=err.message}finally{b.disabled=false;b.textContent="收进思绪箱"}});
$("#chat-form").addEventListener("submit",async e=>{e.preventDefault();const b=e.currentTarget.querySelector("button");b.disabled=true;$("#chat-status").textContent=`${modelName("chat")} 正在结合你的长期记录…`;try{await request("/api/chat",{method:"POST",body:JSON.stringify({occurredAt:localDateTimeForDate(activeDate),message:$("#chat-input").value})});$("#chat-input").value="";await refreshState("chat");$("#chat-status").textContent=""}catch(err){$("#chat-status").textContent=err.message}finally{b.disabled=false}});
$("#edit-chain-form").addEventListener("submit",async e=>{e.preventDefault();const b=e.currentTarget.querySelector('[type="submit"]'),id=$("#edit-chain-id").value;b.disabled=true;$("#edit-chain-status").textContent="正在保存…";try{await request(`/api/thought-chains/${id}`,{method:"PATCH",body:JSON.stringify({occurredAt:$("#edit-chain-datetime").value,question:$("#edit-chain-question").value,idea:$("#edit-chain-idea").value,answer:$("#edit-chain-answer").value,tags:splitTags($("#edit-chain-tags").value)})});$("#edit-chain-modal").hidden=true;await refreshState(["thoughts","review"],{chainId:id});showToast("整套思考已更新")}catch(err){$("#edit-chain-status").textContent=err.message}finally{b.disabled=false}});
$("#edit-checkin-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),id=$("#edit-checkin-id").value,payload={occurredAt:$("#edit-checkin-datetime").value,factors:splitTags($("#edit-checkin-factors").value),custom:{},notes:{}};$$("[data-edit-checkin-metric]").forEach(input=>{const key=input.dataset.editCheckinMetric;if(input.dataset.custom==="1")payload.custom[key]=Number(input.value);else payload[key]=Number(input.value);payload.notes[key]=$(`[data-edit-checkin-note="${CSS.escape(key)}"]`)?.value||""});button.disabled=true;$("#edit-checkin-status").textContent="正在保存修改…";try{await request(`/api/checkins/${id}`,{method:"PATCH",body:JSON.stringify(payload)});$("#edit-checkin-modal").hidden=true;await refreshState(["checkins","review"]);showToast("此刻状态已更新")}catch(err){$("#edit-checkin-status").textContent=err.message}finally{button.disabled=false}});
$("#edit-chain-modal .modal-close").addEventListener("click",()=>$("#edit-chain-modal").hidden=true);$("#edit-chain-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.hidden=true});
$("#edit-checkin-modal .modal-close").addEventListener("click",()=>$("#edit-checkin-modal").hidden=true);$("#edit-checkin-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.hidden=true});
$("#ai-answer-close").addEventListener("click",closeAnswerModal);$("#ai-answer-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeAnswerModal()});
document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;if(!$("#edit-checkin-modal").hidden)return $("#edit-checkin-modal").hidden=true;if(!$("#association-flow-modal").hidden)return setAssociationFlowOpen(false);if(!$("#ai-answer-modal").hidden)closeAnswerModal()});
$("#association-flow-toggle").addEventListener("click",()=>setAssociationFlowOpen(true));
$("#association-flow-close").addEventListener("click",()=>setAssociationFlowOpen(false));
$("#association-flow-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)setAssociationFlowOpen(false)});
$("#run-analysis").addEventListener("click",async e=>{const button=e.currentTarget;button.disabled=true;$("#analysis-status").textContent="正在比较模型草稿与你最终保留的回答，以及你保留、舍弃和长期缺席的主题…";try{await request("/api/analysis/run",{method:"POST",body:"{}"});await refreshState("review");$("#analysis-status").textContent="";showToast("认知复盘已生成")}catch(err){$("#analysis-status").textContent=err.message}finally{button.disabled=false}});
$("#experiment-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;await request("/api/experiments",{method:"POST",body:JSON.stringify({hypothesis:$("#experiment-hypothesis").value,factor:$("#experiment-factor").value,outcome:$("#experiment-outcome").value,duration:$("#experiment-duration").value})});form.reset();await refreshState("review");showToast("个人实验已开始")});
$("#metric-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;await request("/api/custom-metrics",{method:"POST",body:JSON.stringify({name:$("#metric-name").value,low:$("#metric-low").value,high:$("#metric-high").value})});form.reset();await refreshState(["review","checkins"])});
for(const role of ["cover","recognition"]){
  const ui=bookImageUi[role],input=$(ui.input),box=$(ui.box);
  input.addEventListener("change",e=>{const file=e.currentTarget.files?.[0];bookImagePasteTarget=role;if(file&&!setBookImage(role,file,"本地文件"))e.currentTarget.value=""});
  box.addEventListener("focusin",()=>bookImagePasteTarget=role);
  box.addEventListener("pointerdown",()=>bookImagePasteTarget=role);
  box.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();input.click()}});
  box.addEventListener("dragenter",e=>{e.preventDefault();bookImagePasteTarget=role;e.currentTarget.classList.add("dragging")});
  box.addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
  box.addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
  box.addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const file=[...(e.dataTransfer?.files||[])].find(item=>item.type.startsWith("image/"));if(!file)return $("#book-parse-status").textContent="拖入的内容里没有可用图片。";setBookImage(role,file,"拖入图片")});
}
$("#book-cover-remove").addEventListener("click",()=>{$("#book-image-path").value="";resetBookImage("cover");$("#book-parse-status").textContent="封面已移除，保存后生效。"});
$("#book-recognition-remove").addEventListener("click",()=>{resetBookImage("recognition");$("#book-parse-status").textContent=""});
$("#book-image-swap").addEventListener("click",async e=>{
  const button=e.currentTarget,recognitionFile=pendingBookImages.recognition;
  if(!recognitionFile)return;
  button.disabled=true;
  try{
    const coverFile=await currentBookCoverFile();
    if(!coverFile)return;
    $("#book-image-path").value="";
    setBookImage("cover",recognitionFile,"交换后作为封面");
    setBookImage("recognition",coverFile,"交换后用于识别");
    bookImagePasteTarget="recognition";
    $("#book-parse-status").textContent="封面与识别图已交换。";
  }catch(error){$("#book-parse-status").textContent=error.message}
  finally{updateBookImageSwapButton()}
});
$("#book-create-toggle").addEventListener("click",()=>{if(bookCreatorOpen){bookCreatorOpen=false;resetBookForm()}else{resetBookForm();bookCreatorOpen=true}renderBooks();if(bookCreatorOpen)$("#book-create-panel").scrollIntoView({behavior:"smooth",block:"start"})});
$("#book-edit-cancel").addEventListener("click",()=>{const bookId=editingBookId;resetBookForm();bookCreatorOpen=false;activeBookId=bookId;activeBookFeatureNoteId="";bookDetailCondensed=false;window.scrollTo({top:0,behavior:"auto"});renderBooks()});
$("#book-reading-start").addEventListener("input",syncBookReadingDates);
$("#book-reading-end").addEventListener("input",syncBookReadingDates);
document.addEventListener("paste",e=>{if(!$("#view-books").classList.contains("active")||$("#book-create-panel").hidden||(e.target instanceof Element&&e.target.closest('input:not([type="file"]),textarea,[contenteditable=true]')))return;const file=[...(e.clipboardData?.files||[])].find(item=>item.type.startsWith("image/"));if(!file)return;e.preventDefault();setBookImage(bookImagePasteTarget,file,"剪贴板")});
$("#parse-book").addEventListener("click",async e=>{const button=e.currentTarget,file=pendingBookImages.recognition||$("#book-recognition-image").files?.[0];if(!file)return $("#book-parse-status").textContent="请先选择、粘贴或拖入一张识别图。";button.disabled=true;$("#book-parse-status").textContent="正在识别并查询书目…";try{const result=await request("/api/images/parse",{method:"POST",body:JSON.stringify({kind:"book",images:await imageDataUrls([file])})});for(const k of["title","author","publisher","isbn","description"])$(`#book-${k}`).value=result[k]||"";$("#book-parse-status").textContent=result.verification||"识别完成，请确认书目信息。"}catch(err){$("#book-parse-status").textContent=err.message}finally{button.disabled=false}});
$("#book-form").addEventListener("submit",async e=>{
  e.preventDefault();const button=$("#book-submit"),bookId=editingBookId;button.disabled=true;
  try{
    let imagePath=$("#book-image-path").value;
    if(pendingBookImages.cover){$("#book-parse-status").textContent="正在上传封面…";const [image]=await imageDataUrls([pendingBookImages.cover]),uploaded=await request("/api/images/upload",{method:"POST",body:JSON.stringify({image})});imagePath=uploaded.attachmentPath}
    const payload={title:$("#book-title").value,author:$("#book-author").value,publisher:$("#book-publisher").value,isbn:$("#book-isbn").value,readingStartedOn:$("#book-reading-start").value,readingFinishedOn:$("#book-reading-end").value,description:$("#book-description").value,imagePath};
    await request(bookId?`/api/books/${bookId}`:"/api/books",{method:bookId?"PATCH":"POST",body:JSON.stringify(payload)});
    resetBookForm();bookCreatorOpen=false;activeBookId=bookId||"";await refreshState("books");showToast(bookId?"书目信息已更新":"书目已加入书架");
  }catch(err){$("#book-parse-status").textContent=err.message}finally{button.disabled=false}
});
document.addEventListener("submit",async e=>{
  const form=e.target.closest("[data-book-entry-form]");if(!form)return;e.preventDefault();
  const bookId=form.dataset.bookEntryForm,noteId=form.elements.noteId.value,button=form.querySelector('[type="submit"]'),status=form.querySelector(".status"),payload={occurredAt:form.elements.occurredAt.value,type:form.elements.type.value,favorite:form.elements.favorite.value,content:form.elements.content.value};
  button.disabled=true;status.textContent=noteId?"正在保存修改…":"正在写入时间线…";
  try{await request(noteId?`/api/books/${bookId}/notes/${noteId}`:`/api/books/${bookId}/notes`,{method:noteId?"PATCH":"POST",body:JSON.stringify(payload)});pendingBookNoteId=noteId;await refreshState("books");showToast(noteId?"读书记录已更新":"读书记录已保存")}
  catch(err){status.textContent=err.message;button.disabled=false}
});
document.addEventListener("click",async e=>{
  const button=e.target.closest("button");if(!button)return;
  const openId=button.dataset.openBook||button.dataset.bookMemory;
  if(openId){window.scrollTo({top:0,behavior:"auto"});activeBookId=openId;activeBookFeatureNoteId="";bookDetailCondensed=false;pendingBookNoteId=button.dataset.bookNote||"";bookCreatorOpen=false;renderBooks();return}
  if(button.dataset.bookBack!=null){activeBookId="";activeBookFeatureNoteId="";pendingBookNoteId="";setBookDetailCondensed(false);renderBooks();window.scrollTo({top:0,behavior:"smooth"});return}
  if(button.dataset.bookAddNote!=null){$("#book-detail [data-book-entry-form]")?.scrollIntoView({behavior:"smooth",block:"center"});return}
  if(button.dataset.bookFeatureNote){document.querySelector(`#book-note-${CSS.escape(button.dataset.bookFeatureNote)}`)?.scrollIntoView({behavior:"smooth",block:"center"});return}
  if(button.dataset.bookEntryCancel!=null){renderBooks();return}
  if(button.dataset.bookEdit){const editBook=state.books.find(item=>item.id===button.dataset.bookEdit);if(editBook)openBookEditor(editBook);return}
  const book=state.books.find(item=>item.id===activeBookId);
  if(!book)return;
  if(button.dataset.bookNoteEdit){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteEdit),form=$("#book-detail [data-book-entry-form]");if(!note||!form)return;
    form.elements.noteId.value=note.id;form.elements.type.value=note.type||"record";form.elements.favorite.value=note.favorite||"none";form.elements.occurredAt.value=toLocalDateTimeInput(eventTimestamp(note));form.elements.content.value=note.content;form.querySelector("[data-book-entry-heading]").textContent="编辑记录";form.querySelector("[data-book-entry-cancel]").hidden=false;form.querySelector('[type="submit"]').textContent="保存修改";form.scrollIntoView({behavior:"smooth",block:"center"});form.elements.content.focus();return;
  }
  if(button.dataset.bookNoteFavorite){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteFavorite);if(!note)return;
    button.disabled=true;try{await request(`/api/books/${book.id}/notes/${note.id}`,{method:"PATCH",body:JSON.stringify({occurredAt:eventTimestamp(note),type:note.type,content:note.content,favorite:button.dataset.nextFavorite})});pendingBookNoteId=note.id;await refreshState("books");showToast(button.dataset.nextFavorite==="star"?"已标为星标":button.dataset.nextFavorite==="sprout"?"已标为萌芽":"已取消收藏")}catch(err){showToast(err.message,"error");button.disabled=false}return;
  }
  if(button.dataset.bookNoteDelete){
    const note=(book.notes||[]).find(item=>item.id===button.dataset.bookNoteDelete);if(!note||!confirm(`删除这条${note.type==="thought"?"附加思考":"记录"}？相关划线与评论会进入漂流箱。`))return;
    button.disabled=true;try{await request(`/api/books/${book.id}/notes/${note.id}`,{method:"DELETE"});await refreshState("books");showToast("读书记录已删除")}catch(err){showToast(err.message,"error");button.disabled=false}
  }
});
$("#keepsake-create-toggle").addEventListener("click",()=>{const workspace=$("#keepsake-workspace"),opening=workspace.hidden;if(opening){resetKeepsakeEditor();workspace.hidden=false;workspace.scrollIntoView({behavior:"smooth",block:"start"})}else resetKeepsakeEditor({close:true})});
$("#keepsake-editor-close").addEventListener("click",()=>resetKeepsakeEditor({close:true}));
$("#keepsake-cancel-edit").addEventListener("click",()=>{resetKeepsakeEditor();$("#keepsake-workspace").scrollIntoView({behavior:"smooth",block:"start"})});
$("#keepsake-image").addEventListener("change",e=>{const file=e.currentTarget.files?.[0];if(file&&!setKeepsakeFile(file))e.currentTarget.value=""});
$("#keepsake-upload-box").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("#keepsake-image").click()}});
$("#keepsake-upload-box").addEventListener("dragenter",e=>{e.preventDefault();e.currentTarget.classList.add("dragging")});
$("#keepsake-upload-box").addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="copy";e.currentTarget.classList.add("dragging")});
$("#keepsake-upload-box").addEventListener("dragleave",e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove("dragging")});
$("#keepsake-upload-box").addEventListener("drop",e=>{e.preventDefault();e.currentTarget.classList.remove("dragging");const file=[...(e.dataTransfer?.files||[])].find(item=>item.type.startsWith("image/"));if(file)setKeepsakeFile(file,"拖入图片");else $("#keepsake-segment-status").textContent="拖入的内容里没有可用图片。"});
document.addEventListener("paste",e=>{if(!$("#view-keepsakes").classList.contains("active")||(e.target instanceof Element&&e.target.closest("input,textarea,[contenteditable=true]")))return;const file=[...(e.clipboardData?.files||[])].find(item=>item.type.startsWith("image/"));if(!file)return;e.preventDefault();setKeepsakeFile(file,"剪贴板")});
$("#keepsake-auto-segment").addEventListener("click",segmentCurrentKeepsake);
$("#keepsake-brush-keep").addEventListener("click",()=>{keepsakeEditor.mode="keep";$("#keepsake-brush-keep").classList.add("active");$("#keepsake-brush-erase").classList.remove("active");$("#keepsake-brush-keep").setAttribute("aria-pressed","true");$("#keepsake-brush-erase").setAttribute("aria-pressed","false")});
$("#keepsake-brush-erase").addEventListener("click",()=>{keepsakeEditor.mode="erase";$("#keepsake-brush-erase").classList.add("active");$("#keepsake-brush-keep").classList.remove("active");$("#keepsake-brush-erase").setAttribute("aria-pressed","true");$("#keepsake-brush-keep").setAttribute("aria-pressed","false")});
$("#keepsake-brush-size").addEventListener("input",e=>{$("#keepsake-brush-output").value=e.currentTarget.value;const cursor=$("#keepsake-canvas-cursor");cursor.style.width=cursor.style.height=`${e.currentTarget.value}px`});
$("#keepsake-edge-expansion").addEventListener("input",e=>{$("#keepsake-edge-output").value=e.currentTarget.value;if(keepsakeEditor.autoBase){applyKeepsakeExpansion();$("#keepsake-segment-status").textContent="已按当前场景边缘重新生成自动轮廓；之后仍可手动修正。"}});
$("#keepsake-reset-mask").addEventListener("click",()=>{if(!keepsakeEditor.maskCanvas)return;pushKeepsakeHistory();keepsakeEditor.maskCanvas.getContext("2d").clearRect(0,0,keepsakeEditor.maskCanvas.width,keepsakeEditor.maskCanvas.height);keepsakeEditor.autoBase=null;keepsakeEditor.source="manual";scheduleKeepsakeRender();$("#keepsake-segment-status").textContent="轮廓已清空，可用“保留”笔刷重新涂抹。"});
$("#keepsake-undo").addEventListener("click",()=>{const previous=keepsakeEditor.history.pop();if(!previous||!keepsakeEditor.maskCanvas)return;keepsakeEditor.maskCanvas.getContext("2d").putImageData(previous,0,0);$("#keepsake-undo").disabled=!keepsakeEditor.history.length;scheduleKeepsakeRender()});
const keepsakePaintCanvas=$("#keepsake-mask-canvas");
keepsakePaintCanvas.addEventListener("pointerdown",e=>{if(!keepsakeEditor.maskCanvas)return;e.preventDefault();keepsakePaintCanvas.setPointerCapture(e.pointerId);pushKeepsakeHistory();keepsakeEditor.drawing=true;keepsakeEditor.lastPoint=keepsakeCanvasPoint(e);paintKeepsakeStroke(keepsakeEditor.lastPoint,keepsakeEditor.lastPoint)});
keepsakePaintCanvas.addEventListener("pointermove",e=>{const rect=keepsakePaintCanvas.getBoundingClientRect(),cursor=$("#keepsake-canvas-cursor");cursor.hidden=false;cursor.style.left=`${e.clientX-rect.left}px`;cursor.style.top=`${e.clientY-rect.top}px`;if(!keepsakeEditor.drawing)return;const next=keepsakeCanvasPoint(e);paintKeepsakeStroke(keepsakeEditor.lastPoint,next);keepsakeEditor.lastPoint=next});
const endKeepsakeStroke=e=>{keepsakeEditor.drawing=false;keepsakeEditor.lastPoint=null;if(e.pointerId!=null&&keepsakePaintCanvas.hasPointerCapture(e.pointerId))keepsakePaintCanvas.releasePointerCapture(e.pointerId)};
keepsakePaintCanvas.addEventListener("pointerup",endKeepsakeStroke);keepsakePaintCanvas.addEventListener("pointercancel",endKeepsakeStroke);keepsakePaintCanvas.addEventListener("pointerleave",()=>{$("#keepsake-canvas-cursor").hidden=true});
$("#keepsake-form").addEventListener("submit",async e=>{
  e.preventDefault();const button=$("#keepsake-save"),status=$("#keepsake-save-status"),id=$("#keepsake-id").value;if(!keepsakeEditor.sourceCanvas||!keepsakeEditor.maskCanvas)return status.textContent="请先放入一张照片。";
  const alpha=maskImageDataFromCanvas(keepsakeEditor.maskCanvas).data;let hasSubject=false;for(let index=3;index<alpha.length;index+=4)if(alpha[index]>20){hasSubject=true;break}if(!hasSubject)return status.textContent="轮廓还是空的，请自动识别或用“保留”笔刷涂出主体。";
  button.disabled=true;status.textContent="正在生成透明轮廓…";
  try{
    const cutoutDataUrl=keepsakeCutoutCanvas().toDataURL("image/png"),upload=async image=>(await request("/api/images/upload",{method:"POST",body:JSON.stringify({image})})).attachmentPath;
    let originalPath=keepsakeEditor.originalPath;if(!originalPath||keepsakeEditor.file){status.textContent="正在保存原图…";originalPath=await upload(keepsakeEditor.sourceDataUrl)}
    status.textContent="正在保存透明轮廓…";const cutoutPath=await upload(cutoutDataUrl);
    const payload={occurredAt:$("#keepsake-datetime").value,title:$("#keepsake-title").value,category:$("#keepsake-category").value,note:$("#keepsake-note").value,tags:splitTags($("#keepsake-tags").value),originalPath,cutoutPath,source:keepsakeEditor.source,edgeExpansion:Number($("#keepsake-edge-expansion").value)};
    await request(id?`/api/keepsakes/${id}`:"/api/keepsakes",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetKeepsakeEditor({close:true});await refreshState(["keepsakes","review"]);window.scrollTo({top:0,behavior:"auto"});showToast(id?"小物留存已更新":"小物已数字留存");
  }catch(error){status.textContent=error.message}finally{button.disabled=false}
});
document.addEventListener("click",async e=>{
  const back=e.target.closest("[data-keepsake-back]"),view=e.target.closest("[data-keepsake-view]"),edit=e.target.closest("[data-keepsake-edit]"),remove=e.target.closest("[data-keepsake-delete]"),open=e.target.closest("[data-keepsake-open]");
  if(back){activeKeepsakeId="";activeKeepsakeView="presentation";renderKeepsakes();window.scrollTo({top:0,behavior:"smooth"});return}
  if(view){setKeepsakeDetailView(view.dataset.keepsakeView);return}
  if(edit){editKeepsake(edit.dataset.keepsakeEdit);return}
  if(remove){if(!confirm("删除这件小物的留存记录？原图与轮廓将不再显示。"))return;remove.disabled=true;try{await request(`/api/keepsakes/${remove.dataset.keepsakeDelete}`,{method:"DELETE"});await refreshState(["keepsakes","review"]);showToast("小物留存已删除")}catch(error){showToast(error.message,"error");remove.disabled=false}return}
  if(open)openKeepsakeDetail(open.dataset.keepsakeOpen);
});
$("#quote-refresh").addEventListener("click",()=>renderQuoteSky(true));
$("#quote-cancel").addEventListener("click",resetQuoteForm);
$("#quote-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,id=$("#quote-id").value,button=$("#quote-submit"),status=$("#quote-status"),payload={occurredAt:$("#quote-datetime").value,source:$("#quote-source").value,content:$("#quote-content").value,tags:splitTags($("#quote-tags").value)};button.disabled=true;status.textContent=id?"正在保存修改…":"正在收藏…";try{await request(id?`/api/quotes/${id}`:"/api/quotes",{method:id?"PATCH":"POST",body:JSON.stringify(payload)});resetQuoteForm();await refreshState("quotes");showToast(id?"善言已更新":"善言已收藏")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
document.addEventListener("click",async e=>{const edit=e.target.closest("[data-quote-edit]"),remove=e.target.closest("[data-quote-delete]");if(edit)return editQuote(edit.dataset.quoteEdit);if(!remove)return;if(!confirm("删除这条善言？相关划线与评论也会删除。"))return;remove.disabled=true;try{await request(`/api/quotes/${remove.dataset.quoteDelete}`,{method:"DELETE"});if($("#quote-id").value===remove.dataset.quoteDelete)resetQuoteForm();await refreshState("quotes");showToast("善言已删除")}catch(err){showToast(err.message,"error");remove.disabled=false}});
$("#selection-quote-close").addEventListener("click",closeSelectionQuoteModal);
$("#selection-quote-modal").addEventListener("click",e=>{if(e.target===e.currentTarget)closeSelectionQuoteModal()});
$("#selection-quote-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),status=$("#selection-quote-status"),payload={occurredAt:$("#selection-quote-datetime").value,source:$("#selection-quote-source").value,content:$("#selection-quote-content").value,tags:splitTags($("#selection-quote-tags").value)};button.disabled=true;status.textContent="正在收藏…";try{await request("/api/quotes",{method:"POST",body:JSON.stringify(payload)});closeSelectionQuoteModal();await refreshState("quotes");showToast("选中文字已收为善言")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
setStatisticsRange(7);
$$("[data-statistics-days]").forEach(button=>button.addEventListener("click",()=>{setStatisticsRange(Number(button.dataset.statisticsDays));void loadStatistics()}));
$("#statistics-range-form").addEventListener("submit",event=>{event.preventDefault();$$("[data-statistics-days]").forEach(button=>button.classList.remove("active"));void loadStatistics()});
$("#llm-settings-form").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type="submit"]'),status=$("#llm-settings-status");button.disabled=true;status.textContent="正在保存…";try{llmSettings=await request("/api/settings",{method:"POST",body:JSON.stringify(settingsPayload())});$("#llm-api-key").value="";renderSettings();status.textContent="四档配置与各场景选择已保存。";showToast("DeepSeek 设置已保存")}catch(err){status.textContent=err.message}finally{button.disabled=false}});
$("#test-llm").addEventListener("click",async e=>{const button=e.currentTarget,status=$("#llm-settings-status"),tier=$("#llm-test-tier").value;button.disabled=true;status.textContent=`正在保存并测试 ${tier[0].toUpperCase()+tier.slice(1)}…`;try{llmSettings=await request("/api/settings",{method:"POST",body:JSON.stringify(settingsPayload())});$("#llm-api-key").value="";renderSettings();const result=await request("/api/settings/test",{method:"POST",body:JSON.stringify({tier})}),profile=llmSettings.profiles[tier];status.textContent=`连接成功 · ${profile.model==="deepseek-v4-pro"?"DeepSeek Pro":"DeepSeek Flash"} · ${profile.effort==="none"?"思考关闭":`思考 ${profile.effort.toUpperCase()}`}`;showToast(result.reply||"DeepSeek 连接成功")}catch(err){status.textContent=`连接失败：${err.message}`}finally{button.disabled=false}});
function syncLocalDate(){const next=localDateKey();if(next===currentLocalDate)return;const followedToday=activeDate===currentLocalDate;currentLocalDate=next;if(followedToday){activeDate=next;renderDate();renderSliders();renderThoughts();renderStateChart();renderChat()}}
setInterval(syncLocalDate,30000);document.addEventListener("visibilitychange",()=>{if(!document.hidden)syncLocalDate()});
$$("[data-auth-tab]").forEach(button=>button.addEventListener("click",()=>setAuthTab(button.dataset.authTab)));
for(const [formId,endpoint]of[["login-form","/api/auth/login"],["register-form","/api/auth/register"]]){
  $(`#${formId}`).addEventListener("submit",async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#auth-status");button.disabled=true;status.textContent=formId==="login-form"?"正在登录…":"正在创建账户…";
    try{const fields=new FormData(form),result=await authRequest(endpoint,Object.fromEntries(fields));form.reset();unlockForUser(result.user,true);await load()}
    catch(error){status.textContent=error.message}
    finally{button.disabled=false}
  });
}
const logout=async()=>{try{await authRequest("/api/auth/logout",{})}finally{showAuthGate();setAuthTab("login")}};
$("#username-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#username-status");button.disabled=true;status.textContent="正在修改…";
  try{const result=await authRequest("/api/auth/username",{username:form.elements.username.value},"PATCH");currentUser=result.user;renderAccountIdentity();status.textContent="用户名已更新。";showToast("用户名已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#password-form").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]'),status=$("#password-status"),currentPassword=form.elements.currentPassword.value,newPassword=form.elements.newPassword.value,confirmPassword=form.elements.confirmPassword.value;
  form.elements.confirmPassword.setCustomValidity(newPassword===confirmPassword?"":"两次输入的新密码不一致");
  if(!form.reportValidity())return;
  button.disabled=true;status.textContent="正在修改…";
  try{await authRequest("/api/auth/password",{currentPassword,newPassword},"PATCH");form.reset();status.textContent="密码已更新，其他设备上的登录已退出。";showToast("密码已更新")}
  catch(error){status.textContent=error.message}
  finally{button.disabled=false}
});
$("#password-form [name='confirmPassword']").addEventListener("input",event=>event.currentTarget.setCustomValidity(""));
$("#logout-button").addEventListener("click",logout);$("#logout-button-account").addEventListener("click",logout);
bootstrap().catch(error=>{showAuthGate();$("#auth-status").textContent=error.message});
