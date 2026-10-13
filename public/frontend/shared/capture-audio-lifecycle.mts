/**
 * 念起原音与念起、思绪缓存朗读播放器的保留、失败恢复及会话清理。
 * 建立时间：2026-10-13
 * 状态：active
 * 边界：只在同账户、同登录会话、同页面激活和同资源内复用；朗读重试只探测并读取既有缓存。
 */
type CaptureAudioScope = {
  accountId: string;
  sessionId: number | string;
  pageToken: object;
};

type PlayerEntry = {
  player: HTMLAudioElement;
  key: string;
  src: string;
  scope: CaptureAudioScope;
};

type HeadResponse = { ok: boolean; status: number };
type CaptureAudioLifecycleOptions = {
  headStatus: (url: string) => Promise<HeadResponse>;
};

function sameScope(left: CaptureAudioScope | null, right: CaptureAudioScope): boolean {
  return Boolean(left
    && left.accountId === right.accountId
    && left.sessionId === right.sessionId
    && left.pageToken === right.pageToken);
}

function playerKey(player: HTMLAudioElement): string {
  const captureId = player.closest<HTMLElement>("[data-capture-id]")?.dataset.captureId;
  const original = player.closest<HTMLElement>(".capture-audio-source");
  if (captureId && original) return `${captureId}:original:${original.dataset.captureAudioKey || ""}`;
  const speech = player.closest(".capture-speech-player");
  if (captureId && speech) return `${captureId}:speech:${player.dataset.speechPlayer || ""}`;
  const source = player.closest<HTMLElement>(".speech-asset-controls");
  const type = source?.dataset.speechSourceType;
  const id = source?.dataset.speechSourceId;
  return speech && ["thoughtChain", "thoughtAnswer"].includes(type || "") && id
    ? `thought:${type}:${id}:${player.dataset.speechPlayer || ""}` : "";
}

function statusTarget(player: HTMLAudioElement): { status: HTMLElement | null; retry: HTMLButtonElement | null } {
  const original = player.closest<HTMLElement>(".capture-audio-source");
  if (original) return {
    status: original.querySelector<HTMLElement>("[data-capture-audio-status]"),
    retry: original.querySelector<HTMLButtonElement>("[data-capture-audio-retry]")
  };
  const speech = player.closest<HTMLElement>(".capture-speech-player");
  return {
    status: speech?.closest<HTMLElement>(".speech-asset-controls")
      ?.querySelector<HTMLElement>(".speech-asset-status") || null,
    retry: speech?.querySelector<HTMLButtonElement>("[data-capture-speech-retry]") || null
  };
}

function release(player: HTMLAudioElement): void {
  try { player.pause(); } catch {}
  try { player.removeAttribute("src"); } catch {}
  try { player.load(); } catch {}
}

function isSpeechPlayer(player: HTMLAudioElement): boolean {
  return Boolean(player.closest(".capture-speech-player"));
}

/** 创建页面会话内的播放器生命周期管理器。 @since v0.5.14 */
export function createCaptureAudioLifecycle({ headStatus }: CaptureAudioLifecycleOptions) {
  if (typeof headStatus !== "function") {
    throw new TypeError("Capture audio lifecycle requires a headStatus port");
  }
  let activeScope: CaptureAudioScope | null = null;
  let retained = new Map<string, PlayerEntry>();
  let observed = new WeakSet<HTMLAudioElement>();
  let failed = new WeakSet<HTMLAudioElement>();
  let failureMessages = new WeakMap<HTMLAudioElement, string>();
  let scopes = new WeakMap<HTMLAudioElement, CaptureAudioScope>();

  const current = (scope: CaptureAudioScope) => sameScope(activeScope, scope);
  const show = (player: HTMLAudioElement, message: string, failedRead: boolean) => {
    const target = statusTarget(player);
    if (target.status) target.status.textContent = message;
    if (target.retry) {
      target.retry.hidden = !failedRead;
      target.retry.disabled = false;
    }
  };
  const showFailure = (player: HTMLAudioElement, message: string) => {
    failed.add(player);
    failureMessages.set(player, message);
    show(player, message, true);
  };
  const onReady = (event: Event) => {
    const player = event.currentTarget as HTMLAudioElement;
    failed.delete(player);
    failureMessages.delete(player);
    if (isSpeechPlayer(player)) show(player, "朗读可播放", false);
    else show(player, "原音可播放", false);
  };
  const onError = (event: Event) => {
    const player = event.currentTarget as HTMLAudioElement;
    const scope = scopes.get(player);
    if (!isSpeechPlayer(player)) {
      showFailure(player, "原音读取失败，原件仍保留。");
      return;
    }
    showFailure(player, "已生成的朗读读取失败；可重试读取，不会重新合成。");
    if (!scope) return;
    void headStatus(player.src).then(response => {
      if (!current(scope) || !player.isConnected || !failed.has(player)) return;
      if (response.status === 401 || response.status === 403) {
        showFailure(player, "登录状态已失效，请重新登录后读取朗读缓存。");
      } else if (response.status === 404 || response.status === 410) {
        showFailure(player, "这条朗读缓存已失效；重新生成可创建新音频。");
      } else if (response.ok) {
        showFailure(player, "朗读缓存仍有效，读取暂时失败；可重试读取。");
      } else {
        showFailure(player, "朗读缓存暂时不可读取；可稍后重试读取。");
      }
    }).catch(() => {
      if (current(scope) && player.isConnected && failed.has(player)) {
        showFailure(player, "朗读读取遇到网络问题；可重试读取。");
      }
    });
  };
  const observe = (player: HTMLAudioElement, scope: CaptureAudioScope) => {
    scopes.set(player, scope);
    if (observed.has(player)) return;
    player.addEventListener("error", onError);
    player.addEventListener("canplay", onReady);
    player.addEventListener("playing", onReady);
    observed.add(player);
  };
  const dispose = (root?: ParentNode) => {
    const players = new Set([...retained.values()].map(entry => entry.player));
    root?.querySelectorAll<HTMLAudioElement>(".capture-audio-source audio, .capture-speech-player audio")
      .forEach(player => players.add(player));
    players.forEach(release);
    retained.clear();
    activeScope = null;
    observed = new WeakSet();
    failed = new WeakSet();
    failureMessages = new WeakMap();
    scopes = new WeakMap();
  };

  return Object.freeze({
    /** 为一次列表替换暂存当前页面、账户和资源的播放器节点。 @since v0.5.14 */
    beforeRender(root: ParentNode, scope: CaptureAudioScope): void {
      if (activeScope && !sameScope(activeScope, scope)) dispose(root);
      activeScope = scope;
      retained = new Map();
      root.querySelectorAll<HTMLAudioElement>(".capture-audio-source audio, .capture-speech-player audio")
        .forEach(player => {
          const key = playerKey(player);
          if (key) retained.set(key, { player, key, src: player.getAttribute("src") || "", scope });
        });
    },

    /** 在新 DOM 上恢复同资源播放器并绑定指向当前状态节点的监听器。 @since v0.5.14 */
    afterRender(root: ParentNode, scope: CaptureAudioScope): void {
      if (!current(scope)) return;
      const used = new Set<HTMLAudioElement>();
      root.querySelectorAll<HTMLAudioElement>(".capture-audio-source audio, .capture-speech-player audio")
        .forEach(next => {
          const key = playerKey(next);
          const entry = retained.get(key);
          const nextSrc = next.getAttribute("src") || "";
          const player = entry && sameScope(entry.scope, scope) && entry.src === nextSrc
            ? entry.player
            : next;
          if (player !== next) next.replaceWith(player);
          if (entry && player === entry.player) used.add(player);
          observe(player, scope);
          const rate = player.closest(".speech-asset-controls")
            ?.querySelector<HTMLSelectElement>("[data-speech-playback-rate]");
          if (rate) rate.value = String(player.playbackRate);
          if (failed.has(player)) {
            const message = failureMessages.get(player);
            if (message) show(player, message, true);
          } else if (player.error) {
            onError({ currentTarget: player } as unknown as Event);
          }
        });
      for (const entry of retained.values()) {
        if (!used.has(entry.player)) release(entry.player);
      }
      retained.clear();
    },

    /** 对原音或已有朗读缓存执行只读重试，不会上传或合成音频。 @since v0.5.14 */
    async retry(button: HTMLButtonElement): Promise<boolean> {
      const player = button.closest(".capture-audio-source, .capture-speech-player")
        ?.querySelector("audio");
      const scope = player ? scopes.get(player) : undefined;
      if (!player || !scope || !current(scope)) return false;
      const target = statusTarget(player);
      if (isSpeechPlayer(player)) {
        if (target.status) target.status.textContent = "正在检查并读取已有朗读缓存…";
        const statusRequest = headStatus(player.src);
        try {
          player.load();
          const playback = player.play();
          if (playback && typeof playback.catch === "function") {
            void playback.catch(() => {
              if (current(scope) && player.isConnected && failed.has(player)) {
                showFailure(player, "朗读未能开始播放；缓存仍保留，可重试读取。");
              }
            });
          }
          if (target.retry) target.retry.disabled = false;
        } catch {
          showFailure(player, "朗读未能开始播放；缓存仍保留，可重试读取。");
        }
        try {
          const response = await statusRequest;
          if (!current(scope) || !player.isConnected) return false;
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              showFailure(player, "登录状态已失效，请重新登录后读取朗读缓存。");
            } else if (response.status === 404 || response.status === 410) {
              showFailure(player, "这条朗读缓存已失效；重新生成可创建新音频。");
            } else {
              showFailure(player, "朗读缓存暂时不可读取；可稍后重试读取。");
            }
            return false;
          }
        } catch {
          if (current(scope) && player.isConnected) {
            showFailure(player, "朗读读取遇到网络问题；可重试读取。");
          }
          return false;
        }
        if (!current(scope) || !player.isConnected) return false;
        // canplay/playing 可能先于 HEAD 返回，不覆盖已确认的就绪状态。
        if (target.status && failed.has(player)) target.status.textContent = "正在重新读取已生成的朗读…";
        return true;
      } else if (target.status) {
        target.status.textContent = "正在重试读取，原始录音仍保留。";
      }
      try {
        player.load();
        const playback = player.play();
        if (playback && typeof playback.catch === "function") {
          void playback.catch(() => {
            if (current(scope) && player.isConnected && failed.has(player)) {
              showFailure(player, "原音未能开始播放；原件仍保留，可以重试读取。");
            }
          });
        }
        if (target.retry) target.retry.disabled = false;
        return true;
      } catch {
        showFailure(player, isSpeechPlayer(player)
          ? "朗读读取失败；缓存仍保留，可以重试读取。"
          : "原音读取失败，原件仍保留。");
        return false;
      }
    },

    /** 结束页面或登录会话并释放所有保留播放器与旧状态归属。 @since v0.5.14 */
    dispose
  });
}
