import { chatAnswerMarkup } from "../../features/chats/index.mjs";

export function createHomeChatRenderer({
  getState,
  runtime,
  eventDate,
  $,
  renderMarkdown,
  contextReceiptMarkup,
  contentState,
  commentRootKey,
  markCommentTarget,
  renderLatex,
  applyCommentAnchors
} = {}) {
  function renderChat() {
    const state = getState();
    const chats = state.chats.filter(item => eventDate(item) === runtime.activeDate);
    const history = $("#chat-history");
    history.innerHTML = chats.length
      ? [...chats].reverse().map(item =>
        `<div class="chat-message user" data-chat-id="${item.id}" data-chat-part="message"><div class="markdown-content">${renderMarkdown(item.message)}</div></div>`
          + `<div class="chat-message agent" data-chat-id="${item.id}" data-chat-part="answer">${contextReceiptMarkup(item.contextReceipt, item.citations, item.citationStatus, item.providedReferences)}${chatAnswerMarkup(item, renderMarkdown)}<button class="subtle-action danger chat-delete" type="button" data-chat-delete="${item.id}">删除对话</button></div>`
      ).join("")
      : contentState({
        title: "这一天还没有对话",
        body: "发送问题后，共参会结合你已保存的记录回答。",
        action: { focus: "chat-input", label: "开始提问" }
      });

    chats.forEach(item => {
      const rootKey = commentRootKey("chat", item.id);
      markCommentTarget(
        $(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="message"]>.markdown-content`),
        rootKey,
        "message"
      );
      markCommentTarget(
        $(`[data-chat-id="${CSS.escape(item.id)}"][data-chat-part="answer"]>.markdown-content`),
        rootKey,
        "answer"
      );
    });
    renderLatex(history);
    applyCommentAnchors(history);
  }

  return renderChat;
}
