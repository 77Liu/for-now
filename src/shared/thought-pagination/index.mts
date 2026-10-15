/**
 * 思绪分页两端共用的容量和输入边界。
 * 建立时间：2026-10-16
 * 状态：active
 * 边界：窗口容量不是历史总量上限；两端使用同一编译产物。
 */
/** 思绪分页公开参数；修改时必须同时验证领域、HTTP及客户端窗口。 @since unreleased */
export const THOUGHT_PAGING = Object.freeze({ pageSize: 20, maxPages: 5, maxCursorDecodedLength: 256, maxCheckpoints: 10, questionPreviewLimit: 600, userPreviewLimit: 400 });
